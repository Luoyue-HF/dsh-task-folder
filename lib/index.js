import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  MARKER,
  UNNAMED,
  createTaskDir,
  ensureDir,
  findTaskDir,
  isTaskDir,
  listTaskDirs,
  parseTaskDirName,
  renameTaskDir,
  sanitizeName,
} from './folders.js';

export const name = 'dsh-task-folder';

/** 主干是 task_folder 工具；workingDirectory 走运行时探测（无该服务的 profile 不该把插件挂死）。 */
export const inject = ['tools'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('为每个根会话分配专属产物文件夹'),
  subdir: Schema.string()
    .default('')
    .description(
      '任务目录的上级目录名；留空（默认）= 任务目录直接建在工作区根下，一个任务一个文件夹。设为「产物」则集中到 <工作区>/产物/ 下',
    ),
  rootMode: Schema.union(['workspace', 'custom'])
    .default('workspace')
    .description('workspace=产物根目录在当前工作区内；custom=用 rootPath'),
  rootPath: Schema.string()
    .default('')
    .description('rootMode=custom 时的绝对路径；留空回退 ~/Documents/DSH-产物'),
  autoTitle: Schema.boolean().default(true).description('消息文本拿不到名字时，改用会话标题命名'),
  maxNameChars: Schema.number().default(24).description('任务名（不含日期与序号）最大字符数'),
  autoReuse: Schema.boolean()
    .default(true)
    .description('首条消息唯一提到某个已有任务名时自动切过去，实现「换会话续做同一任务」落在同一目录'),
  reclaimEmpty: Schema.boolean()
    .default(true)
    .description('会话结束（agent 销毁）时，分配的产物目录若还是空的就删除，避免留下一堆空文件夹'),
  adoptOldSessions: Schema.boolean()
    .default(true)
    .description(
      '是否也把「插件激活之前就已创建、但仍在使用的会话」收编进任务目录。默认 true；设为 false 则老会话保持原工作目录不动',
    ),
});

/** 会话 id -> Agent（后续改名/复用要调 workingDirectory.set）。 */
const agents = new Map();
/** 会话 id -> 已分配的产物目录。 */
const assigned = new Map();
/** 建/切目录失败过的会话，避免每一步反复重试刷日志。 */
const failed = new Set();
/** 已被标题校正过名字的会话，避免每次 assistant 消息都重算。 */
const titleApplied = new Set();
/** 标题尝试的起始时刻与次数：改成时间窗口，避免开头几条消息就把次数耗光。 */
const titleFirstTry = new Map();
const titleTries = new Map();
/** 用户手动 rename 过的会话：不再被自动标题覆盖。 */
const userNamed = new Set();
/**
 * 跟随主会话目录的派生会话（子代理/teammate）。
 * 它们共用父会话的任务目录，所以销毁时**不能**回收那个目录。
 */
const followers = new Set();

/**
 * 标题校正的时间窗口（毫秒）。
 * 早先按「次数」限制（5 次），但 session/event 是每条 assistant 消息都触发一次，
 * 会话开头几条消息来得很快，标题还没折叠出来就把 5 次用完了，之后永久放弃命名。
 * 现在给足时间，只要窗口内标题一出来就能用上。
 */
const TITLE_WINDOW_MS = 90_000;

/**
 * 工作目录切换时 Host 会往会话里注入一条用户消息通知，形如
 * `The working directory changed from "…" to "…"`。
 * 它必须被排除在「用户想做什么」之外，否则会把自己切换目录的通知
 * 当成任务名，生成一堆叫「The working directory ch」的目录。
 */
const WD_NOTICE_RE = /^The working directory (?:changed|is now|for this session)[\s\S]*$/i;

/** 从 Message 的 content blocks 取纯文本，过滤掉系统注入的目录通知。 */
function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  const blocks = Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (!text || WD_NOTICE_RE.test(text)) continue;
    parts.push(text);
  }
  return parts.join('\n').trim();
}

/** 开头常见的语气词/客套话，取名时先剥掉，避免「帮我做一个…」变成任务名。 */
const LEAD_NOISE_RE =
  /^(?:请|麻烦|帮我|帮忙|能不能|可以|我想|我要|我需要|继续|接着|好的|好|嗯|那么|现在|然后|另外|顺便|另外就是)+[\s,，、:：]*/;

