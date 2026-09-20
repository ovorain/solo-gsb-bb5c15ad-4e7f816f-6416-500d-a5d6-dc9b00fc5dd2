/**
 * 快捷键审校引擎
 * - 最近祖先规则：沿 contextId → parent 向上查找，最深层（最近祖先）的绑定生效
 * - 同层相同序列：重复绑定，双方均触发但标记 duplicate 冲突
 * - 前缀冲突：任一生效序列是另一生效序列的严格前缀时，双方标记 prefix 冲突
 * - 被更深层同序列覆盖的祖先绑定标记为 shadowed（不生效）
 */

const MAX_PRESSES = 3;

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'meta']);

/**
 * 规范化单次按键（支持 Ctrl+K 这种组合键，算作“一次按键”）。
 * 返回 { ok, token, error }
 */
function canonicalPress(raw) {
  const segment = String(raw || '').trim().toLowerCase();
  if (!segment) return { ok: false, error: '空按键' };
  const parts = segment
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, error: '空按键' };

  const mods = [];
  const keys = [];
  for (const p of parts) {
    if (MODIFIERS.has(p)) {
      if (!mods.includes(p)) mods.push(p);
    } else {
      keys.push(p);
    }
  }
  if (keys.length !== 1) {
    return { ok: false, error: `按键 "${raw}" 必须恰好包含一个主键（修饰键：Ctrl/Alt/Shift/Meta）` };
  }
  const order = ['ctrl', 'alt', 'shift', 'meta'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // 规范展示：Ctrl+K
  const pretty = [...mods, keys[0]]
    .map((p) => (MODIFIERS.has(p) ? p[0].toUpperCase() + p.slice(1) : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
  return { ok: true, token: [...mods, keys[0]].join('+'), pretty };
}

/**
 * 解析序列输入。接受空格或逗号分隔的 1~3 次按键，例如：
 *   "g l"  /  "ctrl+k, x"  /  "Ctrl+Shift+p"
 */
function parseSequence(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: '请输入 1~3 次按键' };
  const segments = text.split(/[\s,]+/).filter(Boolean);
  if (segments.length < 1 || segments.length > MAX_PRESSES) {
    return { ok: false, error: `序列必须由 1~${MAX_PRESSES} 次按键组成，当前 ${segments.length} 次` };
  }
  const tokens = [];
  const labels = [];
  for (const seg of segments) {
    const r = canonicalPress(seg);
    if (!r.ok) return { ok: false, error: r.error };
    tokens.push(r.token);
    labels.push(r.pretty);
  }
  return { ok: true, tokens, label: labels.join(' ') };
}

function seqKey(tokens) {
  return tokens.join('');
}

function isPrefix(shorter, longer) {
  if (shorter.length >= longer.length) return false;
  return shorter.every((t, i) => t === longer[i]);
}

function buildIndex(contexts) {
  const byId = new Map();
  const roots = [];
  for (const c of contexts) {
    byId.set(c.id, { ...c, children: [] });
  }
  for (const c of byId.values()) {
    if (c.parentId && byId.has(c.parentId)) {
      byId.get(c.parentId).children.push(c);
    } else {
      roots.push(c);
    }
  }
  return { byId, roots };
}

/** 从某上下文向上到根的链（含自身），自身在前 */
function ancestorChain(index, contextId) {
  const chain = [];
  let cur = index.byId.get(contextId);
  const guard = new Set();
  while (cur) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? index.byId.get(cur.parentId) : null;
  }
  return chain;
}

function contextPath(index, contextId) {
  const chain = ancestorChain(index, contextId).reverse(); // 根 → 当前
  return chain.map((c) => c.name).join(' / ');
}

/**
 * 计算指定上下文下生效的全部绑定。
 * 返回 {
 *   contextId, contextPath, chain: [{id,name,depth}],
 *   entries: 所有绑定（含 shadowed）,
 *   effectiveGroups: 按序列分组的生效绑定,
 *   conflicts: 冲突清单（duplicate / prefix）
 * }
 */
