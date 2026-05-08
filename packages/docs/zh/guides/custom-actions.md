---
title: 自定义操作
sidebarTitle: 自定义操作
description: 使用 HTTP、shell 和代码处理器定义用户创建的代理能力，扩展代理的功能。
---

操作是代理与世界交互的主要方式。它们代表离散的能力——代理可以根据对话上下文执行的操作。Eliza 自带内置操作，并提供了一个系统，让你无需编写插件代码即可定义自己的自定义操作。

<div id="action-interface">

## 操作接口

</div>

在 elizaOS 运行时中，`Action` 是一个包含以下属性的对象：

- **name** -- 运行时用于选择操作的唯一标识符（例如 `RESTART_AGENT`）。
- **similes** -- 帮助代理匹配用户意图的替代名称（例如 `REBOOT`、`RELOAD`）。
- **description** -- 代理用于决定何时适合使用此操作的可读文本。
- **validate** -- 返回操作是否可以在当前上下文中运行的异步函数。
- **handler** -- 执行操作并返回结果的异步函数。
- **parameters** -- 描述接受的输入的参数定义数组。
- **examples** -- 可选的对话示例，帮助代理学习何时使用该操作。

当用户发送消息时，运行时会评估所有已注册的操作。如果代理确定某个操作与用户的意图匹配，它会从对话中提取参数并调用处理器。

<div id="built-in-actions-reference">

## 内置操作参考

</div>

Eliza 在运行时自动从 `src/actions/` 注册以下内置操作。

<div id="agent-lifecycle">

### 代理生命周期

</div>

**RESTART_AGENT** -- 优雅地重启代理进程。停止运行时，如果源文件发生更改则重新构建，然后重新启动。持久化一条"Restarting..."记忆，返回响应，然后在 1.5 秒延迟后安排重启，以便响应可以刷新。在 CLI 模式下，以代码 75 退出供运行脚本使用；在桌面运行时模式下，执行进程内热重启。可选的 `reason` 参数会被记录用于诊断。

<div id="plugin-management">

### 插件管理

</div>

这些操作提供了完整的插件弹出工作流程。"弹出"会将插件的源代码克隆到本地，使运行时加载你的本地副本而非 npm 包。

| Action | 描述 | 关键参数 |
|--------|------|---------|
| `EJECT_PLUGIN` | 将插件源代码克隆到本地，使编辑覆盖 npm 版本。触发重启。 | `pluginId`（必需） |
| `SYNC_PLUGIN` | 获取并合并上游提交到已弹出的插件中。如有冲突则报告。 | `pluginId`（必需） |
| `REINJECT_PLUGIN` | 删除已弹出的插件副本，使运行时回退到 npm。触发重启。 | `pluginId`（必需） |
| `LIST_EJECTED_PLUGINS` | 列出所有已弹出的插件，包含名称、分支和本地路径。 | 无 |

<div id="core-ejection">

### 核心弹出

</div>

与插件弹出类似，但针对 elizaOS 核心框架本身。

| Action | 描述 |
|--------|------|
| `EJECT_CORE` | 将 `@elizaos/core` 源代码克隆到本地，使编辑覆盖 npm 包。触发重启。 |
| `SYNC_CORE` | 将已弹出的核心检出与上游同步并重新构建。报告上游提交数量或冲突。 |
| `REINJECT_CORE` | 删除已弹出的核心源代码，使运行时回退到 npm 包 `@elizaos/core`。触发重启。 |
| `CORE_STATUS` | 显示 `@elizaos/core` 是从 npm 运行还是从已弹出的源代码运行，包含版本和提交哈希。 |

<div id="communication">

### 通信

</div>

**SEND_MESSAGE** -- 在特定平台/服务上向用户或房间发送消息。需要 `targetType`（`user` 或 `room`）、`source`（服务名称如 `telegram`）、`target`（实体/房间 ID）和 `text`。通过 `runtime.getService()` 查找服务并调用相应的发送方法。

<div id="media-generation">

### 媒体生成

</div>

| Action | 描述 | 必需参数 |
|--------|------|---------|
| `GENERATE_MEDIA` | 从文本提示生成图像、视频或音频。支持图像、视频和音频选项；使用 `mediaType` 强制指定 `image`、`video` 或 `audio`。 | `prompt` |
| `ANALYZE_IMAGE` | 使用 AI 视觉分析图像。接受 `imageUrl` 或 `imageBase64` 以及可选的分析 `prompt`。 | `imageUrl` 或 `imageBase64` |

