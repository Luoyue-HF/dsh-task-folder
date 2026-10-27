import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  MARKER,
  UNNAMED,
  createTaskDir,
  dateStamp,
  findTaskDir,
  hasMarker,
  isTaskDir,
  isTaskDirName,
  listTaskDirs,
  logicalNameOf,
  markTaskDir,
  parseTaskDirName,
  renameTaskDir,
  sanitizeName,
} from './lib/folders.js';

/** 建一个临时根目录，并在测试结束时删掉。 */
function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('parseTaskDirName 解析新格式，保留用户名字里的 _数字', () => {
  assert.deepEqual(parseTaskDirName('10-26_季度汇报PPT'), {
    stamp: '10-26',
    seq: '',
    name: '季度汇报PPT',
  });
  // 回归：这三个名字曾被静默剥成「方案」「第2版」「v1」
  assert.equal(parseTaskDirName('10-26_方案_2').name, '方案_2');
  assert.equal(parseTaskDirName('10-26_第2版_3').name, '第2版_3');
  assert.equal(parseTaskDirName('10-26_v1_2').name, 'v1_2');
});

test('parseTaskDirName 解析旧格式与非法输入', () => {
  assert.deepEqual(parseTaskDirName('2026-10-26_07_旧任务'), {
    stamp: '10-26',
    seq: '07',
    name: '旧任务',
  });
  assert.equal(parseTaskDirName('随便一个目录'), undefined);
  assert.equal(parseTaskDirName(''), undefined);
  assert.equal(parseTaskDirName(null), undefined);
});

test('logicalNameOf 只剥冲突后缀', () => {
  assert.equal(logicalNameOf('方案'), '方案');
  assert.equal(logicalNameOf('方案~2'), '方案');
  assert.equal(logicalNameOf('方案_2'), '方案_2');
  assert.equal(logicalNameOf(undefined), '');
});

test('isTaskDirName 只看名字，isTaskDir 还要求标记或旧序号', (t) => {
  assert.equal(isTaskDirName('10-26_任务'), true);
  assert.equal(isTaskDirName('2026-10-26_07_任务'), true);
  assert.equal(isTaskDirName('产物'), false);

  const root = makeRoot(t);
  // 只是一个名字符合约定的普通目录（比如用户自己建的）：不算任务目录
  const plain = join(root, '10-26_任务');
  mkdirSync(plain);
  assert.equal(isTaskDir(plain), false);
  // 打了标记之后才算
  markTaskDir(plain);
  assert.equal(isTaskDir(plain), true);
  // 旧格式带序号，无需标记也认
  const legacy = join(root, '2026-10-26_07_旧任务');
  mkdirSync(legacy);
  assert.equal(isTaskDir(legacy), true);
  // 非任务目录始终 false
  assert.equal(isTaskDir(join(root, '产物')), false);
});

test('sanitizeName 去非法字符、首尾标点与空白', () => {
  assert.equal(sanitizeName('  报告/终稿:第一版  '), '报告 终稿 第一版');
  assert.equal(sanitizeName('任务。'), '任务');
  assert.equal(sanitizeName('...任务...'), '任务');
  assert.equal(sanitizeName('   '), '');
  assert.equal(sanitizeName(123), '');
});

test('sanitizeName 截断不产生孤立代理字符（emoji 按字符算）', () => {
  // 回归：旧实现用 slice 按 UTF-16 码元切，上限 5 时会留下半个代理对
  const s = '季度汇报\u{1F4CA}\u{1F4C8}\u{1F4C9}'; // 季度汇报📊📈📉
  const out = sanitizeName(s, 5);
  assert.equal(out, '季度汇报\u{1F4CA}');
  for (let i = 0; i < out.length; i += 1) {
    const code = out.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = out.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, '存在孤立的高代理字符');
    }
  }
  // 纯中文按字计数，不受影响
  assert.equal(sanitizeName('一二三四五六', 4), '一二三四');
});

test('dateStamp 用本地日期，不跨 UTC 天', () => {
  const d = new Date(2026, 9, 26, 23, 30, 0); // 本地 10-26 23:30
  assert.equal(dateStamp(d), '10-26');
});

test('createTaskDir 冲突时用 ~2 递增，且每个都是真实新目录', (t) => {
  const root = makeRoot(t);
  const first = createTaskDir(root);
  const second = createTaskDir(root);
  const third = createTaskDir(root);
  assert.equal(basename(first), `${dateStamp()}_${UNNAMED}`);
  assert.equal(basename(second), `${dateStamp()}_${UNNAMED}~2`);
  assert.equal(basename(third), `${dateStamp()}_${UNNAMED}~3`);
  assert.ok(existsSync(first) && existsSync(second) && existsSync(third));
});

test('createTaskDir 大量冲突时不返回已存在的路径', (t) => {
  const root = makeRoot(t);
  // 回归：旧实现 n < 100 退出后会返回一个已被占用的路径，
  // 导致两个会话共用一个产物目录。
  const seen = new Set();
  for (let i = 0; i < 130; i += 1) {
    const dir = createTaskDir(root);
    assert.ok(existsSync(dir), `返回了不存在的目录: ${dir}`);
    assert.ok(!seen.has(dir), `返回了重复目录: ${dir}`);
    seen.add(dir);
  }
  assert.equal(seen.size, 130);
  assert.equal(readdirSync(root).length, 130);
});