function computeEffective(state, contextId) {
  const index = buildIndex(state.contexts);
  if (!index.byId.has(contextId)) {
    throw Object.assign(new Error('上下文不存在'), { status: 404 });
  }
  const chain = ancestorChain(index, contextId); // [自身, 父, ..., 根]
  const pathStr = contextPath(index, contextId);

  // 仅收集链上上下文定义的命令；链上深度：自身 0。按由近到远的深度排序处理
  const chainIds = new Set(chain.map((c) => c.id));
  const depthOf = new Map(chain.map((c, i) => [c.id, i]));

  const owned = state.commands
    .filter((cmd) => chainIds.has(cmd.contextId))
    .map((cmd) => ({
      cmd,
      contextId: cmd.contextId,
      ownerDepth: depthOf.get(cmd.contextId),
      contextPath: contextPath(index, cmd.contextId),
    }))
    .sort((a, b) => a.ownerDepth - b.ownerDepth);

  const groupsMap = new Map(); // seqKey -> { tokens, label, commands:[record...] }
  const shadowed = []; // 被覆盖的祖先绑定

  for (const record of owned) {
    const { cmd } = record;
    const key = seqKey(cmd.sequenceTokens);
    const existing = groupsMap.get(key);
    if (!existing) {
      groupsMap.set(key, {
        seqKey: key,
        tokens: [...cmd.sequenceTokens],
        label: cmd.sequenceLabel,
        commands: [record],
      });
    } else if (record.ownerDepth === existing.commands[0].ownerDepth) {
      existing.commands.push(record); // 同层重复（duplicate 冲突，双方均生效）
    } else {
      // 更深祖先（更大 depth）的同序列绑定被最近祖先覆盖
      shadowed.push({ ...record, overriddenByDepth: existing.commands[0].ownerDepth });
    }
  }

  // 组状态：同层多命令 => duplicate
  const effectiveGroups = [...groupsMap.values()].map((g) => ({
    ...g,
    duplicate: g.commands.length > 1,
  }));

  // 前缀冲突：生效组两两比较（跨越不同层级也算）
  const prefixPairs = []; // [shortGroup, longGroup]
  for (let i = 0; i < effectiveGroups.length; i++) {
    for (let j = 0; j < effectiveGroups.length; j++) {
      if (i === j) continue;
      const a = effectiveGroups[i];
      const b = effectiveGroups[j];
      if (isPrefix(a.tokens, b.tokens)) {
        prefixPairs.push([a, b]);
      }
    }
  }
  const prefixShortKeys = new Set(prefixPairs.map(([a]) => a.seqKey));
  const prefixLongKeys = new Set(prefixPairs.map(([, b]) => b.seqKey));

  // 汇总 entries
  const entries = [];
  for (const g of effectiveGroups) {
    const prefixRole = prefixShortKeys.has(g.seqKey)
      ? 'prefix'
      : prefixLongKeys.has(g.seqKey)
        ? 'extension'
        : null;
    for (const rec of g.commands) {
      entries.push({
        commandId: rec.cmd.id,
        name: rec.cmd.name,
        description: rec.cmd.description || '',
        contextId: rec.contextId,
        contextPath: rec.contextPath,
        ownerDepth: rec.ownerDepth,
        sequenceTokens: g.tokens,
        sequenceLabel: g.label,
        state: g.duplicate ? 'duplicate' : 'active',
        shadowedBy: null,
        duplicate: g.duplicate,
        prefix: prefixRole, // 'prefix' | 'extension' | null
      });
    }
  }
  for (const rec of shadowed) {
    entries.push({
      commandId: rec.cmd.id,
      name: rec.cmd.name,
      description: rec.cmd.description || '',
      contextId: rec.contextId,
      contextPath: rec.contextPath,
      ownerDepth: rec.ownerDepth,
      sequenceTokens: rec.cmd.sequenceTokens,
      sequenceLabel: rec.cmd.sequenceLabel,
      state: 'shadowed',
      shadowedBy: chain[rec.overriddenByDepth]?.id ?? null,
      duplicate: false,
      prefix: null,
    });
  }
  entries.sort((a, b) => a.sequenceLabel.localeCompare(b.sequenceLabel) || a.ownerDepth - b.ownerDepth);

  // 冲突清单
  const conflicts = [];
  for (const g of effectiveGroups.filter((g) => g.duplicate)) {
    conflicts.push({
      type: 'duplicate',
      kindLabel: '同层序列重复',
      sequenceLabel: g.label,
      sequenceTokens: g.tokens,
      parties: g.commands.map((rec) => ({
        commandId: rec.cmd.id,
        name: rec.cmd.name,
        contextId: rec.contextId,
        contextPath: rec.contextPath,
        sequenceLabel: g.label,
        shortestLabel: g.label,
      })),
    });
  }
  for (const [shortG, longG] of prefixPairs) {
    conflicts.push({
      type: 'prefix',
      kindLabel: '前缀冲突',
      prefixSequenceLabel: shortG.label,
      extensionSequenceLabel: longG.label,
      prefixTokens: shortG.tokens,
      extensionTokens: longG.tokens,
      parties: [
        ...shortG.commands.map((rec) => ({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          contextId: rec.contextId,
          contextPath: rec.contextPath,
          sequenceLabel: shortG.label,
          shortestLabel: shortG.label,
          role: 'prefix',
        })),
        ...longG.commands.map((rec) => ({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          contextId: rec.contextId,
          contextPath: rec.contextPath,
          sequenceLabel: longG.label,
          shortestLabel: longG.label,
          role: 'extension',
        })),
      ],
    });
  }

  return {
    contextId,
    contextPath: pathStr,
    chain: chain.map((c, i) => ({ id: c.id, name: c.name, depth: i })).reverse(),
    entries,
    effectiveGroups,
    conflicts,
  };
}

/**
 * 逐键模拟：给定已经按下的按键缓冲，返回当前状态。
 * status:
 *   idle       尚未输入
 *   triggered  精确命中，命令已触发
 *   waiting    已构成某些命令序列的前缀，等待后续按键
 *   no-match   无任何匹配（含缓冲到 3 键仍未命中）
 */