/**
 * 英文同类的客套开头。
 * 早先只有中文正则，`please help me make a quarterly report` 会整句进目录名，
 * 最后被 24 字上限硬截断成半句，非常难认。
 */
const LEAD_NOISE_EN_RE =
  /^(?:please|pls|can you|could you|would you|will you|i want to|i need to|i'd like to|i would like to|help me|let's|lets|go ahead and)\s+/i;

/** 句末标点后常跟的英文小结，剥掉后名字更像任务名。 */
const TRAILING_NOISE_EN_RE = /\s+(?:please|thanks|thank you)$/i;

/** 句子切分：优先在句末标点处切，避免把整段需求塞进目录名。 */
const SENTENCE_END_RE = /[。！？!?；;\n]/;
/** 次级切分点：第一句仍然过长时，退到逗号/顿号处再切一次。 */
const CLAUSE_END_RE = /[，,、：:]/;

/** 开头「做/写/画 + 量词」这类空动作，剥掉后名字更像任务名。 */
const LEAD_VERB_RE =
  /^(?:做|写|画|整|搞|生成|创建|制作|设计|弄)(?:一个|一款|一份|一张|一篇|一套|个|款|份|张|篇|套)/;

/** 英文同类：`make a`、`create a`、`write a` 等。 */
const LEAD_VERB_EN_RE = /^(?:make|create|write|build|generate|design|draw|produce)\s+(?:a|an|the)\s+/i;

/**
 * 无意义的占位标题：标题服务在会话刚开始时会给出这类默认值，
 * 拿它命名等于把目录叫成「新会话」，必须跳过。
 */
const PLACEHOLDER_TITLE_RE = /^(?:新会话|新对话|未命名|无标题|new chat|new session|untitled|chat|conversation)[\s\d_-]*$/i;

/**
 * 从一段用户文本里提炼一个像任务名的短语。
 * 只取第一句，剥掉开头语气词与结尾的标点/语气词，再截断。
 * 这不是语义理解，够用就好——真正准确的名字来自会话标题。
 */
function nameFromText(text, maxLength) {
  if (typeof text !== 'string') return '';
  let s = text.trim();
  if (!s) return '';
  // 只保留第一段第一句
  s = s.split('\n')[0].trim();
  const cut = s.search(SENTENCE_END_RE);
  if (cut > 0) s = s.slice(0, cut);
  // 目录名里不该带逗号：无条件退到第一个逗号处，宁可短一点也不留半句。
  const clause = s.search(CLAUSE_END_RE);
  if (clause > 2) s = s.slice(0, clause);
  let prev;
  do {
    prev = s;
    s = s
      .replace(LEAD_NOISE_RE, '')
      .replace(LEAD_NOISE_EN_RE, '')
      .replace(LEAD_VERB_RE, '')
      .replace(LEAD_VERB_EN_RE, '');
  } while (s !== prev && s);
  s = s.replace(TRAILING_NOISE_EN_RE, '');
  s = s.replace(/[。！？!?；;，,、：:~～\s]+$/g, '').trim();
  return sanitizeName(s, maxLength);
}

/**
 * 只服务根会话：子代理/派生会话**不另开目录**。
 *
 * 宿主在子代理会话 header 里写 `origin: 'subagent'`、`parentSession` 和非 0 的
 * `delegationDepth`（见 dsh-subagent 的 childSessionMeta）。用这三个字段一起判断，
 * 任一命中即视为派生会话。
 */
function isRootSession(header) {
  if (!header) return true;
  if (header.origin === 'subagent') return false;
  if (header.parentSession) return false;
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false;
  return true;
}

/**
 * 会话此刻生效的目录：优先读 working-directory 投影（含 working-directory/change 累积），
 * 最后才退回 header.cwd。header.cwd 只是「创建时」的目录，resume 后不会更新，
 * 拿它判断必然重复分配目录——那正是一个会话生成一堆文件夹的原因。
 */
function currentDir(wd, session) {
  try {
    const cur = wd.get(session);
    if (typeof cur === 'string' && cur) return cur;
  } catch {
    /* 投影不可用时退回 header */
  }
  const h = session?.header?.cwd;
  return typeof h === 'string' ? h : '';
}

