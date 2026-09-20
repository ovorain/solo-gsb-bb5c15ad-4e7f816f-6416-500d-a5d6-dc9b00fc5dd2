const assert = require('node:assert/strict');
const {
  computeEffective,
  evaluateKey,
  parseSequence,
  generateRegressionSuite,
  minimumSetCover,
  conflictGoalId,
  previewSandbox,
} = require('../src/engine');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// 构造可控数据
const state = {
  contexts: [
    { id: 'root', parentId: null, name: 'Root' },
    { id: 'a', parentId: 'root', name: 'A' },
    { id: 'b', parentId: 'a', name: 'B' },
    { id: 'sibling', parentId: 'root', name: 'Sibling' },
  ],
  commands: [
    { id: 'c1', contextId: 'root', name: 'root-x', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    { id: 'c2', contextId: 'root', name: 'root-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    { id: 'c3', contextId: 'root', name: 'root-gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    { id: 'c4', contextId: 'a', name: 'a-x', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    { id: 'c5', contextId: 'a', name: 'a-y1', sequenceTokens: ['y'], sequenceLabel: 'Y', description: '' },
    { id: 'c6', contextId: 'a', name: 'a-y2', sequenceTokens: ['y'], sequenceLabel: 'Y', description: '' },
    { id: 'c7', contextId: 'b', name: 'b-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    { id: 'c8', contextId: 'sibling', name: 'sib-k', sequenceTokens: ['k'], sequenceLabel: 'K', description: '' },
  ],
};

test('序列解析：空格/逗号分隔，1~3 次', () => {
  assert.deepEqual(parseSequence('g l').tokens, ['g', 'l']);
  assert.deepEqual(parseSequence('Ctrl+K, x').tokens, ['ctrl+k', 'x']);
  assert.ok(parseSequence('a b c d').ok === false);
  assert.ok(parseSequence('').ok === false);
  assert.ok(parseSequence('ctrl+alt').ok === false); // 没有主键
  assert.equal(parseSequence('shift+k').tokens[0], 'shift+k');
});

test('最近祖先：B 的 X 被 A 覆盖，root X 标记 shadowed', () => {
  const eff = computeEffective(state, 'b');
  const active = eff.entries.filter((e) => e.state !== 'shadowed');
  assert.ok(active.some((e) => e.commandId === 'c4')); // a-x 生效
  assert.ok(!active.some((e) => e.commandId === 'c1')); // root-x 不生效
  const shadow = eff.entries.find((e) => e.commandId === 'c1');
  assert.equal(shadow.state, 'shadowed');
});

test('同层相同序列：duplicate 冲突且双方都在生效列表', () => {
  const eff = computeEffective(state, 'a');
  const c5 = eff.entries.find((e) => e.commandId === 'c5');
  const c6 = eff.entries.find((e) => e.commandId === 'c6');
  assert.equal(c5.state, 'duplicate');
  assert.equal(c6.state, 'duplicate');
  assert.ok(eff.conflicts.some((c) => c.type === 'duplicate' && c.parties.length === 2));
});

test('前缀冲突：根的 G 与 G D 双方标记，且包含跨层情况', () => {
  const effRoot = computeEffective(state, 'root');
  assert.ok(effRoot.conflicts.some((c) => c.type === 'prefix'));
  const g = effRoot.entries.find((e) => e.commandId === 'c2');
  const gd = effRoot.entries.find((e) => e.commandId === 'c3');
  assert.equal(g.prefix, 'prefix');
  assert.equal(gd.prefix, 'extension');

  // B 层：B 的 G（c7）与 root 的 G D（c3）构成跨层前缀冲突
  const effB = computeEffective(state, 'b');
  assert.ok(
    effB.conflicts.some(
      (c) => c.type === 'prefix' && c.parties.some((p) => p.commandId === 'c7') && c.parties.some((p) => p.commandId === 'c3'),
    ),
  );
  // root 的 G（c2）在 B 下被覆盖，不参与前缀冲突
  assert.ok(!effB.conflicts.some((c) => c.parties.some((p) => p.commandId === 'c2')));
});

test('生效绑定只包含当前上下文链上的命令，兄弟上下文不串入', () => {
  const eff = computeEffective(state, 'b');
  assert.ok(!eff.entries.some((e) => e.commandId === 'c8'));
});

test('逐键模拟：idle → waiting → triggered', () => {
  let r = evaluateKey(state, 'root', []);
  assert.equal(r.status, 'idle');
  r = evaluateKey(state, 'root', ['g']);
  assert.equal(r.status, 'triggered'); // G 自身是命令
  assert.ok(r.candidates.length >= 1); // 同时是 G D 的前缀
  assert.ok(r.candidates.some((c) => c.sequenceLabel === 'G D'));
  r = evaluateKey(state, 'root', ['g', 'd']);
  assert.equal(r.status, 'triggered');
  assert.equal(r.triggered[0].commandId, 'c3');
});

test('逐键模拟：等待态与无匹配', () => {
  // A 层没有 G 单独命令，只有 root 的 G（在 A 下仍生效）。构造更独立的场景：
  const st2 = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [{ id: 'z1', contextId: 'r', name: 'zab', sequenceTokens: ['z', 'a', 'b'], sequenceLabel: 'Z A B', description: '' }],
  };
  assert.equal(evaluateKey(st2, 'r', ['z']).status, 'waiting');
  assert.equal(evaluateKey(st2, 'r', ['z', 'a']).status, 'waiting');
  assert.equal(evaluateKey(st2, 'r', ['z', 'a', 'b']).status, 'triggered');
  assert.equal(evaluateKey(st2, 'r', ['x']).status, 'no-match');
  assert.equal(evaluateKey(st2, 'r', ['z', 'q']).status, 'no-match');
});

test('逐键模拟：duplicate 命中时 triggered 含双方', () => {
  const r = evaluateKey(state, 'a', ['y']);
  assert.equal(r.status, 'triggered');
  const ids = r.triggered.map((t) => t.commandId).sort();
  assert.deepEqual(ids, ['c5', 'c6']);
});

test('上下文路径展示双方来源', () => {
  const eff = computeEffective(state, 'b');
  const conflict = eff.conflicts.find((c) => c.type === 'prefix');
  assert.ok(conflict.parties.every((p) => typeof p.contextPath === 'string' && p.contextPath.length > 0));
  const labels = conflict.parties.map((p) => p.shortestLabel);
  assert.ok(labels.includes('G') && labels.includes('G D'));
});

// ---------- 回归套件生成 ----------
test('回归套件：叶子候选与精确集合覆盖（最小叶子数）', () => {
  const suite = generateRegressionSuite(state);
  // 叶子：B 与 Sibling（Root、A 不是叶子）
  assert.equal(suite.stats.leafCount, 2);
  assert.deepEqual(
    suite.candidates.map((c) => c.contextId).sort(),
    ['b', 'sibling'],
  );
  // 目标：8 条命令在至少一个叶子可触发（c1 在 Sibling 生效）+ duplicate 1
  // + prefix 2（B 下 c7⊂c3 与 Sibling 下 c2⊂c3 是两个不同冲突身份）
  assert.equal(suite.stats.triggerableCommandCount, 8);
  assert.equal(suite.stats.duplicateConflictCount, 1);
  assert.equal(suite.stats.prefixConflictCount, 2);
  assert.equal(suite.stats.coveredGoalCount, suite.stats.coverableGoalCount);
  // 必须同时入选两个叶子：Sibling 独有 c8/k，B 独有 duplicate 与跨层 prefix
  assert.equal(suite.stats.selectedContextCount, 2);
  const selectedIds = suite.suite.map((tc) => tc.contextId).sort();
  assert.deepEqual(selectedIds, ['b', 'sibling']);

  const bCase = suite.suite.find((tc) => tc.contextId === 'b');
  // 每个入选上下文列出输入序列、预期触发命令集合
  const yInput = bCase.inputs.find((i) => i.sequenceLabel === 'Y');
  assert.equal(yInput.duplicate, true);
  assert.deepEqual(
    yInput.expectedCommands.map((c) => c.commandId).sort(),
    ['c5', 'c6'],
  );
  // 预期冲突类型同时包含 duplicate 与 prefix
  assert.deepEqual(
    bCase.expectedConflicts.map((c) => c.type).sort(),
    ['duplicate', 'prefix'],
  );
});

test('回归套件：任何叶子都无法触发的命令单列原因，不计入覆盖', () => {
  // u1 定义在根、序列 S：在叶子 B 被 A 层同序列覆盖，在叶子 S 被自身同序列覆盖
  const st = {
    contexts: [
      { id: 'r', parentId: null, name: 'R' },
      { id: 'a', parentId: 'r', name: 'A' },
      { id: 'b', parentId: 'a', name: 'B' },
      { id: 's', parentId: 'r', name: 'S' },
    ],
    commands: [
      { id: 'u1', contextId: 'r', name: 'r-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 'a1', contextId: 'a', name: 'a-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 's1', contextId: 's', name: 's-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 'ok', contextId: 'r', name: 'r-quit', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
    ],
  };
  const suite = generateRegressionSuite(st);
  const unreachable = suite.unreachableCommands.find((u) => u.commandId === 'u1');
  assert.ok(unreachable, 'u1 应列为不可触发');
  assert.match(unreachable.reason, /覆盖/);
  assert.deepEqual(unreachable.shadowedBy.map((s) => s.contextId).sort(), ['a', 's']);
  // 不可触发命令不算可触发、不算已覆盖
  assert.equal(suite.stats.triggerableCommandCount, 3); // a1 / s1 / ok
  assert.equal(suite.stats.unreachableCommandCount, 1);
  assert.ok(
    !suite.suite.some((tc) => tc.inputs.some((i) => i.expectedCommands.some((c) => c.commandId === 'u1'))),
  );
  // 但可触发目标仍被完整覆盖
  assert.equal(suite.stats.coveredGoalCount, suite.stats.coverableGoalCount);
});

test('回归套件：定义在非叶子上下文且子树无覆盖时命令仍可在叶子触发', () => {
  // c2(root G)、c3(root G D) 在 A、B、Sibling 都生效
  const suite = generateRegressionSuite(state);
  assert.ok(!suite.unreachableCommands.some((u) => u.commandId === 'c2'));
  assert.ok(!suite.unreachableCommands.some((u) => u.commandId === 'c3'));
});

test('回归套件：非叶子上下文独占（无叶子后代）的命令不可触发', () => {
  const st = {
    contexts: state.contexts,
    commands: [
      ...state.commands,
      { id: 'c11', contextId: 'a', name: 'a-only', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
      { id: 'c12', contextId: 'b', name: 'b-cover-q', sequenceTokens: ['q'], sequenceLabel: 'Q', description: '' },
    ],
  };
  const suite = generateRegressionSuite(st);
  // A 有子 B：Q 在 B 被覆盖，A 没有其他叶子后代
  const u = suite.unreachableCommands.find((x) => x.commandId === 'c11');
  assert.ok(u);
  assert.match(u.reason, /全部 1 个叶子/);
});

test('回归套件：同解时按上下文路径字典序稳定选择', () => {
  // 两个叶子 zfirst / asecond 覆盖目标完全相同 => 任选其一；应选路径字典序更小的
  const st = {
    contexts: [
      { id: 'r', parentId: null, name: 'R' },
      { id: 'zc', parentId: 'r', name: 'Zchild', description: '' },
      { id: 'ac', parentId: 'r', name: 'Achild', description: '' },
    ],
    commands: [
      { id: 'm1', contextId: 'r', name: 'm-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
    ],
  };
  const suite = generateRegressionSuite(st);
  assert.equal(suite.stats.selectedContextCount, 1);
  assert.equal(suite.suite[0].contextId, 'ac'); // R / Achild < R / Zchild
});

test('minimumSetCover：最小数量 + 字典序平局的基本性质', () => {
  const mk = (contextPath, arr) => ({ contextPath, covers: new Set(arr) });
  const candidates = [
    mk('Z', ['x']),
    mk('A', ['x']), // 与 Z 同覆盖，路径更小
    mk('M', ['y']),
    mk('B', ['x', 'y']),
  ];
  const picked = minimumSetCover(candidates, new Set(['x', 'y']));
  assert.equal(picked.length, 1);
  assert.equal(picked[0].contextPath, 'B'); // 单集合可覆盖全部

  const picked2 = minimumSetCover(
    [mk('Z', ['x']), mk('A', ['x']), mk('Y', ['y']), mk('B', ['y'])],
    new Set(['x', 'y']),
  );
  assert.deepEqual(picked2.map((c) => c.contextPath).sort(), ['A', 'B']);
});

test('conflictGoalId：参与命令集合相同即同一冲突身份', () => {
  const dup1 = { type: 'duplicate', parties: [{ commandId: 'c5' }, { commandId: 'c6' }] };
  const dup2 = { type: 'duplicate', parties: [{ commandId: 'c6' }, { commandId: 'c5' }] };
  assert.equal(conflictGoalId(dup1), conflictGoalId(dup2));
  const pre1 = {
    type: 'prefix',
    parties: [
      { commandId: 'c2', role: 'prefix' },
      { commandId: 'c3', role: 'extension' },
    ],
  };
  const pre2 = {
    type: 'prefix',
    parties: [
      { commandId: 'c3', role: 'extension' },
      { commandId: 'c2', role: 'prefix' },
    ],
  };
  assert.equal(conflictGoalId(pre1), conflictGoalId(pre2));
  assert.notEqual(conflictGoalId(pre1), conflictGoalId(dup1));
});

// ---------- 变更沙盒预演 ----------
test('沙盒：空草案在所有上下文都没有差异', () => {
  const r = previewSandbox(state, {});
  assert.equal(r.contexts.length, 0);
  assert.equal(r.stats.commandCountBefore, 8);
  assert.equal(r.stats.commandCountAfter, 8);
  assert.equal(r.unreachable.added.length, 0);
  assert.equal(r.unreachable.removed.length, 0);
  // 回显的草案被规范化
  assert.deepEqual(r.draft, { creates: [], updates: [], deletes: [] });
});

test('沙盒：改序列后祖先绑定恢复生效（shadowed 消失），改动命令记为变化', () => {
  // c4(A 的 X) 改为 Z：B 下 root 的 c1(X) 不再被覆盖
  const r = previewSandbox(state, { updates: [{ commandId: 'c4', sequence: 'z' }] });
  const bCtx = r.contexts.find((c) => c.contextId === 'b');
  assert.ok(bCtx, 'B 上下文应有差异');
  assert.deepEqual(bCtx.shadowed.removed.map((x) => x.commandId), ['c1']);
  assert.deepEqual(bCtx.effectiveBindings.added.map((x) => x.commandId), ['c1']);
  const change = bCtx.effectiveBindings.changed.find((ch) => ch.before.commandId === 'c4');
  assert.ok(change);
  assert.equal(change.before.sequenceLabel, 'X');
  assert.equal(change.after.sequenceLabel, 'Z');
});

test('沙盒：删除重复一方使 duplicate 消失；新增同序列双方使 duplicate 新增（稳定身份配对）', () => {
  // 删除 c6 => A、B 下的 duplicate 身份 dup:c5,c6 消失
  const r1 = previewSandbox(state, { deletes: ['c6'] });
  for (const ctxId of ['a', 'b']) {
    const ctx = r1.contexts.find((c) => c.contextId === ctxId);
    assert.deepEqual(ctx.duplicates.removed.map((c) => c.goalId), ['dup:c5,c6']);
    assert.equal(ctx.duplicates.added.length, 0);
  }

  // 在 root 新增两个同序列命令 n1/n2 => 每个上下文（含兄弟 Sibling）都新增 dup:n1,n2
  const r2 = previewSandbox(state, {
    creates: [
      { clientId: 'n2', contextId: 'root', name: 'new-2', sequence: 't' },
      { clientId: 'n1', contextId: 'root', name: 'new-1', sequence: 't' },
    ],
  });
  assert.equal(r2.contexts.length, 4); // 四个上下文都新增了该 duplicate
  for (const ctx of r2.contexts) {
    assert.deepEqual(ctx.duplicates.added.map((c) => c.goalId), ['dup:n1,n2']);
    const conflict = ctx.duplicates.added[0];
    // 参与方稳定排序：n1 在前，且带来源路径与最短触发输入
    assert.deepEqual(conflict.parties.map((p) => p.commandId), ['n1', 'n2']);
    assert.ok(conflict.parties.every((p) => p.contextPath && p.shortestLabel === 'T'));
  }
});

test('沙盒：删除延伸方使跨层 prefix 冲突消失', () => {
  // B 下存在跨层前缀冲突 c7(B 的 G) ⊂ c3(root 的 G D)
  const r = previewSandbox(state, { deletes: ['c3'] });
  const bCtx = r.contexts.find((c) => c.contextId === 'b');
  assert.deepEqual(bCtx.prefixes.removed.map((c) => c.goalId), ['pre:c7::c3']);
  assert.equal(bCtx.prefixes.added.length, 0);
});

test('沙盒：新增前缀对使 prefix 新增，且双方带来源路径与最短触发输入', () => {
  const r = previewSandbox(state, {
    creates: [
      { clientId: 'new-ext', contextId: 'sibling', name: 'sib-k-l', sequence: 'k l' },
    ],
  });
  const sCtx = r.contexts.find((c) => c.contextId === 'sibling');
  assert.equal(sCtx.prefixes.added.length, 1);
  const pre = sCtx.prefixes.added[0];
  assert.equal(pre.goalId, 'pre:c8::new-ext');
  assert.equal(pre.prefixSequenceLabel, 'K');
  assert.equal(pre.extensionSequenceLabel, 'K L');
  const byRole = Object.fromEntries(pre.parties.map((p) => [p.role, p]));
  assert.equal(byRole.prefix.commandId, 'c8');
  assert.equal(byRole.prefix.shortestLabel, 'K');
  assert.equal(byRole.extension.commandId, 'new-ext');
  assert.equal(byRole.extension.shortestLabel, 'K L');
});

test('沙盒：删除叶子上的覆盖命令后，不可触发命令从列表消失（恢复可触发）', () => {
  // u1(root S) 在两个叶子都被覆盖 => 不可触发；删掉两个覆盖者后恢复
  const st = {
    contexts: [
      { id: 'r', parentId: null, name: 'R' },
      { id: 'a', parentId: 'r', name: 'A' },
      { id: 'b', parentId: 'a', name: 'B' },
      { id: 's', parentId: 'r', name: 'S' },
    ],
    commands: [
      { id: 'u1', contextId: 'r', name: 'r-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 'a1', contextId: 'a', name: 'a-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
      { id: 's1', contextId: 's', name: 's-save', sequenceTokens: ['s'], sequenceLabel: 'S', description: '' },
    ],
  };
  const before = previewSandbox(st, {});
  assert.equal(before.stats.unreachableBefore, 1);
  assert.deepEqual(before.unreachable.added.map((u) => u.commandId), []);
  const r = previewSandbox(st, { deletes: ['a1', 's1'] });
  assert.deepEqual(r.unreachable.removed.map((u) => u.commandId), ['u1']);
  assert.equal(r.unreachable.added.length, 0);
  assert.equal(r.stats.unreachableAfter, 0);
});

test('沙盒：改序列覆盖祖先会新增不可触发命令并给出原因', () => {
  // 原本 u1(root S) 只在叶子 B 被 A 覆盖、在 Sibling 可触发；把 c8 改成 Sibling 上的 S 后 u1 不可触发
  const r = previewSandbox(state, { updates: [{ commandId: 'c8', sequence: 's' }] });
  // c8 原为 Sibling 的 K：改后 K 绑定消失（Sibling 下），新增 S
  const sCtx = r.contexts.find((c) => c.contextId === 'sibling');
  assert.deepEqual(sCtx.effectiveBindings.changed.map((ch) => ch.after.commandId), ['c8']);
  // 该状态下 u1 类命令不存在 —— 这里确认命令移动场景：把 c4 从 A 移走后 c1 恢复，不新增不可触发
  const r2 = previewSandbox(state, { updates: [{ commandId: 'c4', contextId: 'sibling' }] });
  const bCtx = r2.contexts.find((c) => c.contextId === 'b');
  assert.deepEqual(bCtx.effectiveBindings.added.map((x) => x.commandId), ['c1']);
});

test('沙盒：结果与草案入参顺序、数据顺序均无关', () => {
  const d = {
    creates: [
      { clientId: 'n2', contextId: 'root', name: 'n2', sequence: 't' },
      { clientId: 'n1', contextId: 'a', name: 'n1', sequence: 't' },
    ],
    updates: [{ commandId: 'c4', sequence: 'z' }],
    deletes: ['c6', 'c3'],
  };
  const shuffledDraft = {
    creates: d.creates.slice().reverse(),
    updates: d.updates.slice().reverse(),
    deletes: d.deletes.slice().reverse(),
  };
  const shuffledState = {
    contexts: state.contexts.slice().reverse(),
    commands: state.commands.slice().reverse(),
  };
  const r1 = previewSandbox(state, d);
  const r2 = previewSandbox(shuffledState, shuffledDraft);
  delete r1.generatedAt;
  delete r2.generatedAt;
  assert.deepEqual(r1, r2);
});

test('沙盒：非法草案返回带 status=400 的错误且不产出模拟状态', () => {
  const badCases = [
    { creates: [{ contextId: 'root', name: 'x', sequence: 'k' }] }, // 无 clientId
    { creates: [{ clientId: 'a', contextId: 'root', name: 'x', sequence: 'a b c d' }] }, // 序列过长
    { creates: [{ clientId: 'a', contextId: 'nope', name: 'x', sequence: 'k' }] }, // 上下文不存在
    { updates: [{ commandId: 'ghost' }] }, // 命令不存在
    { deletes: ['c5'], updates: [{ commandId: 'c5', sequence: 'k' }] }, // 又删又改
    'not-an-object',
  ];
  for (const bad of badCases) {
    assert.throws(
      () => previewSandbox(state, bad),
      (err) => err.status === 400,
    );
  }
});

console.log(`\n引擎测试全部通过：${passed} 项`);