function evaluateKey(state, contextId, bufferTokens) {
  const eff = computeEffective(state, contextId);
  const buffer = bufferTokens || [];

  if (buffer.length === 0) {
    return { status: 'idle', buffer, bufferLabel: '', triggered: [], candidates: [], effective: eff };
  }

  const bufferLabel = buffer.map((t) => pressToPretty(t)).join(' ');
  const groups = eff.effectiveGroups;

  const exact = groups.filter((g) => g.tokens.length === buffer.length && g.tokens.every((t, i) => t === buffer[i]));
  const prefixed = groups.filter((g) => isPrefix(buffer, g.tokens));

  const toCandidate = (g) => ({
    sequenceLabel: g.label,
    sequenceTokens: g.tokens,
    commands: g.commands.map((rec) => ({
      commandId: rec.cmd.id,
      name: rec.cmd.name,
      contextPath: rec.contextPath,
      contextId: rec.contextId,
    })),
    remaining: g.tokens.length - buffer.length,
  });

  if (exact.length > 0) {
    const triggered = [];
    for (const g of exact) {
      for (const rec of g.commands) {
        triggered.push({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          description: rec.cmd.description || '',
          contextPath: rec.contextPath,
          sequenceLabel: g.label,
          duplicate: g.duplicate,
        });
      }
    }
    // 精确命中的同时若仍是更长序列前缀，给出提示候选
    return {
      status: 'triggered',
      buffer,
      bufferLabel,
      triggered,
      candidates: prefixed.map(toCandidate),
      effective: eff,
    };
  }

  if (prefixed.length > 0 && buffer.length < MAX_PRESSES) {
    return {
      status: 'waiting',
      buffer,
      bufferLabel,
      triggered: [],
      candidates: prefixed.map(toCandidate).sort((a, b) => a.remaining - b.remaining),
      effective: eff,
    };
  }

  return { status: 'no-match', buffer, bufferLabel, triggered: [], candidates: [], effective: eff };
}

/** 收集某上下文子树内的全部叶子上下文（无子上下文） */
function descendantLeaves(index, contextId) {
  const start = index.byId.get(contextId);
  if (!start) return [];
  const out = [];
  const walk = (node) => {
    if (node.children.length === 0) out.push(node);
    else node.children.forEach(walk);
  };
  walk(start);
  return out;
}

/**
 * 冲突的稳定身份：同一组命令形成的冲突在不同叶子下视为同一个测试目标。
 * - duplicate：dup:<双方命令id排序>
 * - prefix：pre:<前缀方命令id排序>::<延伸方命令id排序>
 */
function conflictGoalId(conflict) {
  if (conflict.type === 'duplicate') {
    const ids = conflict.parties.map((p) => p.commandId).sort();
    return `dup:${ids.join(',')}`;
  }
  const prefixIds = conflict.parties
    .filter((p) => p.role === 'prefix')
    .map((p) => p.commandId)
    .sort();
  const extensionIds = conflict.parties
    .filter((p) => p.role === 'extension')
    .map((p) => p.commandId)
    .sort();
  return `pre:${prefixIds.join(',')}::${extensionIds.join(',')}`;
}

function setCoversAll(container, subset) {
  for (const g of subset) if (!container.has(g)) return false;
  return true;
}

/** 路径数组字典序比较（排序后比较；短前缀更小） */
function lexLessPaths(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return a.length < b.length;
}

/**
 * 精确集合覆盖：在候选集合中找出覆盖 universe 所需候选数量最少的组合。
 * candidates 已按 contextPath 字典序升序排列；同解（数量相同）时保留
 * 入选路径排序后字典序最小的组合，保证结果稳定、与数据顺序无关。
 * 分支限界（MRV 选目标 + 覆盖数下界 + 贪心初始上界 + 记忆剪枝），精确求解。
 */
function minimumSetCover(candidates, universe) {
  if (universe.size === 0 || candidates.length === 0) return [];

  // 按路径字典序排序，使支配精简与平局判定不依赖调用方的传入顺序
  const sorted = candidates
    .slice()
    .sort((a, b) => (a.contextPath < b.contextPath ? -1 : a.contextPath > b.contextPath ? 1 : 0));

  // 支配精简：仅允许“路径字典序更小且覆盖为超集”的候选淘汰后者，
  // 这样不会丢掉可能构成字典序更优同解的候选。
  const alive = sorted.map(() => true);
  for (let b = 1; b < sorted.length; b++) {
    for (let a = 0; a < b; a++) {
      if (alive[a] && setCoversAll(sorted[a].covers, sorted[b].covers)) {
        alive[b] = false;
        break;
      }
    }
  }
  const sets = sorted.filter((_, i) => alive[i]);

  // 贪心求一个可行上界（同等新增覆盖数时取路径更小者）
  const greedyPick = () => {
    const remaining = new Set(universe);
    const picked = [];
    while (remaining.size > 0) {
      let bestIdx = -1;
      let bestCount = -1;
      sets.forEach((c, ci) => {
        let n = 0;
        for (const g of c.covers) if (remaining.has(g)) n++;
        if (
          n > bestCount ||
          (n === bestCount && bestIdx >= 0 && c.contextPath < sets[bestIdx].contextPath)
        ) {
          bestIdx = ci;
          bestCount = n;
        }
      });
      picked.push(bestIdx);
      for (const g of sets[bestIdx].covers) remaining.delete(g);
    }
    return picked;
  };

  let bestChosen = greedyPick();
  let bestPaths = bestChosen.map((ci) => sets[ci].contextPath).sort();
  const chosen = [];
  const memo = new Map(); // remaining 签名 -> 到达它时最少的已选数量（仅严格更劣才剪枝）

  const consider = () => {
    const paths = chosen.map((ci) => sets[ci].contextPath).sort();
    if (paths.length < bestPaths.length || (paths.length === bestPaths.length && lexLessPaths(paths, bestPaths))) {
      bestPaths = paths;
      bestChosen = chosen.slice();
    }
  };

  const dfs = (remaining) => {
    if (remaining.size === 0) {
      consider();
      return;
    }
    const key = [...remaining].sort().join('|');
    const prevDepth = memo.get(key);
    if (prevDepth !== undefined && prevDepth < chosen.length) return;
    memo.set(key, chosen.length);

    // 下界：剩余目标数 / 单集合最大新增覆盖数
    let maxCoverage = 0;
    for (const c of sets) {
      let n = 0;
      for (const g of c.covers) if (remaining.has(g)) n++;
      if (n > maxCoverage) maxCoverage = n;
    }
    if (chosen.length + Math.ceil(remaining.size / maxCoverage) > bestPaths.length) return;

    // MRV：选能覆盖它的候选数最少的未覆盖目标分支；候选保持路径字典序
    let branchSets = null;
    for (const goal of remaining) {
      const cs = [];
      sets.forEach((c, ci) => {
        if (c.covers.has(goal)) cs.push(ci);
      });
      if (!branchSets || cs.length < branchSets.length) {
        branchSets = cs;
        if (cs.length === 1) break;
      }
    }

    for (const ci of branchSets) {
      chosen.push(ci);
      const next = new Set(remaining);
      for (const g of sets[ci].covers) next.delete(g);
      dfs(next);
      chosen.pop();
    }
  };

  dfs(new Set(universe));
  return bestChosen.map((ci) => sets[ci]);
}

