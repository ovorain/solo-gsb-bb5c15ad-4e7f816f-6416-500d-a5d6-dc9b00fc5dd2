import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';

const STORAGE_KEY = 'shortcut-sandbox-draft-v1';

// ---------- 草案（仅存浏览器 localStorage） ----------

function emptyDraft() {
  return { creates: [], updates: [], deletes: [] };
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyDraft();
    const parsed = JSON.parse(raw);
    return {
      creates: Array.isArray(parsed.creates) ? parsed.creates : [],
      updates: Array.isArray(parsed.updates) ? parsed.updates : [],
      deletes: Array.isArray(parsed.deletes) ? parsed.deletes : [],
    };
  } catch {
    return emptyDraft();
  }
}

function newClientId() {
  if (window.crypto?.randomUUID) return 'new-' + window.crypto.randomUUID();
  return 'new-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

// ---------- 小组件 ----------

function DiffTag({ tone, children }) {
  return <span className={`sb-diff-tag ${tone}`}>{children}</span>;
}

function PartyList({ parties }) {
  return (
    <ul className="sb-parties">
      {parties.map((p) => (
        <li key={p.commandId + '|' + (p.role || '')}>
          {p.role && (
            <span className={`role-tag ${p.role === 'extension' ? 'extension' : ''}`}>
              {p.role === 'prefix' ? '前缀方' : '延伸方'}
            </span>
          )}
          <span className="party-name">{p.name}</span>
          <span className="party-source" title="来源（上下文路径）">
            来源：{p.contextPath}
          </span>
          <span className="party-trigger" title="最短触发输入">
            最短触发：<kbd>{p.shortestLabel || p.sequenceLabel}</kbd>
          </span>
        </li>
      ))}
    </ul>
  );
}

function BindingItem({ item }) {
  return (
    <div className="sb-item">
      <span className="sb-seq-wrap">
        <kbd className="seq">{item.sequenceLabel}</kbd>
      </span>
      <span className="party-name">{item.name}</span>
      <span className="party-source" title="来源（上下文路径）">
        来源：{item.contextPath}
      </span>
      {item.duplicate && <span className="badge duplicate">同层重复</span>}
      {item.prefix === 'prefix' && <span className="badge prefix">他序列前缀</span>}
      {item.prefix === 'extension' && <span className="badge prefix">前缀延伸</span>}
    </div>
  );
}

function BindingChangeItem({ change }) {
  const { before, after } = change;
  return (
    <div className="sb-item sb-item-change">
      <span className="sb-seq-wrap">
        <kbd className="seq dim">{before.sequenceLabel}</kbd>
        <span className="sb-arrow">→</span>
        <kbd className="seq">{after.sequenceLabel}</kbd>
      </span>
      <span className="party-name">{after.name}</span>
      <span className="party-source" title="来源（上下文路径）">
        来源：{before.contextPath === after.contextPath ? after.contextPath : (
          <>
            <span className="dim">{before.contextPath}</span> → {after.contextPath}
          </>
        )}
      </span>
      {after.duplicate && <span className="badge duplicate">同层重复</span>}
      {after.prefix === 'prefix' && <span className="badge prefix">他序列前缀</span>}
      {after.prefix === 'extension' && <span className="badge prefix">前缀延伸</span>}
    </div>
  );
}

function ConflictItem({ item }) {
  return (
    <div className={`sb-item sb-item-conflict ${item.type}`}>
      <span className="sb-conflict-head">
        {item.type === 'prefix' ? (
          <>
            <span className="role-tag">前缀冲突</span>
            <kbd>{item.prefixSequenceLabel}</kbd>
            <em className="dim"> ⊂ </em>
            <kbd>{item.extensionSequenceLabel}</kbd>
          </>
        ) : (
          <>
            <span className="role-tag dup-role">同层重复</span>
            <kbd>{item.sequenceLabel}</kbd>
          </>
        )}
      </span>
      <PartyList parties={item.parties} />
    </div>
  );
}

function conflictHeadText(item) {
  return item.type === 'prefix'
    ? `${item.prefixSequenceLabel} ⊂ ${item.extensionSequenceLabel}`
    : item.sequenceLabel;
}

function ConflictChangeItem({ change }) {
  const { before, after } = change;
  return (
    <div className={`sb-item sb-item-conflict sb-item-change ${after.type}`}>
      <span className="sb-conflict-head">
        {after.type === 'prefix' ? <span className="role-tag">前缀冲突</span> : <span className="role-tag dup-role">同层重复</span>}
        <span className="dim small">参与命令集合不变，细节变化：</span>
        <kbd className="dim">{conflictHeadText(before)}</kbd>
        <span className="sb-arrow">→</span>
        <kbd>{conflictHeadText(after)}</kbd>
      </span>
      <div className="dim small">变化后参与方：</div>
      <PartyList parties={after.parties} />
    </div>
  );
}

function DiffBucket({ title, tone, items, renderItem, empty }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="sb-bucket">
      <div className="sb-bucket-head">
        <DiffTag tone={tone}>{title}</DiffTag>
        <span className="dim small">{items.length}</span>
      </div>
      <div className="sb-bucket-body">
        {items.map((it, i) => {
          const target = it.after || it;
          const key = target.commandId || target.goalId || JSON.stringify(target.sequenceTokens) + ':' + i;
          return <React.Fragment key={key}>{renderItem(it)}</React.Fragment>;
        })}
        {items.length === 0 && <span className="dim small">{empty}</span>}
      </div>
    </div>
  );
}

