---
title: 操作回调与 SSE 流式传输
description: 为什么 Eliza 在仪表盘聊天中替换（而非拼接）操作回调文本，以及这如何与 Discord 风格的渐进式消息保持一致。
---

<div id="action-callbacks-and-sse-streaming">
# 操作回调与 SSE 流式传输
</div>

Eliza 的仪表盘聊天使用 **Server-Sent Events (SSE)** 来流式传输助手的回复。两种不同类型的文本到达同一个流：

1. **LLM 令牌** — 模型的流式回复（`onStreamChunk`）。
2. **操作回调** — 在操作运行时从 `HandlerCallback` 返回的文本（例如 `PLAY_AUDIO`、钱包流程、Binance 技能回退）。

本页解释**它们如何合并**以及**为什么**这种设计与 Discord 和 Telegram 等平台保持一致。

---

<div id="the-problem-we-solved">
## 我们解决的问题
</div>

在 **Discord** 上，`@elizaos/plugin-discord` 使用**渐进式消息**：在频道中创建一条消息，然后随着状态更新的到来**就地编辑**（"Looking up track…"、"Searching…"、"Now playing: …"）。

在 **Web** 上，每个 `callback({ text })` 之前都通过与任意流式片段相同的合并路径处理。不相关的状态字符串彼此不共享前缀，因此合并启发式方法经常将它们**拼接**在一起：

```text
🔍 Looking up track...🔍 Searching for track...✨ Setting up playback...Now playing: **Song**
```

这对于延伸同一回答的**令牌增量**是正确的，但对于应该**替换**前一个状态的**连续状态**来说是错误的。

**为什么重要：** 用户期望的是**实时就地更新**（web2 风格的实时体验），而不是一堆不断增长的状态片段。插件不应该需要第二个传输通道（WebSocket、自定义事件）来实现与 Discord 的对等。

---

<div id="the-eliza-behavior">
## Eliza 的行为
</div>

在 `generateChatResponse`（`eliza/packages/agent/src/api/chat-routes.ts`）中：

- **LLM 片段**仍然通过 `appendIncomingText` → `resolveStreamingUpdate` → `onChunk` 使用**追加**语义。
- **操作回调**使用 **`replaceCallbackText`**：
  - 在一轮对话中的**第一个**回调时，服务器对已经流式传输的内容进行快照（`preCallbackText` — 通常是 LLM 的部分或完整文本）。
  - 每个**后续**回调将可见回复设置为：

    `preCallbackText + "\n\n" + latestCallbackText`

  - 因此**回调段**每次都被**替换**；LLM 前缀被保留。

HTTP 层发出一个**快照**（`onSnapshot`），使 SSE 事件携带**完整的**新 `fullText`。客户端已经将 `fullText` 视为权威内容并**替换**助手气泡的文本——无需更改 UI。

**为什么使用快照：** 前端的 SSE 解析器在存在 `fullText` 时使用它；替换整个助手消息对 UI 来说是 O(1) 的操作，并且在心理上对应"编辑消息正文"。

**为什么分离 LLM 和回调路径：** LLM 流式传输是真正的增量式（追加）。操作进度是**状态替换**（最新状态获胜）。将两者混合通过一个合并函数模糊了这些语义。

---

<div id="plugin-contract-unchanged">
## 插件契约（不变）
</div>

插件应继续使用 **elizaOS** 的 `HandlerCallback` 形式：

```typescript
await callback({ text: "🔍 Searching…", source: message.content.source });
await callback({ text: "Now playing: **Track**", source: message.content.source });
```

无额外字段、无 Eliza 专用 API、无运行时附件。`plugin-music-player` 中的 `ProgressiveMessage` 等辅助工具仍然只是对 `callback` 的薄封装。

**为什么保留契约：** Discord 和其他连接器已经依赖此 API；Eliza 的职责是在 **API 聊天**路径中正确解释重复的回调，而不是分叉插件接口。

---

<div id="where-it-applies">
## 适用范围
</div>

`replaceCallbackText` 适用于：

- `messageService.handleMessage` 的主要操作回调。
- `executeFallbackParsedActions`（解析操作恢复）。
- 直接 Binance 技能调度（`maybeHandleDirectBinanceSkillRequest`）。
- 钱包执行回退及类似路径中使用回调调用操作的场景。

**不**用于 `onStreamChunk`——它保持仅追加模式。

---

<div id="related-code-and-docs">
## 相关代码和文档
</div>

- **实现：** `eliza/packages/agent/src/api/chat-routes.ts` — `replaceCallbackText`、`preCallbackText`。
- **示例辅助工具：** `plugins/plugin-music-player/src/utils/progressiveMessage.ts`。
- **UI 流式传输：** [仪表盘 — 聊天](/zh/dashboard/chat)（SSE / 输入指示器）。
- **更新日志：** [更新日志](/zh/changelog) — 搜索 "action callback" 或发布日期。

---

<div id="future--roadmap">
## 未来/路线图
</div>

可能的后续工作（此处未作为需求发布）：

- 在回调内容上添加可选的**元数据**，以区分"追加"与"替换"，适用于特殊插件（仅在出现真实用例时）。
- 中间状态的**持久化**（目前最终持久化的对话轮次文本遵循正常的聊天持久化规则）。

请参阅仓库中的 `docs/roadmap.md` 了解高层产品方向。