/**
 * 收集命令在全部叶子上下文的可触发性（回归套件与变更沙盒预演共用）：
 * - triggerable：至少在一个叶子生效（非 shadowed）的命令 id 集合
 * - unreachable：任何叶子都无法触发的命令及原因（shadowed 时给出全部覆盖位置）
 */
function collectTriggerability(state) {
  const index = buildIndex(state.contexts);
  const leaves = [...index.byId.values()]
    .filter((c) => c.children.length === 0)
    .map((c) => ({ id: c.id, path: contextPath(index, c.id) }))
    .sort((a, b) => (a.path === b.path ? (a.id < b.id ? -1 : 1) : a.path < b.path ? -1 : 1));

  const triggerLeafIds = new Map(); // commandId -> 可触发它的叶子 id 列表
  const shadowerCounter = new Map(); // commandId -> Map(覆盖者 contextId -> 叶子数)

  for (const leaf of leaves) {
    const eff = computeEffective(state, leaf.id);
    for (const e of eff.entries) {
      if (e.state === 'shadowed') {
        if (e.shadowedBy) {
          if (!shadowerCounter.has(e.commandId)) shadowerCounter.set(e.commandId, new Map());
          const m = shadowerCounter.get(e.commandId);
          m.set(e.shadowedBy, (m.get(e.shadowedBy) || 0) + 1);
        }
      } else if (!triggerLeafIds.has(e.commandId)) {
        triggerLeafIds.set(e.commandId, [leaf.id]);
      } else {
        triggerLeafIds.get(e.commandId).push(leaf.id);
      }
    }
  }

  const unreachable = [];
  for (const cmd of state.commands) {
    if (triggerLeafIds.has(cmd.id)) continue;
    const leavesUnder = descendantLeaves(index, cmd.contextId);
    let reason;
    let shadowedBy = [];
    if (leavesUnder.length === 0) {
      reason = '所属上下文的子树中不存在叶子上下文，没有可执行该命令的测试位置';
    } else {
      const m = shadowerCounter.get(cmd.id);
      if (m && m.size > 0) {
        shadowedBy = [...m.keys()]
          .map((sid) => ({ contextId: sid, contextPath: contextPath(index, sid) }))
          .sort((a, b) => (a.contextPath < b.contextPath ? -1 : a.contextPath > b.contextPath ? 1 : 0));
        reason =
          `序列「${cmd.sequenceLabel}」在所属上下文（${contextPath(index, cmd.contextId)}）子树下的全部 ` +
          `${leavesUnder.length} 个叶子上下文中均被更近祖先的同序列绑定覆盖（shadowed，覆盖位置：` +
          `${shadowedBy.map((s) => s.contextPath).join('、')}），任何叶子都无法触发该命令`;
      } else {
        reason = '该命令未出现在任何叶子上下文的生效绑定中，无法从叶子上下文触发';
      }
    }
    unreachable.push({
      commandId: cmd.id,
      name: cmd.name,
      description: cmd.description || '',
      contextId: cmd.contextId,
      contextPath: contextPath(index, cmd.contextId),
      sequenceTokens: cmd.sequenceTokens,
      sequenceLabel: cmd.sequenceLabel,
      reason,
      shadowedBy,
    });
  }
  unreachable.sort((a, b) =>
    a.contextPath === b.contextPath
      ? a.sequenceLabel.localeCompare(b.sequenceLabel) || (a.commandId < b.commandId ? -1 : 1)
      : a.contextPath < b.contextPath
        ? -1
        : 1,
  );

  return { leaves, triggerable: new Set(triggerLeafIds.keys()), unreachable };
}

/**
 * 回归套件生成：
 * 1. 以全部叶子上下文为候选，复用 computeEffective 的生效规则；
 * 2. 测试目标 = 每条可在某个叶子触发的命令 + 每个可在某个叶子观察到的
 *    同层重复（duplicate）/ 前缀冲突（prefix），冲突以参与命令集合判定身份；
 * 3. 精确集合覆盖选出叶子数量最少的套件，同解按上下文路径字典序稳定选择；
 * 4. 任何叶子都无法触发的命令列入 unreachableCommands 并给出原因，不计入覆盖。
 */