function ContextDiffCard({ ctx }) {
  const eb = ctx.effectiveBindings;
  return (
    <div className="sb-context-card">
      <div className="sb-context-head" title={ctx.contextPath}>
        📁 {ctx.contextPath}
      </div>
      <div className="sb-bucket-grid">
        <DiffBucket title="生效绑定 · 新增" tone="add" items={eb.added} renderItem={(it) => <BindingItem item={it} />} />
        <DiffBucket title="生效绑定 · 消失" tone="remove" items={eb.removed} renderItem={(it) => <BindingItem item={it} />} />
        <DiffBucket
          title="生效绑定 · 变化（序列/来源）"
          tone="change"
          items={eb.changed}
          renderItem={(it) => <BindingChangeItem change={it} />}
        />
        <DiffBucket
          title="shadowed · 新增（新被覆盖）"
          tone="add"
          items={ctx.shadowed.added}
          renderItem={(it) => <BindingItem item={it} />}
        />
        <DiffBucket
          title="shadowed · 消失（恢复生效/删除）"
          tone="remove"
          items={ctx.shadowed.removed}
          renderItem={(it) => <BindingItem item={it} />}
        />
        <DiffBucket title="同层重复 duplicate · 新增" tone="add" items={ctx.duplicates.added} renderItem={(it) => <ConflictItem item={it} />} />
        <DiffBucket title="同层重复 duplicate · 消失" tone="remove" items={ctx.duplicates.removed} renderItem={(it) => <ConflictItem item={it} />} />
        <DiffBucket title="同层重复 duplicate · 细节变化" tone="change" items={ctx.duplicates.changed} renderItem={(it) => <ConflictChangeItem change={it} />} />
        <DiffBucket title="前缀冲突 prefix · 新增" tone="add" items={ctx.prefixes.added} renderItem={(it) => <ConflictItem item={it} />} />
        <DiffBucket title="前缀冲突 prefix · 消失" tone="remove" items={ctx.prefixes.removed} renderItem={(it) => <ConflictItem item={it} />} />
        <DiffBucket title="前缀冲突 prefix · 细节变化" tone="change" items={ctx.prefixes.changed} renderItem={(it) => <ConflictChangeItem change={it} />} />
      </div>
    </div>
  );
}

