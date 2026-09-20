# ⌨ 上下文快捷键审校台（Node.js + React）

为命令式快捷键体系提供的可视化审校工具：建立**上下文树**，为命令指定所属上下文与由 **1～3 次按键**组成的序列；选择任一上下文后，系统按**最近祖先规则**构建生效绑定，自动标出**同层重复**与**前缀冲突**，并提供**逐键模拟器**实时查看候选、触发与等待状态。此外可一键**生成回归测试套件**：以全部叶子上下文为候选，用精确集合覆盖选出叶子数量最少的测试上下文集合。也可以打开**变更沙盒**：在浏览器里批量暂存命令的新增/改序列/删除草案，由后端只读预演基线与模拟状态的全部差异。

## 一条命令启动（Docker Compose）

```bash
docker compose up --build -d
```

然后浏览器访问：

> **http://localhost:3000**

端口：主机 `3000` → 容器 `3000`（可在 `docker-compose.yml` 的 `ports` 中修改左侧端口）。
停止：`docker compose down`；数据保存在命名卷 `shortcut-data` 中，重建容器不丢失。

> 镜像启动时自动完成数据初始化：首次运行若数据文件不存在，会写入一套包含覆盖、同层重复、前缀冲突等场景的演示数据（`server/src/seed.js`）。

---

## 本地开发（无 Docker）

要求 Node.js ≥ 18。

```bash
npm install          # 安装全部依赖（npm workspaces：server / client）
npm run dev          # 并行启动后端(3000) 与 Vite 前端(5173)
```

访问 **http://localhost:5173**（Vite 已把 `/api` 代理到后端 3000）。

其他命令：

```bash
npm run build        # 构建前端到 client/dist
npm start            # 仅启动后端；若已 build，则由后端在 3000 端口托管前端
npm run test:engine  # 运行引擎单测（最近祖先 / 覆盖 / 重复 / 前缀 / 逐键模拟 / 回归套件 / 变更沙盒预演）
```

## 数据模型

| 实体 | 字段 |
|---|---|
| 上下文 Context | `id`, `parentId`（可空，支持森林）, `name`, `description` |
| 命令 Command | `id`, `contextId`（定义位置）, `name`, `sequenceTokens`（1~3 次按键）, `description` |

序列输入用**空格或逗号**分隔，每次按键支持组合键（修饰键 `Ctrl/Alt/Shift/Meta` + 一个主键），例如：

- `g l`（2 次按键）
- `Ctrl+Shift+P`（1 次按键）
- `Ctrl+K, x`（2 次按键，第 1 次为组合键）

## 审校规则

选定上下文后，沿其祖先链（自身 → 父 → … → 根）收集绑定：

1. **最近祖先生效，子级覆盖祖先**：同一序列若在链上多层定义，最靠近所选上下文的一层生效；祖先层的同序列绑定显示为「已覆盖（shadowed）」，不参与触发与冲突判定。
2. **同层序列重复 = 冲突（duplicate）**：同一上下文中多条命令使用完全相同的序列，双方（全部）都保留并会在按键时**同时触发**，列表标记「同层重复」，冲突卡片列出每一方的**来源上下文路径**与**最短触发输入**。
3. **前缀冲突（prefix）**：生效序列中若 `A` 是 `B` 的严格前缀（如 `G` 与 `G D`，允许跨层），双方分别标记「他序列前缀 / 前缀延伸」，冲突卡片同时展示双方来源与各自最短触发输入。
4. 兄弟上下文的绑定互不可见。

## 逐键模拟器

在右下录制区点击获取键盘焦点后直接按键（支持单键与组合键，单按修饰键不计入）：

- **Esc** 清空缓冲，**Backspace** 回退一个按键；
- `triggered`（绿）：缓冲精确命中，展示已触发命令（重复时列出全部）；若它同时是更长序列前缀，附候选提示；
- `waiting`（黄）：缓冲是一个或多个生效序列的前缀，列出候选命令、来源与「还差 N 键」；
- `no-match`（红）：既未精确命中也不是任何序列前缀；
- `idle`：尚未输入。

## 回归套件生成

顶部切换到「🧪 回归套件生成」页（只读，不改动任何审校/模拟逻辑）：

1. **候选**：上下文树中的全部**叶子上下文**；对每个叶子直接复用 `computeEffective` 的生效规则（最近祖先 / 覆盖 / 同层重复 / 前缀冲突）。
2. **测试目标**：
   - 每条可在**至少一个叶子**触发的命令（shadowed 的绑定不计）；
   - 每个可在某个叶子观察到的**同层重复（duplicate）**或**前缀冲突（prefix）**；冲突以**参与命令集合**判定身份——不同叶子下命令集合相同的冲突视为同一个目标。