function generateRegressionSuite(state) {
  const { leaves, triggerable, unreachable: unreachableCommands } = collectTriggerability(state);

  // 每个叶子跑一次现有审校规则
  const reviews = leaves.map((leaf) => ({ leaf, eff: computeEffective(state, leaf.id) }));

  const conflictGoals = new Map(); // goalId -> 冲突对象（代表）

  for (const { eff } of reviews) {
    for (const c of eff.conflicts) {
      const goalId = conflictGoalId(c);
      if (!conflictGoals.has(goalId)) conflictGoals.set(goalId, c);
    }
  }

  // 覆盖目标全集：可触发命令 + 叶子可见冲突
  const universe = new Set();
  for (const id of triggerable) universe.add(`cmd:${id}`);
  for (const id of conflictGoals.keys()) universe.add(id);

  // 候选叶子及其覆盖的目标集合
  const candidates = reviews
    .map(({ leaf, eff }) => {
      const covers = new Set();
      for (const e of eff.entries) {
        if (e.state !== 'shadowed') covers.add(`cmd:${e.commandId}`);
      }
      for (const c of eff.conflicts) covers.add(conflictGoalId(c));
      return { contextId: leaf.id, contextPath: leaf.path, covers, eff };
    })
    .filter((c) => c.covers.size > 0);
  // leaves 已按路径排序，candidates 保持路径字典序，供集合覆盖平局判定使用

  const selected = minimumSetCover(candidates, universe);
  const selectedIds = new Set(selected.map((c) => c.contextId));

  const suite = selected.map((c) => {
    const eff = c.eff;
    const inputs = eff.effectiveGroups
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((g) => ({
        sequenceLabel: g.label,
        sequenceTokens: g.tokens,
        duplicate: g.duplicate,
        expectedCommands: g.commands
          .map((rec) => ({
            commandId: rec.cmd.id,
            name: rec.cmd.name,
            contextPath: rec.contextPath,
          }))
          .sort((a, b) => a.name.localeCompare(b.name) || (a.commandId < b.commandId ? -1 : 1)),
      }));
    return {
      contextId: c.contextId,
      contextPath: c.contextPath,
      inputs,
      expectedConflicts: eff.conflicts,
      coveredGoals: [...c.covers].sort(),
    };
  });
  suite.sort((a, b) => (a.contextPath < b.contextPath ? -1 : a.contextPath > b.contextPath ? 1 : 0));

  let duplicateConflictCount = 0;
  let prefixConflictCount = 0;
  for (const c of conflictGoals.values()) {
    if (c.type === 'duplicate') duplicateConflictCount++;
    else prefixConflictCount++;
  }

  const coveredGoals = new Set();
  for (const c of selected) for (const g of c.covers) coveredGoals.add(g);
  const coveredCommandCount = [...coveredGoals].filter((g) => g.startsWith('cmd:')).length;

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      leafCount: leaves.length,
      candidateCount: candidates.length,
      selectedContextCount: suite.length,
      commandCount: state.commands.length,
      triggerableCommandCount: triggerable.size,
      coveredCommandCount,
      unreachableCommandCount: unreachableCommands.length,
      conflictCount: conflictGoals.size,
      duplicateConflictCount,
      prefixConflictCount,
      inputSequenceCount: suite.reduce((n, tc) => n + tc.inputs.length, 0),
      coverableGoalCount: universe.size,
      coveredGoalCount: coveredGoals.size,
    },
    suite,
    candidates: candidates.map((c) => ({
      contextId: c.contextId,
      contextPath: c.contextPath,
      goalCount: c.covers.size,
      selected: selectedIds.has(c.contextId),
    })),
    unreachableCommands,
  };
}

