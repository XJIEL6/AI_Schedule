# 发版日历 - 新增「假期管理」和「AI对话」两个功能模块

## Context

当前 `release_calendar_2026.html` 是一个独立的单文件 HTML 应用，内置了 2026 年中国法定节假日和排期自动推算逻辑。用户希望：
1. 能**自定义输入假期**（日期区间选择），灵活增删，并自动刷新排期
2. 集成一个 **AI 对话面板**，通过自然语言与 AI 交互来调整排期日历

---

## 一、假期管理面板 (Holiday Management Panel)

### 1.1 数据层改造

**新增全局状态：**
```js
let userHolidays = [];      // [{start: 'YYYY-MM-DD', end: 'YYYY-MM-DD'}, ...]
let userMakeupDays = [];    // [{start: 'YYYY-MM-DD', end: 'YYYY-MM-DD'}, ...]
```

**重构判断函数：**
- `isHoliday(d)` — 合并内置 `holidays` Set + `userHolidays` 展开后的日期
- `isMakeup(d)` — 合并内置 `makeupDays` Set + `userMakeupDays` 展开后的日期
- 新增 `expandRange(range)` 辅助函数，将 `{start, end}` 展开为日期 Set
- 新增 `rebuildAll()` — 重新调用 `buildVersions()` + 重建 `eventMap` + 重渲染全部 UI

**localStorage 持久化：**
- key: `rc_user_holidays` → 假期区间数组
- key: `rc_user_makeup` → 调休工作日区间数组
- 页面初始化时读取，合并到判断逻辑

### 1.2 UI 层

**位置**：在 `<div class="legend">` 图例下方，`<div id="versionDetail">` 上方

**布局**：一个可折叠的面板，包含：
- 标题栏：**"📅 自定义假期管理"** + 展开/折叠箭头
- 输入区：两个 `<input type="date">` (开始日期、结束日期) + 「添加假期」按钮 + 「添加调休日」按钮
- 列表区：已添加的假期区间列表，每条显示区间范围 + 天数 + 🗑️删除按钮
- 空状态："暂无自定义假期"

**交互流程**：
1. 用户选择开始日期、结束日期 → 点击「添加假期」
2. 区间加入 `userHolidays`，保存 localStorage，调用 `rebuildAll()`
3. 日历上对应日期立即显示 🔴 标记，排期自动顺延
4. 点击删除 → 从数组移除 → 保存 → `rebuildAll()`

### 1.3 调休日支持
- 「添加调休日」按钮：将选中区间标记为调休工作日（💼），这些日期在排期计算中视为工作日
- 列表中用不同颜色/标签区分「假期」和「调休日」

---

## 二、AI 对话面板 (AI Chat Panel)

### 2.1 整体架构

```
浏览器 HTML 页面
  ↓ fetch('/api/chat', { messages, tools })
  ↓
本地 Node.js 代理 (server.js, localhost:3456)
  ↓ 读取 .env → ANTHROPIC_API_KEY
  ↓ HTTP POST https://api.anthropic.com/v1/messages (streaming)
  ↓
Anthropic API 返回 SSE 流
  ↓ 代理透传 → 前端 ReadableStream 解析
  ↓
前端：渲染文本 + 处理 tool_use → 执行本地函数 → rebuildAll()
  ↓ 将 tool_result 发回代理 → 继续对话
```

**API 配置（后端代理模式）**：
- 新建 `server.js` — 轻量 Node.js 代理服务器，读取 `.env` 中的 `ANTHROPIC_API_KEY`
- 新建 `.env.example` — 模板文件，内容 `ANTHROPIC_API_KEY=your_key_here`，用户复制为 `.env` 后填入真实 Key
- 前端通过 `fetch('http://localhost:3456/api/chat')` 调用代理，API Key 不暴露到浏览器
- 模型选择：下拉框，默认 `claude-sonnet-4-6`（可选值从代理获取）

### 2.2 System Prompt 上下文

每次对话时，构建包含以下信息的 system prompt：
- 当前所有版本的排期摘要（版本名 + 关键日期）
- 用户自定义假期列表
- 排期推算规则说明（各阶段之间的工作日偏移量）
- 可用 Tool 列表

### 2.3 Tool 定义（Anthropic Tool Use）