function StatCard({ value, label, tone = '' }) {
  return (
    <div className={`stat-card ${tone}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

// ---------- 暂存表单 ----------

function CreateForm({ contexts, contextPathOf, onAdd }) {
  const firstCtx = contexts[0]?.id || '';
  const [form, setForm] = useState({ contextId: firstCtx, name: '', sequence: '', description: '' });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!form.contextId && contexts[0]) setForm((f) => ({ ...f, contextId: contexts[0].id }));
  }, [contexts]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e) => {
    e.preventDefault();
    if (!form.contextId) {
      setError('请先选择所属上下文');
      return;
    }
    if (!form.name.trim()) {
      setError('命令名称不能为空');
      return;
    }
    if (!form.sequence.trim()) {
      setError('请输入按键序列');
      return;
    }
    onAdd({
      clientId: newClientId(),
      contextId: form.contextId,
      name: form.name.trim(),
      sequence: form.sequence,
      description: form.description,
    });
    setForm({ contextId: form.contextId, name: '', sequence: '', description: '' });
    setError('');
  };

  return (
    <form className="sb-create-form" onSubmit={submit}>
      <select value={form.contextId} onChange={(e) => setForm({ ...form, contextId: e.target.value })}>
        {contexts.map((c) => (
          <option key={c.id} value={c.id}>
            {contextPathOf(c.id)}
          </option>
        ))}
      </select>
      <input placeholder="新命令名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input
        className="seq-input"
        placeholder="按键序列（1~3 次，空格/逗号分隔，如 g l 或 Ctrl+K）"
        value={form.sequence}
        onChange={(e) => setForm({ ...form, sequence: e.target.value })}
      />
      <input
        placeholder="说明（可选）"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />
      <button type="submit" className="primary">
        暂存新增
      </button>
      {error && <p className="error">⚠ {error}</p>}
    </form>
  );
}

function UpdateForm({ baseline, contexts, contextPathOf, patch, onSave, onCancel }) {
  const [name, setName] = useState(patch.name ?? baseline.name);
  const [sequence, setSequence] = useState(patch.sequence ?? baseline.sequenceRaw);
  const [contextId, setContextId] = useState(patch.contextId ?? baseline.contextId);
  const [description, setDescription] = useState(patch.description ?? (baseline.description || ''));

  const save = () => {
    const nextPatch = {};
    if (name.trim() && name.trim() !== baseline.name) nextPatch.name = name.trim();
    if (sequence !== baseline.sequenceRaw) nextPatch.sequence = sequence;
    if (contextId !== baseline.contextId) nextPatch.contextId = contextId;
    if (description !== (baseline.description || '')) nextPatch.description = description;
    onSave(nextPatch);
  };

  return (
    <div className="sb-edit-form">
      <label className="sb-field">
        <span>名称</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="sb-field">
        <span>序列</span>
        <input className="seq-input" value={sequence} onChange={(e) => setSequence(e.target.value)} />
      </label>
      <label className="sb-field">
        <span>所属上下文</span>
        <select value={contextId} onChange={(e) => setContextId(e.target.value)}>
          {contexts.map((c) => (
            <option key={c.id} value={c.id}>
              {contextPathOf(c.id)}
            </option>
          ))}
        </select>
      </label>
      <label className="sb-field">
        <span>说明</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="form-row">
        <button className="primary" onClick={save}>
          保存暂存
        </button>
        <button onClick={onCancel}>取消</button>
      </div>
      <p className="hint small">
        基线：{baseline.name} · <kbd className="seq dim">{baseline.sequenceLabel}</kbd> · {contextPathOf(baseline.contextId)}
      </p>
    </div>
  );
}

// ---------- 主视图 ----------

export default function Sandbox() {
  const [state, setState] = useState({ contexts: [], commands: [] });
  const [draft, setDraft] = useState(emptyDraft);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [stateError, setStateError] = useState('');
  const [loadingState, setLoadingState] = useState(true);
  const [filterContext, setFilterContext] = useState('');
  const [editingCreate, setEditingCreate] = useState(null);
  const [editingUpdate, setEditingUpdate] = useState(null);

  const inflightRef = useRef(0);

  useEffect(() => {
    setDraft(loadDraft());
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const s = await api.getState();
      setState(s);
      setStateError('');
    } catch (err) {
      setStateError(err.message);
    } finally {
      setLoadingState(false);
    }
  }, []);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  // 草案持久化到浏览器（永不调用后端写接口）
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch {
      /* 存储不可用时仅影响持久化 */
    }
  }, [draft]);

  // 在同一份草案上预演（基线每次都从后端取最新快照，由服务端只读计算）
  const runPreview = useCallback(async (currentDraft) => {
    const seq = ++inflightRef.current;
    try {
      const result = await api.sandboxPreview(currentDraft);
      if (seq === inflightRef.current) {
        setPreview(result);
        setError('');
      }
    } catch (err) {
      if (seq === inflightRef.current) setError(err.message);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => runPreview(draft), 300);
    return () => clearTimeout(timer);
  }, [draft, runPreview]);

  // ---- 上下文工具 ----
  const contextPathOf = useMemo(() => {
    const byId = new Map(state.contexts.map((c) => [c.id, c]));
    const cache = new Map();
    const pathOf = (id) => {
      if (cache.has(id)) return cache.get(id);
      const chain = [];
      let cur = byId.get(id);
      const guard = new Set();
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        chain.push(cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
      const p = chain.reverse().join(' / ');
      cache.set(id, p);
      return p;
    };
    return pathOf;
  }, [state.contexts]);

  const baselineById = useMemo(() => new Map(state.commands.map((c) => [c.id, c])), [state.commands]);

  // ---- 草案操作 ----
  const addCreate = (item) => setDraft((d) => ({ ...d, creates: [...d.creates, item] }));

  const removeCreate = (clientId) => {
    setDraft((d) => ({ ...d, creates: d.creates.filter((c) => c.clientId !== clientId) }));
    setEditingCreate(null);
  };

  const saveCreate = (clientId, next) => {
    setDraft((d) => ({
      ...d,
      creates: d.creates.map((c) => (c.clientId === clientId ? { ...c, ...next } : c)),
    }));
    setEditingCreate(null);
  };

  const stageUpdate = (commandId, patch) => {
    if (Object.keys(patch).length === 0) {
      // 没有实际差异：撤掉已有暂存修改
      setDraft((d) => ({ ...d, updates: d.updates.filter((u) => u.commandId !== commandId) }));
    } else {
      setDraft((d) => {
        const exists = d.updates.some((u) => u.commandId === commandId);
        return {
          ...d,
          updates: exists
            ? d.updates.map((u) => (u.commandId === commandId ? { commandId, ...patch } : u))
            : [...d.updates, { commandId, ...patch }],
        };
      });
    }
    setEditingUpdate(null);
  };

  const removeUpdate = (commandId) => {
    setDraft((d) => ({ ...d, updates: d.updates.filter((u) => u.commandId !== commandId) }));
    setEditingUpdate(null);
  };

  const toggleDelete = (cmd) => {
    setDraft((d) => {
      if (d.deletes.includes(cmd.id)) {
        return { ...d, deletes: d.deletes.filter((id) => id !== cmd.id) };
      }
      return {
        ...d,
        deletes: [...d.deletes, cmd.id],
        updates: d.updates.filter((u) => u.commandId !== cmd.id),
      };
    });
    setEditingUpdate(null);
  };

  const clearDraft = () => {
    if (draft.creates.length + draft.updates.length + draft.deletes.length === 0) return;
    if (!window.confirm('清空全部暂存草案？该操作只影响本浏览器中的草案，不触碰服务器数据。')) return;
    setDraft(emptyDraft());
    setEditingCreate(null);
    setEditingUpdate(null);
  };

  const downloadJson = () => {
    if (!preview) return;
    const blob = new Blob([JSON.stringify(preview, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sandbox-preview.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ---- 派生：当前命令浏览 ----
  const updateMap = useMemo(() => new Map(draft.updates.map((u) => [u.commandId, u])), [draft.updates]);
  const deleteSet = useMemo(() => new Set(draft.deletes), [draft.deletes]);

  const visibleCommands = useMemo(() => {
    return state.commands
      .filter((c) => !filterContext || c.contextId === filterContext)
      .slice()
      .sort((a, b) => {
        const pa = contextPathOf(a.contextId);
        const pb = contextPathOf(b.contextId);
        return pa === pb
          ? a.sequenceLabel.localeCompare(b.sequenceLabel) || (a.id < b.id ? -1 : 1)
          : pa < pb
            ? -1
            : 1;
      });
  }, [state.commands, filterContext, contextPathOf]);

  const stagedCount = draft.creates.length + draft.updates.length + draft.deletes.length;

  return (
    <div className="sandbox-page">
      <div className="regression-toolbar">
        <div className="regression-title">
          <h2>🧪 变更沙盒</h2>
          <span className="dim small">
            批量暂存命令的新增 / 改序列（含移动、改名）/ 删除；草案只保存在本浏览器，不会写入数据文件，也不影响审校页。
          </span>
        </div>
        <div className="regression-actions">
          <button onClick={() => { refreshState(); runPreview(draft); }} title="重新拉取基线并重算预演">
            重新预演
          </button>
          <button onClick={clearDraft} disabled={stagedCount === 0}>
            清空草案
          </button>
          <button className="primary" onClick={downloadJson} disabled={!preview}>
            下载预演 JSON
          </button>
        </div>
      </div>

      {stateError && <p className="error">⚠ 基线加载失败：{stateError}</p>}
      {error && <p className="error">⚠ 预演被拒绝：{error}（请修改草案后重试）</p>}

      {preview && (
        <div className="stat-grid">
          <StatCard value={stagedCount} label="暂存操作（仅本浏览器）" tone="warn" />
          <StatCard
            value={`${preview.stats.commandCountAfter}/${preview.stats.commandCountBefore}`}
            label="模拟 / 基线命令数"
          />
          <StatCard value={preview.stats.bindingsAdded} label="生效绑定新增" tone="ok" />
          <StatCard value={preview.stats.bindingsRemoved} label="生效绑定消失" tone="danger" />
          <StatCard value={preview.stats.bindingsChanged} label="生效绑定变化" />
          <StatCard value={`${preview.stats.shadowsAdded}/${preview.stats.shadowsRemoved}`} label="shadowed 新增/消失" />
          <StatCard value={`${preview.stats.duplicateAdded}/${preview.stats.duplicateRemoved}`} label="duplicate 新增/消失" tone="warn" />
          <StatCard value={`${preview.stats.prefixAdded}/${preview.stats.prefixRemoved}`} label="prefix 新增/消失" tone="warn" />          <StatCard
            value={`${preview.stats.unreachableAdded}/${preview.stats.unreachableRemoved}`}
            label="不可触发命令 新增/消失"
            tone={preview.stats.unreachableAdded > 0 ? 'danger' : ''}
          />
        </div>
      )}

      <div className="sb-layout">
        {/* 左：基线命令浏览 + 暂存新增 */}
        <section className="panel sb-col">
          <div className="panel-header">
            <h2>当前命令（基线）</h2>
            <select
              className="sb-filter"
              value={filterContext}
              onChange={(e) => setFilterContext(e.target.value)}
            >
              <option value="">全部上下文</option>
              {state.contexts
                .slice()
                .sort((a, b) => (contextPathOf(a.id) < contextPathOf(b.id) ? -1 : 1))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {contextPathOf(c.id)}
                  </option>
                ))}
            </select>
          </div>
          <div className="sb-create-wrap">
            <h3 className="sb-subhead">暂存一条新增命令</h3>
            <CreateForm contexts={state.contexts} contextPathOf={contextPathOf} onAdd={addCreate} />
          </div>
          <div className="sb-cmd-list">
            <table className="cmd-table">
              <thead>
                <tr>
                  <th>命令 / 来源</th>
                  <th>序列</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loadingState && (
                  <tr><td colSpan={3} className="hint">加载基线中…</td></tr>
                )}
                {!loadingState && visibleCommands.length === 0 && (
                  <tr><td colSpan={3} className="hint">当前还没有命令。</td></tr>
                )}
                {visibleCommands.map((cmd) => {
                  const patched = updateMap.get(cmd.id);
                  const deleted = deleteSet.has(cmd.id);
                  return (
                    <tr key={cmd.id} className={deleted ? 'row-shadowed' : patched ? 'editing' : ''}>
                      <td>
                        <div className="party-name">{patched?.name ?? cmd.name}</div>
                        <div className="party-source">
                          {patched?.contextId && patched.contextId !== cmd.contextId ? (
                            <>
                              <span className="dim">{contextPathOf(cmd.contextId)}</span> → {contextPathOf(patched.contextId)}
                            </>
                          ) : (
                            contextPathOf(cmd.contextId)
                          )}
                        </div>
                      </td>
                      <td>
                        {patched?.sequence ? (
                          <>
                            <kbd className="seq dim">{cmd.sequenceLabel}</kbd>{' '}
                            <span className="sb-arrow">→</span>{' '}
                            <kbd className="seq">{patched.sequence}</kbd>
                          </>
                        ) : (
                          <kbd className="seq">{cmd.sequenceLabel}</kbd>
                        )}
                      </td>
                      <td className="row-actions">
                        {deleted ? (
                          <button onClick={() => toggleDelete(cmd)} title="撤销删除暂存">撤销删除</button>
                        ) : (
                          <>
                            <button
                              onClick={() => setEditingUpdate(editingUpdate === cmd.id ? null : cmd.id)}
                            >
                              {patched ? '编辑暂存' : '改序列/改'}
                            </button>
                            <button className="danger" onClick={() => toggleDelete(cmd)}>
                              删除
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleCommands.some((c) => editingUpdate === c.id) && (() => {
              const cmd = state.commands.find((c) => c.id === editingUpdate);
              if (!cmd) return null;
              return (
                <div className="sb-inline-edit">
                  <UpdateForm
                    baseline={cmd}
                    contexts={state.contexts}
                    contextPathOf={contextPathOf}
                    patch={updateMap.get(cmd.id) || {}}
                    onSave={(patch) => stageUpdate(cmd.id, patch)}
                    onCancel={() => setEditingUpdate(null)}
                  />
                </div>
              );
            })()}
          </div>
        </section>

        {/* 中：草案清单 */}
        <section className="panel sb-col">
          <div className="panel-header">
            <h2>暂存草案（仅本浏览器）</h2>
            <span className="dim small">{stagedCount} 项</span>
          </div>
          <div className="sb-draft-body">
            {stagedCount === 0 && (
              <p className="hint">
                草案为空。从左侧暂存新增、改序列或删除；预演结果会在右侧实时出现。
                所有暂存都不会发送写请求，更不会改动数据文件。
              </p>
            )}

            {draft.creates.length > 0 && (
              <div className="sb-draft-group">
                <h3 className="sb-subhead">新增 × {draft.creates.length}</h3>
                {draft.creates.map((c) => (
                  <div key={c.clientId} className="sb-draft-item add">
                    {editingCreate === c.clientId ? (
                      <UpdateForm
                        baseline={{
                          id: c.clientId,
                          name: c.name,
                          sequenceRaw: c.sequence,
                          sequenceLabel: c.sequence,
                          contextId: c.contextId,
                          description: c.description || '',
                        }}
                        contexts={state.contexts}
                        contextPathOf={contextPathOf}
                        patch={{}}
                        onSave={(patch) =>
                          saveCreate(c.clientId, {
                            name: patch.name ?? c.name,
                            sequence: patch.sequence ?? c.sequence,
                            contextId: patch.contextId ?? c.contextId,
                            description: patch.description ?? c.description,
                          })
                        }
                        onCancel={() => setEditingCreate(null)}
                      />
                    ) : (
                      <>
                        <div className="sb-draft-line">
                          <DiffTag tone="add">新增</DiffTag>
                          <span className="party-name">{c.name}</span>
                          <kbd className="seq">{c.sequence}</kbd>
                        </div>
                        <div className="party-source">{contextPathOf(c.contextId)}</div>
                        <div className="row-actions">
                          <button onClick={() => setEditingCreate(c.clientId)}>编辑</button>
                          <button className="danger" onClick={() => removeCreate(c.clientId)}>
                            移出草案
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {draft.updates.length > 0 && (
              <div className="sb-draft-group">
                <h3 className="sb-subhead">修改 × {draft.updates.length}</h3>
                {draft.updates
                  .slice()
                  .sort((a, b) => (a.commandId < b.commandId ? -1 : 1))
                  .map((u) => {
                    const base = baselineById.get(u.commandId);
                    if (!base) return null;
                    return (
                      <div key={u.commandId} className="sb-draft-item change">
                        <div className="sb-draft-line">
                          <DiffTag tone="change">修改</DiffTag>
                          <span className="party-name">{u.name ?? base.name}</span>
                          {u.sequence ? (
                            <>
                              <kbd className="seq dim">{base.sequenceLabel}</kbd>
                              <span className="sb-arrow">→</span>
                              <kbd className="seq">{u.sequence}</kbd>
                            </>
                          ) : (
                            <kbd className="seq">{base.sequenceLabel}</kbd>
                          )}
                        </div>
                        <div className="party-source">
                          {u.contextId && u.contextId !== base.contextId
                            ? `${contextPathOf(base.contextId)} → ${contextPathOf(u.contextId)}`
                            : contextPathOf(base.contextId)}
                        </div>
                        <div className="row-actions">
                          <button onClick={() => setEditingUpdate(base.id)}>编辑</button>
                          <button onClick={() => removeUpdate(base.id)}>移出草案</button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

            {draft.deletes.length > 0 && (
              <div className="sb-draft-group">
                <h3 className="sb-subhead">删除 × {draft.deletes.length}</h3>
                {draft.deletes
                  .slice()
                  .sort()
                  .map((id) => {
                    const base = baselineById.get(id);
                    if (!base) return null;
                    return (
                      <div key={id} className="sb-draft-item remove">
                        <div className="sb-draft-line">
                          <DiffTag tone="remove">删除</DiffTag>
                          <span className="party-name">{base.name}</span>
                          <kbd className="seq dim">{base.sequenceLabel}</kbd>
                        </div>
                        <div className="party-source">{contextPathOf(base.contextId)}</div>
                        <div className="row-actions">
                          <button onClick={() => toggleDelete(base)}>撤销</button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </section>

        {/* 右：预演结果 */}
        <section className="panel sb-col sb-preview-col">
          <div className="panel-header">
            <h2>预演差异（基线 vs 模拟）</h2>
            {preview && <span className="dim small">{preview.contexts.length} 个上下文有变化</span>}
          </div>
          <div className="sb-preview-body">
            {!preview && <p className="hint">预演计算中…</p>}

            {preview && preview.unreachable.added.length === 0 && preview.unreachable.removed.length === 0 &&
              preview.contexts.length === 0 && (
                <p className="hint">当前草案对生效绑定、冲突与可触发性没有任何影响（空草案或改动不可见）。</p>
              )}

            {preview && (preview.unreachable.added.length > 0 || preview.unreachable.removed.length > 0) && (
              <div className="unreachable-panel">
                <h3>不可触发命令的新增 / 消失</h3>
                <DiffBucket
                  title="新增不可触发（模拟后任何叶子都无法触发）"
                  tone="remove"
                  items={preview.unreachable.added}
                  renderItem={(u) => (
                    <div className="sb-item" key={u.commandId}>
                      <span className="party-name">{u.name}</span>
                      <kbd className="seq dim">{u.sequenceLabel}</kbd>
                      <span className="party-source">来源：{u.contextPath}</span>
                      <span className="dim small">{u.reason}</span>
                    </div>
                  )}
                />
                <DiffBucket
                  title="消失不可触发（恢复可在叶子触发或被删除）"
                  tone="add"
                  items={preview.unreachable.removed}
                  renderItem={(u) => (
                    <div className="sb-item" key={u.commandId}>
                      <span className="party-name">{u.name}</span>
                      <kbd className="seq">{u.sequenceLabel}</kbd>
                      <span className="party-source">来源：{u.contextPath}</span>
                      <span className="dim small">{u.reason}</span>
                    </div>
                  )}
                />
              </div>
            )}

            {preview?.contexts.map((ctx) => (
              <ContextDiffCard key={ctx.contextId} ctx={ctx} />
            ))}

            {preview && (
              <details className="json-details">
                <summary>查看完整预演 JSON</summary>
                <pre className="json-pre">{JSON.stringify(preview, null, 2)}</pre>
              </details>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