test('renameTaskDir 改名成功并返回结构化结果', (t) => {
  const root = makeRoot(t);
  const dir = createTaskDir(root);
  const res = renameTaskDir(dir, '季度汇报PPT');
  assert.equal(res.renamed, true);
  assert.equal(res.error, undefined);
  assert.equal(basename(res.path), `${dateStamp()}_季度汇报PPT`);
  assert.ok(existsSync(res.path));
  assert.ok(!existsSync(dir));
});

test('renameTaskDir 幂等：名字没变就不动', (t) => {
  const root = makeRoot(t);
  const dir = createTaskDir(root);
  const once = renameTaskDir(dir, '季度汇报PPT').path;
  const again = renameTaskDir(once, '季度汇报PPT');
  assert.equal(again.renamed, false);
  assert.equal(again.path, once);
});

test('renameTaskDir 同名冲突时递增 ~2，不覆盖已有目录', (t) => {
  const root = makeRoot(t);
  const a = renameTaskDir(createTaskDir(root), '报告').path;
  const b = renameTaskDir(createTaskDir(root), '报告').path;
  assert.equal(basename(a), `${dateStamp()}_报告`);
  assert.equal(basename(b), `${dateStamp()}_报告~2`);
  assert.ok(existsSync(a) && existsSync(b));
});

test('renameTaskDir 保留用户名字里的 _数字', (t) => {
  const root = makeRoot(t);
  const dir = createTaskDir(root);
  const res = renameTaskDir(dir, '方案_2');
  assert.equal(basename(res.path), `${dateStamp()}_方案_2`);
  // 再改名一次应当还能正确识别
  const next = renameTaskDir(res.path, '方案_3');
  assert.equal(basename(next.path), `${dateStamp()}_方案_3`);
});

test('renameTaskDir 非法目录给回 error 而不是静默返回', (t) => {
  const root = makeRoot(t);
  const plain = join(root, '不是任务目录');
  mkdirSync(plain);
  const res = renameTaskDir(plain, '新名字');
  assert.equal(res.renamed, false);
  assert.equal(res.path, plain);
  assert.ok(typeof res.error === 'string' && res.error.length > 0);
});

test('listTaskDirs 只列产物目录并按名排序', (t) => {
  const root = makeRoot(t);
  mkdirSync(join(root, '10-25_前一天'));
  mkdirSync(join(root, '10-26_今天'));
  mkdirSync(join(root, '其他目录'));
  const dirs = listTaskDirs(root);
  assert.deepEqual(
    dirs.map((d) => basename(d.path)),
    ['10-25_前一天', '10-26_今天'],
  );
  assert.equal(listTaskDirs(join(root, '根本不存在的目录')).length, 0);
});

test('createTaskDir 生成带标记的目录', (t) => {
  const root = makeRoot(t);
  const dir = createTaskDir(root);
  assert.equal(hasMarker(dir), true);
  assert.ok(existsSync(join(dir, MARKER)));
  assert.equal(isTaskDir(dir), true);
});

test('listTaskDirs 在 requireMarker 下只认本插件建的目录', (t) => {
  const root = makeRoot(t);
  // 工作区根下，用户自己建的、名字碰巧符合约定
  mkdirSync(join(root, '10-26_我自己建的清单'));
  // 本插件建的
  const ours = createTaskDir(root);
  // 旧格式带序号，即使没标记也认
  mkdirSync(join(root, '2026-10-25_07_早期任务'));

  const all = listTaskDirs(root);
  assert.equal(all.length, 3);

  const onlyOurs = listTaskDirs(root, { requireMarker: true });
  assert.deepEqual(
    onlyOurs.map((d) => basename(d.path)).sort(),
    ['2026-10-25_07_早期任务', basename(ours)].sort(),
  );
  assert.ok(!onlyOurs.some((d) => d.path === join(root, '10-26_我自己建的清单')));
});

test('findTaskDir 在 requireMarker 下不命中用户自建目录', (t) => {
  const root = makeRoot(t);
  const userDir = join(root, '10-26_年度总结');
  mkdirSync(userDir);
  assert.equal(findTaskDir(root, '年度总结', { requireMarker: true }), undefined);
  // 不要求标记时仍能找到（产物专用子目录的场景）
  assert.equal(findTaskDir(root, '年度总结')?.path, userDir);
});

test('findTaskDir 精确命中、逻辑名命中与部分匹配', (t) => {
  const root = makeRoot(t);
  const a = renameTaskDir(createTaskDir(root), '季度汇报PPT').path;
  const b = renameTaskDir(createTaskDir(root), '月度销售表').path;
  // 完整目录名
  assert.equal(findTaskDir(root, basename(a)).path, a);
  // 任务名完全相等
  assert.equal(findTaskDir(root, '月度销售表').path, b);
  // 部分匹配
  assert.equal(findTaskDir(root, '汇报').path, a);
  assert.equal(findTaskDir(root, ''), undefined);
});