3. **选套件**：用**精确集合覆盖**（分支限界，MRV 选目标）选出覆盖全部目标所需**叶子数量最少**的组合；存在多个同解时，按入选上下文路径排序后的**字典序**稳定选择（与数据 id/加载顺序无关）。
4. 每个入选上下文给出一张测试用例：
   - **需输入的序列**：该叶子下全部生效序列；
   - **预期触发命令集合**：精确输入该序列时应同时触发的命令（含来源路径，同层重复时为多条）；
   - **预期冲突类型**：该叶子下的 duplicate / prefix 冲突清单（双方来源与最短触发输入）。
5. **不可触发命令**：任何叶子都无法触发的命令（典型原因：其序列在子树的**每个叶子**都被更近祖先的同序列绑定覆盖 shadowed）单列在警告区并给出原因与覆盖位置，**不计入覆盖目标**；页面覆盖率只统计「可触发命令 + 冲突目标」。

页面顶部展示覆盖统计（叶子数、入选数、已覆盖/可触发命令、不可触发命令、两类冲突数、目标覆盖率、输入序列总数），可一键**下载 JSON**（与 `GET /api/regression-suite` 返回内容一致）。

## 变更沙盒（草案只存浏览器，不写数据）

顶部切换到「🧱 变更沙盒」页（只读视图，**不影响审校与模拟页**，也不会调用任何写接口）：

1. **暂存草案**：在左侧基线命令列表上批量暂存三类操作，草案仅保存在本浏览器的 `localStorage`，刷新不丢、清空即无——服务端数据文件始终不变：
   - **新增**：选择所属上下文，填写名称与 1~3 键序列（由后端做合法性校验）；
   - **改序列/改属性**：修改现有命令的序列、名称、说明或所属上下文（移动）；
   - **删除**：标记删除现有命令；同一条命令不能同时被修改和删除。
2. **后端预演**：每次改动都会把整份草案 `POST /api/sandbox/preview`，服务端在**同一份草案**上分别计算**基线状态**与**模拟状态**，并按上下文汇总：
   - **生效绑定**的新增 / 消失 / 变化（序列或来源路径改变，展示旧→新）；
   - **shadowed** 绑定的新增（新被覆盖）/ 消失（恢复生效或随删除消失）；
   - **同层重复 duplicate**、**前缀冲突 prefix** 的新增 / 消失（身份不变但参与方名称、来源、最短触发变化时单列「细节变化」）；
   - **不可触发命令**（任何叶子都无法触发）的新增 / 消失，附原因与覆盖位置。
3. **稳定身份配对**：生效/shadowed 绑定以命令 id 配对；冲突以**参与命令集合的稳定身份**配对（duplicate：`dup:双方id排序`；prefix：`pre:前缀方id排序::延伸方id排序`）。全部输出均确定性排序，**与草案入参数组顺序、数据存储顺序无关**。
4. 每条差异都展示参与命令的**来源上下文路径**与**最短触发输入**（即该命令自身的序列；前缀方为短序列、延伸方为长序列）。
5. 顶部提供**清空草案**（仅清浏览器）与**下载预演 JSON**（`sandbox-preview.json`，也可请求 `/api/sandbox/preview?download=1`）；非法草案返回 400 且不产生预演结果。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 全量上下文树与命令 |
| POST/PUT/DELETE | `/api/contexts[/:id]` | 上下文增改删（删除级联后代与其命令，移动时防环） |
| POST/PUT/DELETE | `/api/commands[/:id]` | 命令增改删，服务端校验序列合法性（1~3 键、组合键合法） |
| GET | `/api/review/:contextId` | 生效绑定、祖先链、冲突清单、shadowed 绑定 |
| POST | `/api/simulate/:contextId` | 逐键模拟，body：`{"buffer":["g","d"]}` 或 `{"presses":"g d"}` |
| GET | `/api/regression-suite` | 回归套件（统计 + 入选用例 + 候选覆盖数 + 不可触发命令原因）；加 `?download=1` 返回 `Content-Disposition: attachment` 响应头 |
| POST | `/api/sandbox/preview` | **变更沙盒只读预演**：body 为草案，不写入数据文件；加 `?download=1` 以下载响应头返回 |

`/api/sandbox/preview` 请求体（草案，所有数组均可省略；同一命令不允许既改又删）：

```jsonc
{
  "creates": [ { "clientId": "new-…", "contextId": "ctx-…", "name": "…", "sequence": "g l", "description": "" } ],
  "updates": [ { "commandId": "cmd-…", "sequence": "ctrl+k", "name": "…", "contextId": "ctx-…", "description": "…" } ],
  "deletes": [ "cmd-…" ]
}
```

返回结构：