/** 原始工作区（产物根的基准），不随产物目录切换而变。 */
function originalCwd(wd, session) {
  const h = session?.header?.cwd;
  if (typeof h === 'string' && h && isAbsolute(h)) return h;
  const d = wd?.defaultDirectory;
  return typeof d === 'string' ? d : '';
}

/**
 * 产物根目录。
 *
 * 返回 `{ root, requireMarker }`：
 * - root 为空表示无法确定工作区。
 * - requireMarker 表示「任务目录直接散在工作区根下」（subdir 为空），
 *   此时扫描必须只认带 `.dsh-task-folder` 标记的目录，
 *   否则用户自己建的 `10-26_清单` 之类会被误判成本插件的任务目录。
 *   若产物集中在专用子目录（如 `产物/`）里，那个目录本来就是插件独占的，
 *   不需要额外标记过滤。
 */
function resolveRoot(config, wd, session) {
  if (config.rootMode === 'custom') {
    const p = String(config.rootPath ?? '').trim();
    return { root: p ? resolve(p) : join(homedir(), 'Documents', 'DSH-产物'), requireMarker: false };
  }
  const base = originalCwd(wd, session);
  if (!base) return { root: '', requireMarker: false };
  const sub = String(config.subdir ?? '').trim();
  return sub
    ? { root: join(base, sub), requireMarker: false }
    : { root: base, requireMarker: true };
}

/**
 * 目录是否为空。
 * 标记文件 `.dsh-task-folder` 不算内容：它是本插件自己写的，
 * 若把它算进来，任务目录将永远「非空」，空目录回收就失效了。
 */
function isEmptyDir(path) {
  try {
    return readdirSync(path).filter((n) => n !== MARKER).length === 0;
  } catch {
    return false;
  }
}

/**
 * 清掉一个「本插件刚建的空目录」。
 * `reuse` 与 `new` 原本只有前者做这件事，连续 new 会留下一串空目录。
 */
function reclaimEmptyDir(dir, config, log) {
  if (!config.reclaimEmpty) return false;
  if (!isTaskDir(dir) || !isEmptyDir(dir)) return false;
  try {
    rmdirSync(dir);
    log(`已清理空产物目录 ${dir}`);
    return true;
  } catch {
    /* 删不掉就留着 */
    return false;
  }
}

/**
 * 在 root 下按「消息里提到的任务名」找已有目录。
 * 只接受唯一命中且名字 >= 3 字符，避免「报告」这类泛词误判。
 */
function findTaskDirByMention(root, text, selfDir, requireMarker) {
  if (!text) return undefined;
  const dirs = listTaskDirs(root, { requireMarker }).filter(
    (d) => d.path !== selfDir && d.name && d.name !== UNNAMED,
  );
  if (!dirs.length) return undefined;
  const textLower = text.toLowerCase();
  const hits = dirs.filter((d) => d.name.length >= 3 && textLower.includes(d.name.toLowerCase()));
  return hits.length === 1 ? hits[0] : undefined;
}