所有媒体操作使用已配置的提供商（默认为 Eliza Cloud，或 FAL/OpenAI/Google/Anthropic）。

<div id="system">

### 系统

</div>

| Action | 描述 |
|--------|------|
| `PLAY_EMOTE` | 在头像上播放表情动画。在目录中查找表情并向本地 API 发送 POST 请求。 |
| `INSTALL_PLUGIN` | 通过 `POST /api/plugins/install` 从注册表安装插件。自动重启以加载。 |
| `SHELL_COMMAND` | 通过 `POST /api/terminal/run` 执行 shell 命令。输出通过 WebSocket 广播。 |
| `LOG_LEVEL` | 设置当前会话的每房间日志级别（`trace`、`debug`、`info`、`warn`、`error`）。 |

<div id="custom-actions">

## 自定义操作

</div>

自定义操作是在你的 `eliza.json` 配置中定义的用户自定义能力。它们允许你连接外部 API、运行 shell 命令或执行内联 JavaScript——所有这些都作为代理在对话期间可以调用的一等操作呈现。

<div id="handler-types">

### 处理器类型

</div>

每个自定义操作都有一个 `handler` 来指定其执行方式：

<CodeGroup>
```json http
{
  "type": "http",
  "method": "POST",
  "url": "https://api.example.com/data/{{query}}",
  "headers": {
    "Authorization": "Bearer sk-xxx",
    "Content-Type": "application/json"
  },
  "bodyTemplate": "{\"search\": \"{{query}}\"}"
}
```

```json shell
{
  "type": "shell",
  "command": "curl -s https://api.example.com/status?q={{query}}"
}
```

```json code
{
  "type": "code",
  "code": "const res = await fetch('https://api.example.com/data/' + params.id); return await res.text();"
}
```
</CodeGroup>

**`http`** -- 发出 HTTP 请求。URL 中的参数占位符（`{{paramName}}`）会进行 URI 编码；正文模板中的占位符保持原样用于 JSON 上下文。字段：`method`、`url`、`headers`、`bodyTemplate`。

<Warning>
HTTP 处理器包含 SSRF 保护，会阻止对私有/内部网络地址（localhost、链路本地、RFC-1918 范围、云元数据端点）的请求。DNS 解析会被检查以防止别名绕过。重定向被完全阻止。
</Warning>

**`shell`** -- 通过本地终端 API 运行 shell 命令。参数值会自动进行 shell 转义以防止注入。通过 `POST /api/terminal/run` 执行。

**`code`** -- 在沙箱化的 Node.js VM 上下文（`vm.runInNewContext()`）中执行内联 JavaScript。沙箱中仅暴露 `params` 和 `fetch`——无法访问 `require`、`import`、`process` 或 `global`。30 秒超时。

<div id="customactiondef-schema">

### CustomActionDef 模式

</div>

| 字段 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `id` | `string` | 是 | 操作的唯一标识符 |
| `name` | `string` | 是 | 代理用于调用操作的名称 |
| `description` | `string` | 是 | 操作功能的可读描述 |
| `similes` | `string[]` | 否 | 操作的替代名称/触发器 |
| `parameters` | `Array<{name, description, required}>` | 是 | 参数定义 |
| `handler` | `CustomActionHandler` | 是 | `http`、`shell` 或 `code` 处理器对象之一 |
| `enabled` | `boolean` | 是 | 操作是否激活 |
| `createdAt` | `string` | 是 | 创建时间的 ISO 时间戳 |
| `updatedAt` | `string` | 是 | 最后更新时间的 ISO 时间戳 |

<div id="defining-custom-actions">

### 定义自定义操作

</div>

在你的 `eliza.json` 中将自定义操作添加到 `customActions` 数组：

```json
{
  "customActions": [
    {
      "id": "weather-check",
      "name": "CHECK_WEATHER",
      "description": "Check the current weather for a given city",
      "similes": ["WEATHER", "GET_WEATHER", "FORECAST"],
      "parameters": [
        {
          "name": "city",
          "description": "The city name to check weather for",
          "required": true
        }
      ],
      "handler": {
        "type": "http",
        "method": "GET",
        "url": "https://wttr.in/{{city}}?format=3"
      },
      "enabled": true,
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:00:00Z"
    }
  ]
}
```

<div id="action-discovery-and-registration">

### 操作发现与注册

</div>

