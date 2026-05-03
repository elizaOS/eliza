---
title: 聊天
sidebarTitle: 聊天
description: 与 Eliza 代理交互的核心消息界面——语音聊天、3D 虚拟形象、对话和自主监控。
---

聊天标签页是仪表盘的默认着陆视图。它通过 `ChatView` 组件提供核心消息界面，采用三栏布局：左侧为对话侧边栏，中间为聊天视图，右侧为自主面板。

<div id="message-area">
## 消息区域
</div>

消息通过 `MessageContent` 组件渲染，支持：

- **纯文本** — 保留换行的标准聊天消息。
- **内联插件配置** — 代理响应中的 `[CONFIG:pluginId]` 标记通过 `ConfigRenderer` 渲染为交互式插件配置表单。
- **UI Spec 渲染** — 包含 UiSpec 对象的 JSON 围栏代码块通过 `UiRenderer` 渲染为交互式 UI 元素。
- **代码块** — 带语法高亮的围栏代码块。
- **流式传输** — 代理响应逐 token 流式传入，带有可见的输入指示器。`chatFirstTokenReceived` 标志追踪第一个 token 到达的时间。
- **操作进度（替换语义）** — 当一个操作多次调用其回调（与 Discord 渐进式消息的理念相同）时，API 发送**快照**SSE 更新，使**最新的**回调文本在模型流式前缀之后替换前一个，而不是将每行状态拼接成一个整体。**原因：** 实时状态应该感觉像**实时编辑**，而不是累积的噪音。参见[操作回调与 SSE 流式传输](/zh/runtime/action-callback-streaming)。

<div id="input-area">
## 输入区域
</div>

聊天输入区域位于视图底部：

- **自动调整大小的文本区域** — 在你输入时从 38 px 增长到最大 200 px。
- **图片附件** — 通过文件选择器按钮、拖放到聊天区域或从剪贴板粘贴来附加图片。待上传的图片以缩略图形式显示在输入框上方。
- **文件拖放** — 将文件拖放到聊天区域以与代理共享。拖动时会显示可视化的放置区域指示器。
- **发送 / 停止** — 发送按钮提交消息；当代理正在响应时，会出现停止按钮以取消生成。

<div id="voice-chat">
## 语音聊天
</div>

内置语音聊天，由 ElevenLabs 或浏览器 TTS/STT 驱动：

- 语音配置在组件挂载时自动从代理配置加载。
- `useVoiceChat` hook 管理麦克风开关、代理语音播放和驱动虚拟形象口型同步的说话状态。
- 在设置或角色视图中的语音配置更改通过 `eliza:voice-config-updated` 自定义 DOM 事件实时同步。

<div id="vrm-3d-avatar">
## VRM 3D 虚拟形象
</div>

使用 Three.js 和 `@pixiv/three-vrm` 渲染的实时 3D 虚拟形象：

- 虚拟形象通过待机动画和表情响应对话。
- 通过 `selectedVrmIndex` 状态从 8 个内置 VRM 模型中选择。
- 通过自主面板聊天控制部分中的两个控制按钮切换虚拟形象可见性和代理语音静音。

<div id="conversations-sidebar">
## 对话侧边栏
</div>

`ConversationsSidebar` 组件管理多个对话：

- **对话列表** — 按最近更新排序。每个条目显示标题、相对时间戳（例如"5分钟前"、"2天前"）以及有新消息的对话的未读指示器。
- **创建新对话** — 顶部的"新建聊天"按钮创建一个新的对话线程。
- **重命名** — 双击对话标题进入内联编辑模式。按 Enter 保存或按 Escape 取消。
- **删除** — 每个对话都有一个删除按钮，可永久删除该线程。
- **未读追踪** — `unreadConversations` 集合追踪哪些对话有用户尚未查看的新消息。

<div id="autonomous-panel">
## 自主面板
</div>

显示在聊天标签页的右侧，`AutonomousPanel` 组件提供对自主操作的实时可见性：

- **当前状态** — 显示最新的"想法"（来自助手/评估器流）和最新的"操作"（来自操作/工具/提供者流）。
- **事件流** — 一个可折叠的、按时间倒序排列的最近 120 个事件的列表，按类型颜色编码：

| 事件类型 | 颜色 |
|------------|-------|
| 心跳事件 | 强调色 |
| 错误事件 | 红色（危险） |
| 操作、工具、提供者事件 | 绿色（成功） |
| 助手想法 | 强调色 |
| 其他事件 | 灰色（低调） |

- **工作台任务** — 代理正在处理的活跃任务，以清单形式显示。
- **触发器** — 计划触发器（间隔、cron、一次性），显示其类型、启用状态和运行次数。
- **待办事项** — 代理追踪的任务项，以清单形式显示。
- **聊天控制** — 底部有虚拟形象可见性开关和代理语音静音开关，以及一个 VRM 虚拟形象预览窗口（根据视口高度为 260-420 px）。

<div id="emote-picker">
## 表情选择器
</div>

使用键盘快捷键 **Cmd+E**（macOS）或 **Ctrl+E**（Windows/Linux）触发 VRM 虚拟形象表情。选择器提供 6 个类别中的 29 个表情：

| 类别 | 表情 |
|----------|--------|
| **Greeting** | Wave, Kiss |
| **Emotion** | Crying, Sorrow, Rude Gesture, Looking Around |
| **Dance** | Dance Happy, Dance Breaking, Dance Hip Hop, Dance Popping |
| **Combat** | Hook Punch, Punching, Firing Gun, Sword Swing, Chopping, Spell Cast, Range, Death |
| **Idle** | Idle, Talk, Squat, Fishing |
| **Movement** | Float, Jump, Flip, Run, Walk, Crawling, Fall |

每个表情都用一个可点击的图标按钮表示。类别在选择器中显示为可过滤的标签页。

<div id="context-menu">
## 右键菜单
</div>

右键点击消息可访问上下文菜单，用于保存命令或执行自定义操作。