```jsonc
{
  "generatedAt": "…",
  "draft": { "creates": [ /* 规范化回显 */ ], "updates": [ { "commandId": "…", "patch": { /* 仅实际变更的字段 */ } } ], "deletes": ["…"] },
  "stats": {
    "contextCount": 1,
    "commandCountBefore": 19, "commandCountAfter": 19,
    "createCount": 0, "updateCount": 1, "deleteCount": 0,
    "bindingsAdded": 1, "bindingsRemoved": 0, "bindingsChanged": 1,
    "shadowsAdded": 0, "shadowsRemoved": 1,
    "duplicateAdded": 0, "duplicateRemoved": 0, "duplicateChanged": 0,
    "prefixAdded": 2, "prefixRemoved": 2, "prefixChanged": 0,
    "unreachableBefore": 1, "unreachableAfter": 0,
    "unreachableAdded": 0, "unreachableRemoved": 1
  },
  "contexts": [
    {
      "contextId": "ctx-terminal",
      "contextPath": "App / Editor / Terminal",
      "effectiveBindings": {
        "added":    [ { "commandId": "…", "name": "…", "contextPath": "…", "sequenceLabel": "g", "shortestLabel": "g", "duplicate": false, "prefix": null } ],
        "removed":  [ /* 同上结构 */ ],
        "changed":  [ { "before": { /* 同 added 结构 */ }, "after": { /* 同 added 结构 */ } } ]
      },
      "shadowed":   { "added": [ /* 同 added 结构 */ ], "removed": [ /* 同 added 结构 */ ] },
      "duplicates": { "added": [ /* 冲突载荷 */ ], "removed": [ /* 冲突载荷 */ ], "changed": [ { "before": {}, "after": {} } ] },
      "prefixes":   { "added": [ /* 冲突载荷 */ ], "removed": [ /* 冲突载荷 */ ], "changed": [ { "before": {}, "after": {} } ] }
    }
  ],
  "unreachable": {
    "added":   [ { "commandId": "…", "name": "…", "contextPath": "…", "sequenceLabel": "g", "reason": "…", "shadowedBy": [ { "contextId": "…", "contextPath": "…" } ] } ],
    "removed": [ /* 同 added 结构 */ ]
  }
}
```

冲突载荷以参与命令集合的稳定身份 `goalId` 配对（duplicate：`dup:…`；prefix：`pre:前缀方::延伸方`），其 `parties` 中每一方都带 `contextPath`（来源路径）与 `shortestLabel`（最短触发输入）。

`/api/regression-suite` 返回结构：

```jsonc
{
  "generatedAt": "…",
  "stats": {
    "leafCount": 2,                 // 叶子上下文总数
    "candidateCount": 2,            // 覆盖了至少一个目标的候选叶子数
    "selectedContextCount": 2,      // 套件入选叶子数（精确最小）
    "commandCount": 19,
    "triggerableCommandCount": 18,  // 至少在一个叶子可触发的命令
    "coveredCommandCount": 18,
    "unreachableCommandCount": 1,   // 任何叶子都无法触发（不计入覆盖）
    "duplicateConflictCount": 1,
    "prefixConflictCount": 5,
    "inputSequenceCount": 25,       // 套件用例输入序列总数
    "coverableGoalCount": 24,       // 可触发命令 + 冲突目标
    "coveredGoalCount": 24
  },
  "suite": [
    {
      "contextId": "ctx-code",
      "contextPath": "App / Editor / Code Editor",
      "inputs": [
        { "sequenceLabel": "G", "sequenceTokens": ["g"], "duplicate": false,
          "expectedCommands": [ { "commandId": "…", "name": "…", "contextPath": "…" } ] }
      ],
      "expectedConflicts": [ /* 与 /api/review 的 conflicts 结构一致 */ ],
      "coveredGoals": [ "cmd:…", "dup:…", "pre:…" ]
    }
  ],
  "candidates": [ { "contextId": "…", "contextPath": "…", "goalCount": 16, "selected": true } ],
  "unreachableCommands": [
    { "commandId": "…", "name": "…", "contextPath": "…", "sequenceLabel": "G",
      "reason": "序列「G」在所属上下文子树下的全部 2 个叶子上下文中均被更近祖先的同序列绑定覆盖…",
      "shadowedBy": [ { "contextId": "…", "contextPath": "…" } ] }
  ]
}
```

## 目录结构

```
.
├── Dockerfile                # 多阶段构建（构建前端 → 仅生产依赖运行）
├── docker-compose.yml        # 一条命令启动，端口 3000，命名卷持久化
├── server/
│   ├── src/
│   │   ├── index.js          # Express 入口、API、静态托管
│   │   ├── engine.js         # 核心规则：最近祖先/冲突/逐键模拟/回归套件（精确集合覆盖）/变更沙盒预演
│   │   ├── store.js          # JSON 文件持久化 + 校验（沙盒预演不经此层写入）
│   │   └── seed.js           # 初始演示数据
│   └── test/engine.test.js   # 引擎单测
└── client/
    ├── src/
    │   ├── App.jsx
    │   ├── api.js
    │   ├── styles.css
    │   └── components/       # 上下文树 / 命令面板 / 绑定与冲突 / 逐键模拟器 / 回归套件 / 变更沙盒
    └── vite.config.js
```