```
1. add_holiday(start, end)        — 添加假期区间
2. remove_holiday(index)          — 删除假期区间
3. add_makeup_day(start, end)     — 添加调休工作日区间
4. remove_makeup_day(index)       — 删除调休工作日区间
5. list_holidays()                — 列出所有自定义假期
6. get_schedule(version?)         — 获取指定/全部版本排期详情
7. adjust_phase_offset(phase, workdays)  — 调整某个阶段的工作日偏移量
8. set_base_launch_date(date)     — 修改基准发版日期（S6发版日）
9. add_custom_version(name, after_version) — 插入自定义版本
```

每个 Tool 执行后自动调用 `rebuildAll()` 刷新 UI。

### 2.4 UI 层

**位置**：页面最底部，`<div id="versionDetail">` 下方

**布局**：可折叠面板
- 标题栏：**"🤖 AI 排期助手"** + 展开/折叠箭头 + 在线状态指示灯
- 配置区（首次展开时显示）：API Key 输入框 + 模型选择 + 连接测试按钮
- 消息区：对话气泡列表，支持滚动，区分用户/AI 消息
- 输入区：`<textarea>` + 发送按钮 + Enter 发送（Shift+Enter 换行）
- AI 消息中 Tool 调用显示为可折叠的「🔧 执行操作」卡片
- 加载状态：打字动画 / "思考中..."

### 2.5 流式响应处理

- 使用 Server-Sent Events 风格的流式读取（`fetch` + `ReadableStream`）
- 逐步渲染 AI 回复文本
- Tool Use 时暂停文本渲染，显示工具调用状态
- Tool 执行完成后，继续流式读取

---

## 三、需要修改的核心函数

| 函数 | 改动 |
|------|------|
| `isHoliday(d)` | 合并 userHolidays |
| `isMakeup(d)` | 合并 userMakeupDays |
| 新增 `expandRange()` | 区间 → 日期 Set |
| 新增 `rebuildAll()` | 重建 versions + eventMap + 全部 render |
| 新增 `saveToStorage()` / `loadFromStorage()` | localStorage 读写 |
| `renderCal()` | 不变（通过 eventMap 自动反映变化） |
| `renderDetail()` | 不变 |
| `buildVersions()` | 不变（通过 isWorkday → isHoliday/isMakeup 自动反映） |

---

## 四、数据流

```
用户操作（添加假期/AI Tool）
  → 修改 userHolidays / userMakeupDays
  → 保存 localStorage
  → rebuildAll()
    → buildVersions()（内部调用 isWorkday → isHoliday/isMakeup，自动感知新假期）
    → 重建 eventMap
    → renderTabs() + renderCal() + renderDetail()
```

---

## 五、文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `release_calendar_2026.html` | 修改 | 新增假期管理面板 + AI 对话面板的 HTML/CSS/JS |
| `server.js` | 新建 | Node.js 代理服务器，读取 `.env` API Key，透传 Anthropic API 流式响应 |
| `.env.example` | 新建 | 环境变量模板，用户复制为 `.env` 填入 Key |
| `package.json` | 新建 | 仅依赖 `dotenv`，方便用户 `npm install && node server.js` |

## 六、实现步骤

1. **新建后端代理** — `server.js` + `package.json` + `.env.example`
2. **重构数据层** — 新增 `userHolidays`/`userMakeupDays`，改造 `isHoliday`/`isMakeup`，新增 `expandRange`/`rebuildAll`/storage 函数
3. **假期管理面板 UI** — HTML 结构 + CSS 样式 + JS 交互逻辑
4. **AI 对话面板 UI** — HTML 结构 + CSS 样式（聊天界面）
5. **AI API 集成** — 前端调用本地代理、Tool Use 处理、流式响应渲染
6. **联调验证** — 两个面板互相配合，验证完整数据流

---

## 七、验证方式

1. 复制 `.env.example` → `.env`，填入真实 Anthropic API Key
2. `npm install && node server.js` 启动代理（localhost:3456）
3. 打开 `release_calendar_2026.html`，确认两个新面板正常显示
4. 在假期管理中：选择 2026-08-10 ~ 2026-08-12 → 添加假期 → 日历上这三天变红 → 排期自动延后
5. 删除该假期 → 日历恢复 → 排期恢复
6. 在 AI 对话中："请帮我查看 S7-1 的排期" → AI 返回详情
7. "帮我在 9 月 15-17 号加一个假期" → AI 调用 add_holiday → 日历更新
8. 刷新页面 → 自定义假期仍然存在（localStorage 持久化）