**启动加载：** 在插件初始化时，`loadCustomActions()` 读取 `eliza.json`，仅过滤 `enabled` 的定义，并通过 `defToAction()` 将每个定义转换为 elizaOS `Action`。转换过程会根据处理器类型构建异步处理器，将参数映射为 elizaOS 格式（全部类型为 `string`），并设置 `validate: async () => true`。

**实时注册：** 使用 `registerCustomActionLive(def)` 在运行时注册新操作而无需重启。这使用相同的 `defToAction()` 管线转换定义，并调用 `runtime.registerAction()` 使其立即可用。返回创建的 `Action` 或在没有可用运行时的情况下返回 `null`。

**测试：** `buildTestHandler(def)` 函数创建一个临时处理器用于测试而不进行注册。返回一个接受参数并返回 `{ ok: boolean; output: string }` 的函数。

```typescript
import { buildTestHandler } from './runtime/custom-actions';

const testHandler = buildTestHandler(myActionDef);
const result = await testHandler({ city: 'London' });
// result: { ok: true, output: 'London: +12°C' }
```

<div id="creating-actions-in-plugins">

## 在插件中创建操作

</div>

除了配置定义的自定义操作外，你还可以通过直接实现 `Action` 接口在插件中创建操作。

<Steps>

<div id="define-the-action">

### 定义操作

</div>

```typescript
import type { Action, HandlerOptions } from '@elizaos/core';

export const myAction: Action = {
  name: 'MY_CUSTOM_ACTION',
  similes: ['MY_ACTION', 'DO_THING'],
  description: 'Describe what this action does so the agent knows when to use it.',

  validate: async (runtime, message, state) => {
    // Return true if this action can run in the current context.
    return true;
  },

  handler: async (runtime, message, state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const input = typeof params?.input === 'string' ? params.input.trim() : '';

    if (!input) {
      return { text: 'I need an input parameter.', success: false };
    }

    const result = await doSomething(input);
    return {
      text: `Done: ${result}`,
      success: true,
      data: { input, result },
    };
  },

  parameters: [
    {
      name: 'input',
      description: 'The input value for this action',
      required: true,
      schema: { type: 'string' as const },
    },
  ],
};
```

<div id="write-the-validation-function">

### 编写验证函数

</div>

常见验证模式：

```typescript
// 始终可用
validate: async () => true,

// 仅当特定服务已加载时
validate: async (runtime) => {
  return runtime.getService('myservice') !== null;
},

// 仅限特定用户
validate: async (runtime, message) => {
  const adminIds = ['user-123', 'user-456'];
  return adminIds.includes(message.entityId);
},
```

<div id="write-the-handler-function">

### 编写处理器函数

</div>

处理器接收 `runtime`（IAgentRuntime）、`message`（Memory）、`state`（State | undefined）和 `options`（转换为 `HandlerOptions` 以访问参数）。它必须返回一个包含 `text`（string）和 `success`（boolean）的对象。可选字段：`data`（元数据）和 `attachments`（媒体文件）。

<div id="register-in-a-plugin">

### 在插件中注册

</div>

```typescript
import type { Plugin } from '@elizaos/core';
import { myAction } from './actions/my-action';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'My custom plugin',
  actions: [myAction],
};
```

</Steps>

<div id="action-execution-flow">

## 操作执行流程

</div>

当代理处理消息时，操作按以下顺序评估：

1. **意图匹配** -- 运行时根据对话上下文评估所有已注册操作的名称、similes 和描述。
2. **验证** -- 调用所选操作的 `validate()` 函数。如果返回 `false`，则跳过该操作。
3. **参数提取** -- 运行时根据操作的 `parameters` 定义从对话中提取参数值。
4. **处理器执行** -- 操作的 `handler()` 使用提取的参数运行。
5. **响应交付** -- 处理器的返回值（文本、附件、数据）被交付给用户。

<div id="best-practices">

## 最佳实践

</div>

<Info>

**命名：** 操作名称使用 SCREAMING_SNAKE_CASE。保持名称简短并添加相关的 similes 以改善意图匹配。

**描述：** 代理使用描述来决定何时调用你的操作。编写清晰、具体的描述，说明操作的功能以及何时应该使用它。

**防御性验证：** 始终在处理器中检查必需参数，如果缺少则返回有用的错误消息，即使 `validate()` 返回 `true` 也是如此。

**保持处理器快速：** 对于长时间运行的操作，立即返回状态消息，并使用 WebSocket 或轮询获取进度更新。

**结构化返回：** 始终包含 `success: boolean`。使用 `data` 提供机器可读的元数据，供其他操作或 UI 使用。

</Info>
