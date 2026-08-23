# 1号会员店发版日历

一个前后端一体化的发版排期管理工具，内置 **AI 排期 Agent**，支持自动排期、假期管理、冲突检测、邮件提醒和多格式导出。

## ✨ 功能特性

- **自动排期**：只需指定首版 BRD 初评日期，自动生成全年版本（每月 1~2 版，版本号 `S{月}-{序号}`）
- **智能排期引擎**：工作日/节假日/调休日感知，灰度可跨周末，上线时间避开禁发日和长假
- **AI 排期 Agent**：基于 DeepSeek，支持工具调用（增删假期、改排期、查冲突、读写入偏好）
- **冲突检测**：自动检测同月超版数、开发/测试重叠、禁发日冲突
- **假期管理**：自定义假期、调休工作日、不能发版日期
- **邮件提醒**：每日 8:00 定时检查明日关键节点，SMTP 自动发送
- **多格式导出**：CSV 明细、Excel 日历（.xlsx）、图片/PDF 日历
- **版本独立配色**：一个版本一个颜色，日历和导出保持一致

## 🏗️ 技术栈

| 层 | 技术 |
|----|------|
| 前端 | 原生 HTML/CSS/JS（单文件） |
| 后端 | Node.js + Express |
| ORM | Prisma Client |
| 数据库 | Supabase PostgreSQL |
| AI | DeepSeek API（Function Calling） |
| 邮件 | Nodemailer + node-cron |
| 导出 | SheetJS（xlsx）、HTML 打印（图片/PDF） |
| 部署 | Vercel Serverless |

## 📁 目录结构

```
.
├── server.js                  # 后端入口（Express + Prisma）
├── public/
│   └── index.html             # 前端（日历渲染 + 排期引擎 + AI Agent）
├── prisma/
│   └── schema.prisma          # 数据模型（7 张表）
├── supabase/
│   └── schema.sql             # Supabase 建表 SQL
├── api/
│   └── [...path].js           # Vercel Serverless API 代理
├── lib/
│   └── supabaseStore.js       # Supabase 客户端封装
├── vercel.json                # Vercel 部署配置
├── .env.example               # 环境变量模板
└── package.json
```

## 🤖 AI Agent 架构

```
用户对话
  └→ 意图识别（内化在 System Prompt 推理第一步）
        ├→ ① 排期查询（get_schedule / list_holidays）
        ├→ ② 正常排期 Agent（generate_schedule：版本号+开始+结束日期 → 走排期规则）
        └→ ③ 修改调整（adjust_schedule：版本号+环节+日期 → 锁定锚点微调）

┌─────────────────────────────────────────────┐
│              Orchestration Layer             │
│   Plan（任务分解）→ Execute（工具调用）          │
│        → Observe（结果回传）→ 多轮循环          │
└──────────────┬──────────────────────────────┘
               │
     ┌─────────┴─────────┐
     │    Tool Layer     │
     │  13 个函数工具      │
     │  · 假期管理         │
     │  · 正常排期/修改调整 │
     │  · 冲突检测         │
     │  · 假期分析         │
     │  · 偏好读写         │
     └─────────┬─────────┘
               │
     ┌─────────┴─────────┐
     │   Memory Layer    │
     │  短期：对话上下文    │
     │  长期：UserPreference│
     └────────────────────┘
```

Agent 遵循「规划→执行→评估」推理框架，通过 `sendChat()` 的多轮 while 循环实现工具调用闭环（最多 5 轮）。

### Agent 三大角色

| 角色 | 工具 | 输入 | 行为 |
|------|------|------|------|
| 排期查询 | `get_schedule` / `list_holidays` | 版本号 | 查询日历数据、排期细节 |
| 正常排期 | `generate_schedule` | 版本号 + BRD初评日期 + iOS发版日期 | 按排期规则全量生成 |
| 修改调整 | `adjust_schedule` | 版本号 + 环节 + 调整日期 | 锁定 BRD初评/iOS，只改指定环节，自动重算下游 |

### Agent 核心代码位置

| 模块 | 位置 |
|------|------|
| 记忆层 | `public/index.html` → `loadPreferences()` / `detectConflicts()` |
| 排期引擎 | `generateScheduleVersion()` / `adjustScheduleVersion()` |
| System Prompt | `buildSystemPrompt()` |
| 工具集 | `TOOLS` 数组 + `executeTool()` |
| 编排循环 | `sendChat()` |

## 📊 数据库模型

| 表 | 说明 |
|----|------|
| `versions` | 发版版本（BRD 初评、发版日期） |
| `holidays` | 假期 / 调休工作日 |
| `no_release` | 不能发版日期 |
| `email_config` | 邮件 SMTP 配置 |
| `conversations` | AI 对话会话 |
| `chat_messages` | AI 对话消息 |
| `user_preferences` | 用户长期偏好（Agent 记忆） |

## 📅 排期规则

- **版数**：大活动/长假月（1,2,5,6,9,10,11 月）1 版，其余月 2 版
- **版本号**：`S{发版月}-{该月第几版}`
- **BRD 初评**：每两周一次，固定周四
- **前置链条**：BRD初评(四) → 隔2wd → BRD终评(二) → 隔1wd → PRD初评(四) → PRD终评订单(周一) → PRD终评搜推(周二=内部PRD终评) → 输出排期
- **开发+测试**：按剩余工作日 2:1 分配
- **灰度**：2 自然日，遇周末/节假日自动延伸，其余阶段必须工作日
- **约束**：同月≤2 版、两次发版间隔≥13 天、上线时间避开禁发日

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 DATABASE_URL 和 DEEPSEEK_API_KEY

# 3. 推送数据库 schema
npx prisma generate
npx prisma db push

# 4. 启动服务
node server.js
# 打开 http://localhost:3456
```

## ☁️ 部署到 Vercel

1. 推送代码到 GitHub
2. 在 Vercel 导入仓库
3. 设置环境变量：`DATABASE_URL`、`DEEPSEEK_API_KEY`
4. 部署（`vercel-build` 会自动执行 `prisma generate`）

## 🔌 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | `/api/versions` | 版本列表 / 更新 |
| GET/POST/DELETE | `/api/holidays` | 假期管理 |
| GET/POST/DELETE | `/api/no-release` | 禁发日期 |
| GET/POST | `/api/preferences` | 用户偏好 |
| GET/POST | `/api/email-config` | 邮件配置 |
| POST | `/api/send-reminder` | 发送提醒 |
| POST | `/api/chat` | AI 对话（DeepSeek 流式） |
| GET | `/api/health` | 健康检查 |