export function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger.info('dsh-task-folder: 配置中已关闭');
    return;
  }

  const maxChars = Math.max(4, Number(config.maxNameChars) || 24);
  // 插件激活时刻：早于它创建的会话是「旧会话」，保持原目录、交给手动整理。
  const activatedAt = Date.now();
  const log = (msg) => ctx.logger.info(`dsh-task-folder: ${msg}`);
  const warn = (msg) => ctx.logger.warn(`dsh-task-folder: ${msg}`);
  // 同一句告警只打一次：resolveRoot 在每一步都会被调用，否则日志会被刷屏。
  const warnedOnce = new Set();
  const warnOnce = (msg) => {
    if (warnedOnce.has(msg)) return;
    warnedOnce.add(msg);
    warn(msg);
  };

  ctx.inject(['workingDirectory'], (wdCtx) => {
    const wd = wdCtx.workingDirectory;

    /** 切换会话工作目录；失败只告警。 */
    const moveTo = async (agent, dir) => {
      try {
        return await wd.set(agent, dir);
      } catch (err) {
        warn(`切换目录失败 ${dir}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    };

    /**
     * 懒分配：只有真正要跑一步（pre-step）时才建目录并切过去。
     * 打开会话、浏览历史、改标题都不会产生空文件夹。
     */
    const ensureFolder = async (agent, session, firstText) => {
      const id = session.id;

      // 子代理/派生会话：不另开目录，直接跟随主会话的任务目录，
      // 产物与主会话放在一起，避免一轮任务散出一堆空文件夹。
      if (!isRootSession(session.header)) {
        const parent = session.header?.parentSession;
        if (!parent) {
          assigned.set(id, currentDir(wd, session));
          return;
        }
        const target = assigned.get(parent);
        if (!target) {
          // 主会话还没分配（极罕见：父会话本步尚未 pre-step）。不建目录，等下一轮。
          return;
        }
        if (currentDir(wd, session) !== target) {
          const moved = await moveTo(agent, target);
          if (!moved) failed.add(id);
          else log(`子代理 ${id} 跟随主会话目录 ${moved}`);
        }
        followers.add(id);
        assigned.set(id, target);
        return;
      }

      if (assigned.has(id) || failed.has(id)) return;

      const cur = currentDir(wd, session);

      // 1) 已在任务目录里（之前切过 / 手动 reuse 过）：沿用，绝不重复建。
      if (isTaskDir(cur)) {
        assigned.set(id, cur);
        return;
      }

      // 2) 是否收编升级前创建的老会话。
      //    默认收编：否则插件装好后，正在用的那个会话会一直被判为「旧会话」，
      //    产物永远散在工作区根下——看起来就像插件完全没生效。
      //    想保持历史会话原样不动，就把 adoptOldSessions 设为 false。
      if (!config.adoptOldSessions && (session.header?.createdAt ?? 0) < activatedAt) {
        assigned.set(id, cur);
        return;
      }

      const { root, requireMarker } = resolveRoot(config, wd, session);
      if (!root) {
        failed.add(id);
        warn(`无法确定会话 ${id} 的产物根目录，跳过`);
        return;
      }

      try {
        ensureDir(root);

        // 3) 自动复用：首条消息唯一提到某个已有任务名，就落回那个目录。
        if (config.autoReuse && firstText) {
          const hit = findTaskDirByMention(root, firstText, cur, requireMarker);
          if (hit) {
            const moved = await moveTo(agent, hit.path);
            if (moved) {
              assigned.set(id, moved);
              log(`复用已有任务目录 ${moved}`);
              return;
            }
          }
        }

        // 4) 新建，并给个名字；改名在建好后、切目录前一次完成，只 set 一次。
        let dir = createTaskDir(root);
        const guessed = nameFromText(firstText, maxChars);
        if (guessed) {
          const res = renameTaskDir(dir, guessed, maxChars);
          dir = res.path;
          if (res.error) warn(`任务目录改名失败（保留原名）：${res.error}`);
        }
        const canonical = await moveTo(agent, dir);
        if (!canonical) {
          failed.add(id);
          return;
        }
        assigned.set(id, canonical);
        log(`会话 ${id} -> ${canonical}`);
      } catch (err) {
        failed.add(id);
        warn(`创建产物目录失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    /**
     * 用会话标题校正任务名。
     *
     * 首条消息猜出来的名字经常是半句话（「帮我把上个月的销售数据整理成一个表格」），
     * 而会话标题是模型总结过的短标题，质量明显更高。所以策略是：
     * 标题一可用就覆盖猜测名，每个会话只做一次；
     * 但只要用户手动 rename 过，就再也不覆盖。
     */
    const applyTitle = async (session, agent) => {
      if (!config.autoTitle) return;
      const id = session.id;
      // 派生会话共用父会话的目录：不能拿子代理的标题去改父目录的名字。
      if (followers.has(id)) return;
      if (userNamed.has(id) || titleApplied.has(id)) return;

      // 时间窗口限制而不是次数限制：见 TITLE_WINDOW_MS 的说明。
      const first = titleFirstTry.get(id);
      if (first === undefined) {
        titleFirstTry.set(id, Date.now());
      } else if (Date.now() - first > TITLE_WINDOW_MS) {
        return;
      }
      titleTries.set(id, (titleTries.get(id) ?? 0) + 1);

      const dir = assigned.get(id);
      if (!dir) return;
      // 目录被外部删掉/移走后不再能改名，直接结束尝试。
      if (!existsSync(dir)) return;
      const parsed = parseTaskDirName(basename(dir));
      if (!parsed) return;
      let title = '';
      try {
        const service = wdCtx.get('sessionTitle');
        const snapshot = service?.get?.(session);
        title = typeof snapshot?.title === 'string' ? snapshot.title : '';
        // 拿不到就主动刷一次（标题是异步折叠出来的）。
        if (!title && service?.refresh) {
          const fresh = await service.refresh(session);
          title = typeof fresh?.title === 'string' ? fresh.title : '';
        }
      } catch {
        /* 标题服务不可用就维持原名 */
      }
      const cleaned = sanitizeName(title, maxChars);
      if (!cleaned || PLACEHOLDER_TITLE_RE.test(cleaned)) return;
      titleApplied.add(id);
      if (cleaned === parsed.name) return;
      const res = renameTaskDir(dir, cleaned, maxChars);
      if (res.error) {
        warn(`按标题改名失败（保留原名 ${basename(dir)}）：${res.error}`);
        return;
      }
      if (!res.renamed || res.path === dir) return;
      const canonical = await moveTo(agent, res.path);
      if (canonical) assigned.set(id, canonical);
    };

    // —— 会话创建：只登记 Agent，不建目录（避免打开即有空文件夹）——
    ctx.on('agent/created', (payload) => {
      const agent = payload?.agent;
      const session = agent?.session;
      if (!agent?.id || !session) return;
      agents.set(session.id, agent);
    });

    // —— 真正要跑一步时，才分配目录（waterfall 会被 await，保证本步就生效）——
    ctx.on('agent/pre-step', async (payload, next) => {
      const agent = payload?.agent;
      const session = agent?.session;
      if (agent && session) {
        // 跟随者（子代理）：主会话可能刚改过名/换过目录，每步同步一次。
        if (followers.has(session.id)) {
          const parent = session.header?.parentSession;
          const target = parent ? assigned.get(parent) : undefined;
          if (target) {
            if (currentDir(wd, session) !== target) {
              const moved = await moveTo(agent, target);
              if (moved) assigned.set(session.id, moved);
              else failed.add(session.id);
            }
            return next();
          }
          // 父会话状态已丢失（主会话刚结束 / 进程重启后状态为空）：
          // 子代理此刻仍停在原来的任务目录里，保持现状即可，
          // 绝不能因为找不到父记录就给它另建一个新目录。
          // 保留 followers 标记，父会话若回来（状态重建）就继续跟随。
          return next();
        }
        const known = assigned.get(session.id);
        // 已分配的目录可能被用户在资源管理器里删掉/改名：自愈，重新分配。
        if (known && !existsSync(known)) {
          warn(`已分配目录不存在，重新分配: ${known}`);
          assigned.delete(session.id);
          titleApplied.delete(session.id);
          titleFirstTry.delete(session.id);
          titleTries.delete(session.id);
        }
        if (!assigned.has(session.id)) {
          const text = (payload.messages ?? [])
            .map((m) => messageText(m))
            .filter(Boolean)
            .join('\n');
          await ensureFolder(agent, session, text);
        }
      }
      return next();
    });

    // —— 结束时回收空目录，避免留下一堆空文件夹 ——
    ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.id;
      if (!id) return;
      const dir = assigned.get(id);
      // 跟随者（子代理）与被跟随的主会话共用一个目录：谁都不能在销毁时回收它，
      // 否则子代理先结束就会把主会话正在用的目录删掉。
      const isFollower = followers.has(id);
      const stillFollowedBy = isFollower ? false : [...followers].some((f) => assigned.get(f) === dir);
      if (dir && !isFollower && !stillFollowedBy) reclaimEmptyDir(dir, config, log);
      agents.delete(id);
      assigned.delete(id);
      failed.delete(id);
      followers.delete(id);
      titleFirstTry.delete(id);
      titleTries.delete(id);
      titleApplied.delete(id);
      userNamed.delete(id);
    });

    // —— 补命名：消息太短没起成名字时，标题可用后补 ——
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return;
      const agent = agents.get(session.id);
      if (!agent) return;
      void applyTitle(session, agent).catch(() => {});
    });

    // —— task_folder 工具 ——
    ctx.tools.register(
      defineTool({
        name: 'task_folder',
        description:
          '查看 / 命名 / 复用当前会话的任务文件夹。每个会话的任务文件默认落在工作区根下、按「月日_任务名」命名的独立文件夹里（例：10-26_季度汇报PPT）。action=show 看当前目录，list 列全部，rename 改任务名，reuse 切到已有任务目录（换会话续做同一任务用），new 另开一个。',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['show', 'list', 'rename', 'reuse', 'new'],
            description: 'show=看当前任务目录；list=列全部任务目录；rename=重命名当前目录；reuse=切到已有目录；new=新开一个目录',
          },
          name: {
            type: 'string',
            description: 'rename 时是新任务名；reuse 时是已有任务名或目录名（支持部分匹配）；new 时可选的初始名',
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          const agent = exec.agent;
          const session = agent?.session;
          if (!session) return { text: '当前没有会话上下文，无法确定产物目录。' };
          const { root, requireMarker } = resolveRoot(config, wd, session);
          if (!root) return { text: '无法确定产物根目录：当前会话没有工作区。' };
          const current = assigned.get(session.id) ?? currentDir(wd, session);
          const lines = [];

          const moveToDir = async (dir) => {
            try {
              const canonical = await wd.set(agent, dir);
              assigned.set(session.id, canonical);
              failed.delete(session.id);
              return canonical;
            } catch (err) {
              throw new Error(`切换目录失败: ${err instanceof Error ? err.message : String(err)}`);
            }
          };

          if (args.action === 'show') {
            lines.push(`当前任务目录: ${current}`);
            lines.push(`任务目录根: ${root}`);
            const parsed = parseTaskDirName(basename(current));
            if (parsed) lines.push(`任务名: ${parsed.name || '(未命名)'}  月日: ${parsed.stamp}`);
            else lines.push('注意：当前目录不在本插件的任务目录约定内。');
          } else if (args.action === 'list') {
            const dirs = listTaskDirs(root, { requireMarker });
            lines.push(`任务目录根: ${root}（共 ${dirs.length} 个任务目录）`);
            if (!dirs.length) lines.push('(还没有任务目录)');
            for (const d of dirs.slice(-40)) lines.push(`${d.path === current ? '*' : ' '} ${basename(d.path)}`);
          } else if (args.action === 'rename') {
            const wanted = sanitizeName(args.name, maxChars);
            if (!wanted) return { text: '请提供要用的任务名（name 参数）。' };
            const res = renameTaskDir(current, wanted, maxChars);
            // 手动命名后不再让自动标题覆盖它。
            userNamed.add(session.id);
            titleApplied.add(session.id);
            if (res.error) {
              return { text: `重命名失败（目录仍为 ${current}）：${res.error}` };
            }
            if (!res.renamed) return { text: `目录名没有变化: ${current}` };
            const canonical = await moveToDir(res.path);
            lines.push(`已重命名为: ${canonical}`);
          } else if (args.action === 'reuse') {
            const hit = findTaskDir(root, args.name, { requireMarker });
            if (!hit) {
              const names = listTaskDirs(root, { requireMarker }).map((d) => basename(d.path));
              return { text: `没找到匹配「${args.name}」的任务目录。现有目录:\n${names.length ? names.join('\n') : '(无)'}` };
            }
            if (hit.path === current) return { text: `已经在该目录: ${current}` };
            // 当前目录若是本插件刚建的空目录，顺手清掉，不留空夹子。
            reclaimEmptyDir(current, config, log);
            const canonical = await moveToDir(hit.path);
            lines.push(`已切换到已有任务目录: ${canonical}`);
            lines.push('后续产物都写进这个目录。');
          } else if (args.action === 'new') {
            ensureDir(root);
            // 旧目录若还是空的，先回收再开新的，避免连续 new 留下空夹子。
            reclaimEmptyDir(current, config, log);
            let dir = createTaskDir(root);
            const wanted = sanitizeName(args.name, maxChars);
            if (wanted) {
              const res = renameTaskDir(dir, wanted, maxChars);
              dir = res.path;
              if (res.error) warn(`新目录改名失败（保留原名）：${res.error}`);
            }
            const canonical = await moveToDir(dir);
            lines.push(`已新开产物目录: ${canonical}`);
          }
          return { text: lines.join('\n') };
        },
      }),
    );
  });
}
