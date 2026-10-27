import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * 任务目录命名：`<月日>_<任务名>`，例：`10-26_季度汇报PPT`
 * 同名冲突时追加 `~2`、`~3`。
 *
 * 为什么冲突后缀是 `~` 而不是 `_`：
 * 早先版本用 `_2`，但 `_数字` 是用户完全可能自己起的名字（`方案_2`、`第2版_3`、`v1_2`），
 * 解析时无法区分「这是冲突后缀」还是「这是名字的一部分」，会把用户的名字静默改掉。
 * `~` 在 Windows 文件名里合法，且几乎不会出现在自然语言任务名里，从根上消除了歧义。
 *
 * 兼容旧格式 `<年-月日>_<序号>_<任务名>`（如 `2026-10-26_07_xxx`）：
 * 早期版本会生成这种目录，必须仍被识别为本插件的产物目录，
 * 否则会把它当成「未分配」，又给会话开一个新目录。
 */
const LEGACY_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(?:_(.*))?$/;
const TASK_RE = /^(\d{2})-(\d{2})_(.+)$/;

/** 同名冲突后缀：`名称~2`、`名称~3`。 */
const CONFLICT_RE = /~(\d+)$/;

/** 冲突后缀尝试上限（探测式申请用；正常情况几次就够）。 */
const MAX_CONFLICT_TRIES = 10000;