function pressToPretty(token) {
  const MOD_PRETTY = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
  return token
    .split('+')
    .map((p) => (MOD_PRETTY[p] ? MOD_PRETTY[p] : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
}

// ==================== 变更沙盒（草案预演，只读） ====================

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** 路径字典序比较（相同路径再按 id，保证稳定） */
function comparePathId(a, b) {
  if (a.contextPath < b.contextPath) return -1;
  if (a.contextPath > b.contextPath) return 1;
  return a.contextId < b.contextId ? -1 : a.contextId > b.contextId ? 1 : 0;
}

/** 冲突参与方的稳定排序键：duplicate 无 role，prefix 先按角色再按 id */
function roleRank(role) {
  if (role === 'prefix') return 0;
  if (role === 'extension') return 1;
  return 2;
}

/**
 * 规范化并校验草案（纯函数，不触碰数据文件）。
 * draft: { creates: [{clientId, contextId, name, sequence, description}],
 *          updates: [{commandId, name?, sequence?, contextId?, description?}],
 *          deletes: [commandId] }
 * 返回规范化后的 { creates, updates, deletes }；不合法抛 400。
 */
function normalizeDraft(state, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('草案必须是一个对象');
  const { creates: rawCreates, updates: rawUpdates, deletes: rawDeletes } = raw;
  if (rawCreates !== undefined && !Array.isArray(rawCreates)) throw badRequest('creates 必须是数组');
  if (rawUpdates !== undefined && !Array.isArray(rawUpdates)) throw badRequest('updates 必须是数组');
  if (rawDeletes !== undefined && !Array.isArray(rawDeletes)) throw badRequest('deletes 必须是数组');

  const contextIds = new Set(state.contexts.map((c) => c.id));
  const existingIds = new Set(state.commands.map((c) => c.id));

  const creates = [];
  const createClients = new Set();
  for (const item of rawCreates || []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest('creates 的每一项必须是对象');
    const clientId = String(item.clientId == null ? '' : item.clientId).trim();
    if (!clientId) throw badRequest('新增命令缺少 clientId（草案内的稳定身份）');
    if (createClients.has(clientId)) throw badRequest(`草案中存在重复的新增身份：${clientId}`);
    if (existingIds.has(clientId)) throw badRequest(`新增身份 ${clientId} 与现有命令 id 冲突`);
    createClients.add(clientId);
    const contextId = String(item.contextId == null ? '' : item.contextId);
    if (!contextIds.has(contextId)) throw badRequest(`新增命令「${clientId}」引用了不存在的上下文：${contextId}`);
    const name = String(item.name == null ? '' : item.name).trim();
    if (!name) throw badRequest(`新增命令「${clientId}」名称不能为空`);
    const sequence = String(item.sequence == null ? '' : item.sequence);
    const parsed = parseSequence(sequence);
    if (!parsed.ok) throw badRequest(`新增命令「${name}」的序列不合法：${parsed.error}`);
    creates.push({
      op: 'create',
      clientId,
      contextId,
      name,
      description: String(item.description == null ? '' : item.description),
      sequenceRaw: sequence,
      sequenceTokens: parsed.tokens,
      sequenceLabel: parsed.label,
    });
  }
  creates.sort((a, b) => (a.clientId < b.clientId ? -1 : 1));

  const updates = [];
  const updateIds = new Set();
  for (const item of rawUpdates || []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest('updates 的每一项必须是对象');
    const commandId = String(item.commandId == null ? '' : item.commandId);
    if (!commandId) throw badRequest('改序列/改属性缺少 commandId');
    if (!existingIds.has(commandId)) throw badRequest(`要修改的命令不存在：${commandId}`);
    if (updateIds.has(commandId)) throw badRequest(`命令 ${commandId} 在草案中出现了多次修改（请合并为一项）`);
    updateIds.add(commandId);

    const patch = {};
    if (item.name !== undefined) {
      const name = String(item.name).trim();
      if (!name) throw badRequest(`命令 ${commandId} 的新名称不能为空`);
      patch.name = name;
    }
    if (item.description !== undefined) patch.description = String(item.description);
    if (item.contextId !== undefined) {
      const contextId = String(item.contextId);
      if (!contextIds.has(contextId)) throw badRequest(`命令 ${commandId} 要移动到不存在的上下文：${contextId}`);
      patch.contextId = contextId;
    }
    if (item.sequence !== undefined) {
      const parsed = parseSequence(String(item.sequence));
      if (!parsed.ok) throw badRequest(`命令 ${commandId} 的新序列不合法：${parsed.error}`);
      patch.sequenceRaw = String(item.sequence);
      patch.sequenceTokens = parsed.tokens;
      patch.sequenceLabel = parsed.label;
    }
    updates.push({ op: 'update', commandId, patch });
  }
  updates.sort((a, b) => (a.commandId < b.commandId ? -1 : 1));

  const deletes = [];
  const deleteIds = new Set();
  for (const rawId of rawDeletes || []) {
    const commandId = String(rawId == null ? '' : rawId);
    if (!commandId) throw badRequest('删除列表中存在空命令 id');
    if (!existingIds.has(commandId)) throw badRequest(`要删除的命令不存在：${commandId}`);
    if (deleteIds.has(commandId)) throw badRequest(`删除列表中命令 ${commandId} 重复`);
    deleteIds.add(commandId);
    deletes.push(commandId);
  }
  deletes.sort();

  for (const id of deletes) {
    if (updateIds.has(id)) throw badRequest(`命令 ${id} 同时被修改和删除（请只保留一种操作）`);
  }

  return { creates, updates, deletes };
}

/** 在内存中把规范化草案应用到基线状态，返回模拟状态与操作清单（不写任何文件） */
function applyDraft(state, draft) {
  const commands = state.commands.map((c) => ({ ...c }));
  const byId = new Map(commands.map((c) => [c.id, c]));

  for (const c of draft.creates) {
    const cmd = {
      id: c.clientId,
      contextId: c.contextId,
      name: c.name,
      description: c.description,
      sequenceRaw: c.sequenceRaw,
      sequenceTokens: [...c.sequenceTokens],
      sequenceLabel: c.sequenceLabel,
      _sandboxCreated: true,
    };
    commands.push(cmd);
    byId.set(cmd.id, cmd);
  }
  for (const u of draft.updates) {
    const cmd = byId.get(u.commandId);
    if (u.patch.name !== undefined) cmd.name = u.patch.name;
    if (u.patch.description !== undefined) cmd.description = u.patch.description;
    if (u.patch.contextId !== undefined) cmd.contextId = u.patch.contextId;
    if (u.patch.sequenceRaw !== undefined) {
      cmd.sequenceRaw = u.patch.sequenceRaw;
      cmd.sequenceTokens = [...u.patch.sequenceTokens];
      cmd.sequenceLabel = u.patch.sequenceLabel;
    }
  }
  const deleteSet = new Set(draft.deletes);

  return {
    contexts: state.contexts.map((c) => ({ ...c })),
    commands: commands.filter((c) => !deleteSet.has(c.id)),
  };
}

/** 冲突参与方输出（稳定排序，不依赖数据/返回顺序） */
function conflictPartiesPayload(effConflict) {
  return effConflict.parties
    .map((p) => ({
      commandId: p.commandId,
      name: p.name,
      contextId: p.contextId,
      contextPath: p.contextPath,
      role: p.role || null,
      shortestLabel: p.shortestLabel,
      sequenceLabel: p.sequenceLabel,
    }))
    .sort((a, b) => roleRank(a.role) - roleRank(b.role) || (a.commandId < b.commandId ? -1 : 1));
}

/** 冲突完整载荷（用于新增/消失/仍在但有变化） */
function conflictPayload(effConflict) {
  const base = {
    goalId: conflictGoalId(effConflict),
    type: effConflict.type,
    kindLabel: effConflict.kindLabel,
    parties: conflictPartiesPayload(effConflict),
  };
  if (effConflict.type === 'prefix') {
    return {
      ...base,
      prefixSequenceLabel: effConflict.prefixSequenceLabel,
      extensionSequenceLabel: effConflict.extensionSequenceLabel,
      prefixTokens: [...effConflict.prefixTokens],
      extensionTokens: [...effConflict.extensionTokens],
    };
  }
  return {
    ...base,
    sequenceLabel: effConflict.sequenceLabel,
    sequenceTokens: [...effConflict.sequenceTokens],
  };
}

/**
 * 为某份状态的每个上下文收集：
 *   bindings: 生效绑定 Map(commandId -> 载荷)
 *   shadows:  shadowed 绑定 Map(commandId -> 载荷)
 *   conflicts: 冲突 Map(稳定身份 goalId -> 载荷)
 * 命令 id 是绑定的稳定身份；冲突以参与命令集合作为稳定身份。
 */
function collectContextSnapshot(state, index) {
  const snapshots = new Map();
  for (const ctx of state.contexts) {
    const eff = computeEffective(state, ctx.id);
    const bindings = new Map();
    const shadows = new Map();
    for (const e of eff.entries) {
      const payload = {
        commandId: e.commandId,
        name: e.name,
        contextId: e.contextId,
        contextPath: e.contextPath,
        sequenceTokens: [...e.sequenceTokens],
        sequenceLabel: e.sequenceLabel,
        shortestLabel: e.sequenceLabel,
        state: e.state,
        duplicate: e.duplicate,
        prefix: e.prefix,
      };
      if (e.state === 'shadowed') {
        payload.shadowedBy = e.shadowedBy;
        shadows.set(e.commandId, payload);
      } else {
        bindings.set(e.commandId, payload);
      }
    }
    const conflicts = new Map();
    for (const c of eff.conflicts) {
      conflicts.set(conflictGoalId(c), conflictPayload(c));
    }
    snapshots.set(ctx.id, {
      contextId: ctx.id,
      contextPath: contextPath(index, ctx.id),
      bindings,
      shadows,
      conflicts,
    });
  }
  return snapshots;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stableJson(value[k]);
    return out;
  }
  return value;
}

/** 载荷签名：参与命令集合 / 来源路径 / 最短触发输入等任一变化都会体现 */
function payloadSignature(payload) {
  return JSON.stringify(stableJson(payload));
}

function comparePayload(kind, a, b) {
  if (kind === 'bindings' || kind === 'shadows') {
    return (
      a.sequenceLabel.localeCompare(b.sequenceLabel) ||
      comparePathId(a, b) ||
      (a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0)
    );
  }
  // conflicts：按类型稳定排列，再按身份
  const ta = a.type === 'duplicate' ? 0 : 1;
  const tb = b.type === 'duplicate' ? 0 : 1;
  return ta - tb || (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0);
}

/**
 * 通用差异计算：以稳定身份配对两个 Map，
 * 输出新增 added / 消失 removed / 身份不变但载荷变化 changed。
 */
function diffMaps(baseMap, simMap) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, payload] of simMap) {
    const before = baseMap.get(id);
    if (!before) added.push(payload);
    else if (payloadSignature(before) !== payloadSignature(payload)) {
      changed.push({ before, after: payload });
    }
  }
  for (const [id, payload] of baseMap) {
    if (!simMap.has(id)) removed.push(payload);
  }
  return { added, removed, changed };
}

function sortDiff(kind, diff) {
  diff.added.sort((a, b) => comparePayload(kind, a, b));
  diff.removed.sort((a, b) => comparePayload(kind, a, b));
  diff.changed.sort((a, b) => comparePayload(kind, a.after, b.after));
}

/**
 * 变更沙盒预演：在同一份草案上分别计算基线状态与模拟状态，
 * 按上下文汇总生效绑定 / shadowed / duplicate / prefix 的新增与消失，
 * 并给出全局不可触发命令的新增与消失。所有结果使用稳定身份配对，
 * 排序确定，不受数据顺序或入参数组顺序影响。只读，不写数据文件。
 */
function previewSandbox(state, rawDraft) {
  const draft = normalizeDraft(state, rawDraft);
  const simulated = applyDraft(state, draft);

  const baseIndex = buildIndex(state.contexts);
  const simIndex = buildIndex(simulated.contexts);
  const baseSnap = collectContextSnapshot(state, baseIndex);
  const simSnap = collectContextSnapshot(simulated, simIndex);

  const contexts = [];
  const totals = {
    bindingsAdded: 0,
    bindingsRemoved: 0,
    bindingsChanged: 0,
    shadowsAdded: 0,
    shadowsRemoved: 0,
    duplicateAdded: 0,
    duplicateRemoved: 0,
    duplicateChanged: 0,
    prefixAdded: 0,
    prefixRemoved: 0,
    prefixChanged: 0,
  };

  // 上下文身份以 id 为准（草案不支持改上下文树）；路径用模拟状态（命名相同）
  for (const ctx of simulated.contexts) {
    const before = baseSnap.get(ctx.id);
    const after = simSnap.get(ctx.id);
    const bindingDiff = diffMaps(before.bindings, after.bindings);
    const shadowDiff = diffMaps(before.shadows, after.shadows);
    const conflictDiff = diffMaps(before.conflicts, after.conflicts);
    sortDiff('bindings', bindingDiff);
    sortDiff('shadows', shadowDiff);
    sortDiff('conflicts', conflictDiff);

    const dupAdded = conflictDiff.added.filter((c) => c.type === 'duplicate');
    const dupRemoved = conflictDiff.removed.filter((c) => c.type === 'duplicate');
    const dupChanged = conflictDiff.changed.filter((ch) => ch.after.type === 'duplicate');
    const preAdded = conflictDiff.added.filter((c) => c.type === 'prefix');
    const preRemoved = conflictDiff.removed.filter((c) => c.type === 'prefix');
    const preChanged = conflictDiff.changed.filter((ch) => ch.after.type === 'prefix');

    const hasDiff =
      bindingDiff.added.length +
        bindingDiff.removed.length +
        bindingDiff.changed.length +
        shadowDiff.added.length +
        shadowDiff.removed.length +
        conflictDiff.added.length +
        conflictDiff.removed.length +
        conflictDiff.changed.length >
      0;
    if (!hasDiff) continue;

    totals.bindingsAdded += bindingDiff.added.length;
    totals.bindingsRemoved += bindingDiff.removed.length;
    totals.bindingsChanged += bindingDiff.changed.length;
    totals.shadowsAdded += shadowDiff.added.length;
    totals.shadowsRemoved += shadowDiff.removed.length;
    totals.duplicateAdded += dupAdded.length;
    totals.duplicateRemoved += dupRemoved.length;
    totals.duplicateChanged += dupChanged.length;
    totals.prefixAdded += preAdded.length;
    totals.prefixRemoved += preRemoved.length;
    totals.prefixChanged += preChanged.length;

    contexts.push({
      contextId: ctx.id,
      contextPath: contextPath(simIndex, ctx.id),
      effectiveBindings: bindingDiff,
      shadowed: {
        added: shadowDiff.added,
        removed: shadowDiff.removed,
      },
      duplicates: { added: dupAdded, removed: dupRemoved, changed: dupChanged },
      prefixes: { added: preAdded, removed: preRemoved, changed: preChanged },
    });
  }
  contexts.sort(comparePathId);

  // 不可触发命令（全局；上下文树未变更，叶子集合相同）
  const baseUnreach = collectTriggerability(state).unreachable;
  const simUnreach = collectTriggerability(simulated).unreachable;
  const baseUnreachMap = new Map(baseUnreach.map((u) => [u.commandId, u]));
  const simUnreachMap = new Map(simUnreach.map((u) => [u.commandId, u]));
  const unreachableAdded = [];
  const unreachableRemoved = [];
  for (const [id, payload] of simUnreachMap) {
    if (!baseUnreachMap.has(id)) unreachableAdded.push(payload);
  }
  for (const [id, payload] of baseUnreachMap) {
    if (!simUnreachMap.has(id)) unreachableRemoved.push(payload);
  }
  const cmpUnreachable = (a, b) =>
    comparePathId(a, b) ||
    a.sequenceLabel.localeCompare(b.sequenceLabel) ||
    (a.commandId < b.commandId ? -1 : 1);
  unreachableAdded.sort(cmpUnreachable);
  unreachableRemoved.sort(cmpUnreachable);

  return {
    generatedAt: new Date().toISOString(),
    draft: {
      creates: draft.creates.map((c) => ({
        clientId: c.clientId,
        contextId: c.contextId,
        name: c.name,
        description: c.description,
        sequenceRaw: c.sequenceRaw,
        sequenceTokens: c.sequenceTokens,
        sequenceLabel: c.sequenceLabel,
      })),
      updates: draft.updates.map((u) => ({
        commandId: u.commandId,
        patch: u.patch,
      })),
      deletes: draft.deletes,
    },
    stats: {
      ...totals,
      contextCount: contexts.length,
      commandCountBefore: state.commands.length,
      commandCountAfter: simulated.commands.length,
      createCount: draft.creates.length,
      updateCount: draft.updates.length,
      deleteCount: draft.deletes.length,
      unreachableBefore: baseUnreach.length,
      unreachableAfter: simUnreach.length,
      unreachableAdded: unreachableAdded.length,
      unreachableRemoved: unreachableRemoved.length,
    },
    contexts,
    unreachable: {
      added: unreachableAdded,
      removed: unreachableRemoved,
    },
  };
}

module.exports = {
  MAX_PRESSES,
  canonicalPress,
  parseSequence,
  seqKey,
  isPrefix,
  buildIndex,
  ancestorChain,
  contextPath,
  computeEffective,
  evaluateKey,
  descendantLeaves,
  conflictGoalId,
  minimumSetCover,
  generateRegressionSuite,
  collectTriggerability,
  normalizeDraft,
  previewSandbox,
};