/** Windows 保留字符 + 控制字符；中文、emoji 一律放行。 */
const ILLEGAL_RE = /[\\/:*?"<>|\r\n\t]+/g;

/** 结尾这些标点没有信息量，去掉（含中文全角）。 */
const TRAILING_PUNCT_RE = /[.\s。、，,；;：:！!？?~～…·]+$/;

/** 目录已分配但还没拿到任务名时的占位名。 */
export const UNNAMED = '新任务';

/**
 * 任务目录的标记文件。
 *
 * 任务目录直接建在工作区根下时，光看名字（`10-26_xxx`）无法区分
 * 「本插件建的」和「用户自己建的」——`listTaskDirs` 会把两者一起扫进来，
 * `reuse` / `list` 乃至「是否已在任务目录内」的判断都会被污染。
 * 所以在目录里放一个空标记文件，扫描时优先信它。
 *
 * 隐藏文件名（Windows 下以 `.` 开头），不和用户自己的产物混在一起。
 */
export const MARKER = '.dsh-task-folder';

/** 目录里是否有任务目录标记。 */
export function hasMarker(dir) {
  try {
    return statSync(join(dir, MARKER)).isFile();
  } catch {
    return false;
  }
}

/** 给目录打标记（已存在则跳过）。 */
export function markTaskDir(dir) {
  try {
    const marker = join(dir, MARKER);
    if (!existsSync(marker)) writeFileSync(marker, '');
    return true;
  } catch {
    return false;
  }
}

/** 单段文件夹名长度上限（按字符算，中文一个字算一个）。 */
export const MAX_NAME_CHARS = 24;

/** 目录名是否符合本插件的产物目录约定（新旧两种格式都算）。 */
export function isTaskDirName(name) {
  if (typeof name !== 'string') return false;
  return TASK_RE.test(name) || LEGACY_RE.test(name);
}

/**
 * 整条路径是否已经落在任务目录里（用于 resume 时判断要不要重新分配）。
 *
 * 名字符合约定还不够：任务目录直接建在工作区根下时，用户自己也完全可能有一个
 * 叫 `10-26_清单` 的目录。所以还要求「有标记」或「是带序号的旧格式」，
 * 避免把用户的自建目录当成任务目录、从而不分配。
 */
export function isTaskDir(path) {
  if (typeof path !== 'string') return false;
  const name = basename(path);
  if (!isTaskDirName(name)) return false;
  const parsed = parseTaskDirName(name);
  // 旧格式 `<年-月日>_<序号>_<名>` 带 seq，必然是本插件早期版本生成的。
  if (parsed?.seq) return true;
  return hasMarker(path);
}

/**
 * 解析目录名 -> { stamp, seq, name }；不符合约定返回 undefined。
 *
 * 注意：TASK_RE 分支**不再剥掉结尾的 `_数字`**。
 * 用户自己起的 `方案_2` 就是名字本体，剥离会让内部记录的名字与真实目录名错位，
 * 后续自动改名会拼出错误或已存在的目录。冲突后缀统一由 `~N` 表达，见 CONFLICT_RE。
 */
export function parseTaskDirName(name) {
  if (typeof name !== 'string' || !name) return undefined;
  const legacy = LEGACY_RE.exec(name);
  if (legacy) {
    const [, , month, day, seq, taskName] = legacy;
    return { stamp: `${month}-${day}`, seq, name: taskName ?? '' };
  }
  const now = TASK_RE.exec(name);
  if (now) {
    const [, month, day, taskName] = now;
    return { stamp: `${month}-${day}`, seq: '', name: taskName };
  }
  return undefined;
}

/**
 * 任务名的「逻辑名」：去掉同名冲突后缀，用于判断「用户给的名字是不是没变」。
 * 只在比较时使用，绝不写回目录名。
 */
export function logicalNameOf(name) {
  return typeof name === 'string' ? name.replace(CONFLICT_RE, '') : '';
}

/** 当前月日 `MM-DD`（不用 UTC，否则晚上建的目录会跨天）。 */
export function dateStamp(now = new Date()) {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${m}-${d}`;
}

/**
 * 把任意文本清洗成可用的文件夹名：去掉路径分隔符与控制字符，
 * 合并空白，去掉首尾的点和空格（Windows 不允许目录名以它们结尾），再截断。
 */
export function sanitizeName(input, maxLength = MAX_NAME_CHARS) {
  if (typeof input !== 'string') return '';
  let s = input.replace(ILLEGAL_RE, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '');
  s = s.replace(TRAILING_PUNCT_RE, '');
  if (!s) return '';
  // 按「字符」而非 UTF-16 码元截断：emoji 占两个码元，按码元切会留下半个代理对，
  // 写进文件名后会变成乱码甚至让文件操作失败。
  const chars = Array.from(s);
  if (chars.length > maxLength) s = chars.slice(0, maxLength).join('');
  s = s.replace(TRAILING_PUNCT_RE, '');
  return s.trim();
}

/**
 * 列出某个根目录下所有产物目录，按名字排序（即按月日）。
 *
 * `requireMarker`：任务目录直接建在工作区根下时必须为 true，
 * 否则工作区里任何碰巧叫 `10-26_xxx` 的用户目录都会被当成任务目录。
 * 产物根目录是插件专用子目录（如 `产物/`）时不需要这个限制，传 false 即可。
 */
export function listTaskDirs(root, { requireMarker = false } = {}) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseTaskDirName(entry.name);
    if (!parsed) continue;
    const path = join(root, entry.name);
    // 旧格式带序号，必是本插件早期生成的，无需标记也认。
    if (requireMarker && !parsed.seq && !hasMarker(path)) continue;
    out.push({ ...parsed, path });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** 确保目录存在（含多级父目录）。 */
export function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}

/** 目录是否真实存在且是目录。 */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 在 parent 下**原子地**申请一个新的空目录，冲突时追加 `~2`、`~3`。
 *
 * 早先版本是「先 existsSync 探测、再 mkdir」，两个问题：
 * 1. 探测到第 100 个就退出，但退出时 target 仍是已被占用的路径 → 返回一个已存在的目录，
 *    两个会话因此共用一个产物目录，产物互相污染。
 * 2. 探测与创建之间不是原子的（TOCTOU），并发下仍可能撞车。
 *
 * 现在直接用非 recursive 的 mkdirSync 创建，靠 EEXIST 判定占用：创建即占位，天然原子。
 */
function claimDir(parent, stem) {
  for (let n = 1; n <= MAX_CONFLICT_TRIES; n += 1) {
    const target = join(parent, n === 1 ? stem : `${stem}~${n}`);
    try {
      mkdirSync(target);
      // 立刻打标记，让后续扫描能认出这是本插件建的目录。
      markTaskDir(target);
      return target;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`无法在 ${parent} 下为「${stem}」申请到不冲突的目录名（已尝试 ${MAX_CONFLICT_TRIES} 次）`);
}

/**
 * 在 root 下开一个新的产物目录，形如 `10-26_新任务`。
 * 只创建目录，改名留给拿到任务名之后。
 */
export function createTaskDir(root, now = new Date()) {
  const stamp = dateStamp(now);
  return claimDir(root, `${stamp}_${UNNAMED}`);
}

/**
 * 把一个已分配的目录改名成带任务名的形式；同名冲突时追加 `~2`、`~3`。
 *
 * 返回值从「路径字符串」改为 `{ path, renamed, error }`：
 * 失败时不再静默 `catch { return dir }`——上层可以据此告警，
 * 用户也才有可能知道「我起的名字为什么没生效」。
 *
 * 改名失败不该让会话创建失败，所以这里只回传错误，不抛。
 */
export function renameTaskDir(dir, rawName, maxLength = MAX_NAME_CHARS) {
  const parsed = parseTaskDirName(basename(dir));
  if (!parsed) return { path: dir, renamed: false, error: '当前目录不符合任务目录命名约定' };
  const name = sanitizeName(rawName, maxLength);
  // 名字没变（忽略冲突后缀），或还是空名，就不动。
  if (!name || name === logicalNameOf(parsed.name)) {
    return { path: dir, renamed: false };
  }
  const parent = dirname(dir);
  const stem = `${parsed.stamp}_${name}`;
  let lastError;
  for (let n = 1; n <= MAX_CONFLICT_TRIES; n += 1) {
    const target = join(parent, n === 1 ? stem : `${stem}~${n}`);
    // 目标就是自己：名字已经正确，无需改动。
    if (target === dir) return { path: dir, renamed: false };
    if (existsSync(target)) continue;
    try {
      renameSync(dir, target);
      return { path: target, renamed: true };
    } catch (err) {
      const code = err && err.code;
      // 目标已存在或被系统占用：换下一个后缀再试。
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') {
        lastError = err;
        continue;
      }
      return {
        path: dir,
        renamed: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return {
    path: dir,
    renamed: false,
    error: lastError instanceof Error ? lastError.message : `连续 ${MAX_CONFLICT_TRIES} 次改名冲突`,
  };
}

/** 在 root 下按名字（含模糊匹配）找一个已有产物目录。 */
export function findTaskDir(root, query, opts) {
  const dirs = listTaskDirs(root, opts);
  const q = String(query ?? '').trim();
  if (!q) return undefined;
  // 1. 完整目录名
  const exact = dirs.find((d) => d.path === q || basename(d.path) === q);
  if (exact) return exact;
  // 2. 任务名完全相等（忽略冲突后缀）
  const byName = dirs.find((d) => d.name === q || logicalNameOf(d.name) === q);
  if (byName) return byName;
  // 3. 双向包含（用户只记得半截名字时也能命中）
  const byPart = dirs
    .filter((d) => d.name.includes(q) || q.includes(d.name))
    .sort((a, b) => b.name.length - a.name.length);
  return byPart[0];
}
