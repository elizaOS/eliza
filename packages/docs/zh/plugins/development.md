---
title: "插件开发"
sidebarTitle: "插件开发"
description: "为 Eliza/elizaOS 创建、测试和发布插件。"
---

本指南将引导你完成为 Eliza/elizaOS 创建、测试和发布插件的过程。

<div id="table-of-contents">

## 目录

</div>

1. [插件架构概述](#plugin-architecture-overview)
2. [创建你的第一个插件](#creating-your-first-plugin)
3. [Actions](#actions)
4. [Providers](#providers)
5. [Services](#services)
6. [Routes](#routes)
7. [事件处理器](#event-handlers)
8. [插件测试](#testing-plugins)
9. [插件发布](#publishing-plugins)

---

<div id="plugin-architecture-overview">

## 插件架构概述

</div>

插件是一种模块化扩展，用于为 elizaOS 代理添加功能。插件可以提供：

- **Actions** — 代理可以执行的操作（发送消息、生成图像、重启）
- **Providers** — 注入到代理提示词中的上下文（工作区文件、会话状态）
- **Services** — 长时间运行的后台进程（WebSocket 服务器、轮询循环）
- **Routes** — 通过代理 API 暴露的 HTTP 端点
- **事件处理器** — 运行时事件的回调（消息接收、发送等）
- **Evaluators** — 代理响应的评估逻辑
- **Models** — 用于特定推理类型的自定义模型处理器

<div id="the-plugin-interface">

### 插件接口

</div>

```typescript
import type { Plugin } from "@elizaos/core";

const myPlugin: Plugin = {
  // Required
  name: "my-plugin",
  description: "A brief description of what this plugin does",

  // Optional — called once when the plugin is loaded
  init: async (config, runtime) => {
    // Initialize connections, register workers, etc.
  },

  // Optional — static configuration values
  config: {
    defaultTimeout: 30000,
    maxRetries: 3,
  },

  // Optional — capabilities
  actions: [],      // Action[]
  providers: [],    // Provider[]
  services: [],     // ServiceClass[]
  routes: [],       // Route[]
  events: {},       // { EVENT_NAME: handler[] }
  evaluators: [],   // Evaluator[]

  // Optional — custom model handlers
  models: {
    // TEXT_SMALL: async (runtime, params) => { ... }
  },

  // Optional — plugin load order (higher = loaded later)
  priority: 0,

  // Optional — other plugins this one depends on
  dependencies: ["other-plugin"],

  // Optional — test suites
  tests: [],
};

export default myPlugin;
```

<div id="plugin-lifecycle">

### 插件生命周期

</div>

1. **发现** — 从以下位置发现插件：
   - 内置插件（随 Eliza 一起发布）
   - 工作区插件（`./plugins/`）
   - 全局插件（`~/.eliza/plugins/`）
   - npm 包（`@elizaos/plugin-*`）
   - 配置中指定的插件

2. **加载** — 导入并验证插件模块

3. **依赖解析** — 按依赖关系和优先级对插件进行排序

4. **初始化** — 为每个插件调用 `plugin.init(config, runtime)`

5. **注册** — 将 actions、providers、services、routes 和事件注册到运行时

---

<div id="creating-your-first-plugin">

## 创建你的第一个插件

</div>

<div id="minimal-plugin-structure">

### 最小插件结构

</div>

```
my-plugin/
├── package.json
├── src/
│   └── index.ts
└── tsconfig.json
```

<div id="packagejson">

### package.json

</div>

```json
{
  "name": "@elizaos/plugin-my-feature",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "@elizaos/core": "alpha"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

<div id="srcindexts">

### src/index.ts

</div>

```typescript
import type { Plugin, Action, Provider } from "@elizaos/core";

// A simple action
const greetAction: Action = {
  name: "GREET",
  description: "Greet someone by name",
  similes: ["SAY_HELLO", "WELCOME"],

  validate: async (runtime, message, state) => {
    // Return true if this action can run
    return true;
  },

  handler: async (runtime, message, state, options, callback) => {
    const params = options?.parameters;
    const name = typeof params?.name === "string" ? params.name : "friend";

    return {
      success: true,
      text: `Hello, ${name}! Nice to meet you.`,
    };
  },

  parameters: [
    {
      name: "name",
      description: "The name of the person to greet",
      required: false,
      schema: { type: "string" },
    },
  ],

  examples: [
    [
      { user: "user", content: { text: "Say hi to Alice" } },
      { user: "assistant", content: { text: "Hello, Alice! Nice to meet you.", action: "GREET" } },
    ],
  ],
};

// A simple provider
const statusProvider: Provider = {
  name: "pluginStatus",
  description: "Provides plugin status information",

  get: async (runtime, message, state) => {
    return {
      text: "My Plugin is active and running.",
      values: {
        pluginActive: true,
        version: "1.0.0",
      },
    };
  },
};

// The plugin export
const myPlugin: Plugin = {
  name: "my-plugin",
  description: "A sample plugin demonstrating the basics",

  actions: [greetAction],
  providers: [statusProvider],

  init: async (config, runtime) => {
    runtime.logger?.info("[my-plugin] Initialized!");
  },
};

export default myPlugin;
```

---

<div id="actions">

## Actions

</div>

Actions 是代理可以执行的操作。LLM 根据对话上下文和 action 的描述/示例来选择调用某个 action。

<div id="action-interface">

### Action 接口

</div>

```typescript
interface Action {
  /** Unique action name (uppercase with underscores by convention) */
  name: string;

  /** Human-readable description — shown to the LLM */
  description: string;

  /** Alternative names the LLM might use */
  similes?: string[];

  /** Validation — return true if the action can run */
  validate: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;

  /** Execution handler — performs the action */
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[]
  ) => Promise<ActionResult | undefined>;

  /** Input parameters extracted from conversation */
  parameters?: ActionParameter[];

  /** Example conversations showing usage */
  examples?: ActionExample[][];

  /** Optional priority (higher = evaluated first) */
  priority?: number;

  /** Optional tags for categorization */
  tags?: string[];
}
```

<div id="action-parameters">

### Action 参数

</div>

参数允许 LLM 从对话中提取结构化数据：

```typescript
const sendMessageAction: Action = {
  name: "MESSAGE",
  description: "Send a message to a specific user on a platform",

  parameters: [
    {
      name: "targetUser",
      description: "Username or ID of the recipient",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "message",
      description: "The message content to send",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "platform",
      description: "Platform to send on (telegram, discord, etc.)",
      required: false,
      schema: {
        type: "string",
        enum: ["telegram", "discord", "slack"],
        default: "telegram",
      },
    },
  ],

  validate: async () => true,

  handler: async (runtime, message, state, options) => {
    const params = options?.parameters;

    if (!params?.targetUser || !params?.message) {
      return {
        success: false,
        error: "Missing required parameters: targetUser and message",
      };
    }

    const targetUser = params.targetUser as string;
    const messageText = params.message as string;
    const platform = (params.platform as string) ?? "telegram";

    // Actually send the message...
    await runtime.sendMessage(targetUser, messageText, platform);

    return {
      success: true,
      text: `Message sent to ${targetUser} on ${platform}`,
      data: { targetUser, platform },
    };
  },
};
```

<div id="action-result">

### Action 结果

</div>

Actions 返回一个 `ActionResult` 对象：

```typescript
interface ActionResult {
  /** Whether the action succeeded */
  success: boolean;

  /** Human-readable result text */
  text?: string;

  /** Values to merge into state */
  values?: Record<string, unknown>;

  /** Structured data for programmatic access */
  data?: Record<string, unknown>;

  /** Error information if failed */
  error?: string | Error;

  /** For chained actions — continue to next? */
  continueChain?: boolean;

  /** Cleanup function after completion */
  cleanup?: () => void | Promise<void>;
}
```

---

<div id="providers">

## Providers

</div>

Providers 将上下文注入代理的提示词中。它们在每次 LLM 推理之前被调用，以提供相关信息。

<div id="provider-interface">

### Provider 接口

</div>

```typescript
interface Provider {
  /** Provider name */
  name: string;

  /** Description of what this provider supplies */
  description?: string;

  /** Position in provider list (negative = earlier, positive = later) */
  position?: number;

  /** If true, must be called explicitly (not auto-included) */
  private?: boolean;

  /** Data retrieval function */
  get: (runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>;
}
```

<div id="provider-result">

### Provider 结果

</div>

```typescript
interface ProviderResult {
  /** Human-readable text injected into the prompt */
  text?: string;

  /** Key-value pairs for template substitution */
  values?: Record<string, unknown>;

  /** Structured data for other components */
  data?: Record<string, unknown>;
}
```

<div id="provider-example">

### Provider 示例

</div>

```typescript
const workspaceProvider: Provider = {
  name: "workspace",
  description: "Provides workspace file contents",
  position: -10, // Run early

  get: async (runtime, message, state) => {
    const workspaceDir = runtime.getSetting("WORKSPACE_DIR") || "~/.eliza/workspace";

    // Read key files from workspace
    const agentsMd = await readFile(path.join(workspaceDir, "AGENTS.md"));
    const toolsMd = await readFile(path.join(workspaceDir, "TOOLS.md"));

    const files = [];
    if (agentsMd) files.push(`## AGENTS.md\n${agentsMd}`);
    if (toolsMd) files.push(`## TOOLS.md\n${toolsMd}`);

    return {
      text: files.length > 0
        ? `# Workspace Files\n\n${files.join("\n\n")}`
        : "",
      values: {
        workspaceDir,
        hasAgentsMd: !!agentsMd,
        hasToolsMd: !!toolsMd,
      },
    };
  },
};
```

---

<div id="services">

## Services

</div>

Services 是长时间运行的后台进程。它们在运行时初始化时启动，在运行时关闭时停止。

<div id="creating-a-service">

### 创建 Service

</div>

```typescript
import { Service, ServiceBuilder, type IAgentRuntime } from "@elizaos/core";

// Option 1: Using ServiceBuilder (recommended)
const MyPollingService = new ServiceBuilder("my_polling")
  .withDescription("Polls an external API periodically")
  .withStart(async (runtime: IAgentRuntime) => {
    const intervalMs = 60_000; // 1 minute
    let intervalId: NodeJS.Timeout;

    const poll = async () => {
      try {
        const data = await fetchExternalApi();
        runtime.logger?.info("[my_polling] Polled data:", data);
      } catch (err) {
        runtime.logger?.error("[my_polling] Poll failed:", err);
      }
    };

    // Start polling
    intervalId = setInterval(poll, intervalMs);
    await poll(); // Initial poll

    // Return service instance with stop capability
    return {
      stop: async () => {
        clearInterval(intervalId);
        runtime.logger?.info("[my_polling] Stopped");
      },
    } as Service;
  })
  .build();

// Option 2: Using defineService
import { defineService } from "@elizaos/core";

const MyService = defineService({
  serviceType: "my_service",
  description: "My custom service",

  start: async (runtime) => {
    // Initialize...
    return {
      // Service methods
      doSomething: () => { /* ... */ },
      stop: async () => { /* cleanup */ },
    };
  },

  stop: async () => {
    // Global cleanup if needed
  },
});
```

<div id="using-services-in-a-plugin">

### 在插件中使用 Services

</div>

```typescript
const myPlugin: Plugin = {
  name: "my-plugin",
  description: "Plugin with a background service",

  services: [MyPollingService],

  actions: [
    {
      name: "CHECK_SERVICE",
      description: "Check if the polling service is running",
      validate: async () => true,
      handler: async (runtime) => {
        const service = runtime.getService("my_polling");
        return {
          success: true,
          text: service ? "Polling service is active" : "Service not found",
        };
      },
    },
  ],
};
```

---

<div id="routes">

## Routes

</div>

Routes 通过代理的 API 服务器暴露 HTTP 端点。

<div id="route-types">

### Route 类型

</div>

```typescript
type Route = {
  type: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "STATIC";
  path: string;
  handler?: (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => Promise<void>;

  // For public routes (accessible without auth)
  public?: boolean;
  name?: string; // Required if public: true

  // For file uploads
  isMultipart?: boolean;

  // For static file serving
  filePath?: string; // Only for type: "STATIC"
};
```

<div id="route-example">

### Route 示例

</div>

```typescript
const myPlugin: Plugin = {
  name: "api-plugin",
  description: "Adds custom API endpoints",

  routes: [
    // Public GET endpoint
    {
      type: "GET",
      path: "/api/my-plugin/status",
      public: true,
      name: "my-plugin-status",
      handler: async (req, res, runtime) => {
        res.status(200).json({
          status: "ok",
          agentId: runtime.agentId,
          timestamp: Date.now(),
        });
      },
    },

    // Protected POST endpoint
    {
      type: "POST",
      path: "/api/my-plugin/action",
      handler: async (req, res, runtime) => {
        const { action, data } = req.body ?? {};

        if (!action) {
          res.status(400).json({ error: "Missing action parameter" });
          return;
        }

        // Process the action...
        const result = await processAction(action, data);

        res.status(200).json({ result });
      },
    },

    // File upload endpoint
    {
      type: "POST",
      path: "/api/my-plugin/upload",
      isMultipart: true,
      handler: async (req, res, runtime) => {
        // Handle multipart form data...
        res.status(200).json({ uploaded: true });
      },
    },

    // Static file serving
    {
      type: "STATIC",
      path: "/my-plugin/assets",
      filePath: "./assets",
    },
  ],
};
```

---

<div id="event-handlers">

## 事件处理器

</div>

事件处理器响应运行时事件，如消息接收、消息发送或世界连接。

<div id="available-events">

### 可用事件

</div>

```typescript
type EventName =
  | "MESSAGE_RECEIVED"      // Inbound message from user/channel
  | "MESSAGE_SENT"          // Outbound message from agent
  | "VOICE_MESSAGE_RECEIVED" // Voice/audio message
  | "WORLD_CONNECTED"       // Connected to a world/server
  | "WORLD_JOINED"          // Joined a room/channel
  | "ACTION_STARTED"        // Action execution began
  | "ACTION_COMPLETED"      // Action execution finished
  // ... and more
```

<div id="event-handler-example">

### 事件处理器示例

</div>

```typescript
import type { MessagePayload } from "@elizaos/core";

const myPlugin: Plugin = {
  name: "event-plugin",
  description: "Demonstrates event handling",

  events: {
    MESSAGE_RECEIVED: [
      async (payload: MessagePayload) => {
        const { runtime, message, source } = payload;

        // Log all incoming messages
        runtime.logger?.info(`[event-plugin] Message from ${source}:`, message.content?.text);

        // Inject metadata
        if (message.metadata) {
          (message.metadata as Record<string, unknown>).processedByEventPlugin = true;
        }
      },
    ],

    MESSAGE_SENT: [
      async (payload: MessagePayload) => {
        const { runtime, message } = payload;

        // Track outgoing messages
        runtime.logger?.info(`[event-plugin] Sent message:`, message.content?.text);
      },
    ],
  },
};
```

---

<div id="testing-plugins">

## 插件测试

</div>

<div id="unit-tests-with-vitest">

### 使用 Vitest 进行单元测试

</div>

```typescript
// my-plugin.test.ts
import { describe, it, expect, vi } from "vitest";
import myPlugin from "./index";

describe("my-plugin", () => {
  it("has required properties", () => {
    expect(myPlugin.name).toBe("my-plugin");
    expect(myPlugin.description).toBeDefined();
  });

  it("greet action validates correctly", async () => {
    const greetAction = myPlugin.actions?.find(a => a.name === "GREET");
    expect(greetAction).toBeDefined();

    const mockRuntime = { logger: console } as any;
    const mockMessage = { content: { text: "hello" } } as any;

    const isValid = await greetAction!.validate(mockRuntime, mockMessage);
    expect(isValid).toBe(true);
  });

  it("greet action returns greeting", async () => {
    const greetAction = myPlugin.actions?.find(a => a.name === "GREET");

    const mockRuntime = { logger: console } as any;
    const mockMessage = { content: { text: "say hi to Bob" } } as any;
    const options = { parameters: { name: "Bob" } };

    const result = await greetAction!.handler(mockRuntime, mockMessage, undefined, options);

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Bob");
  });
});
```

<div id="integration-tests">

### 集成测试

</div>

```typescript
// integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRuntime } from "@elizaos/core";
import myPlugin from "./index";

describe("my-plugin integration", () => {
  let runtime: any;

  beforeAll(async () => {
    runtime = await createRuntime({
      plugins: [myPlugin],
      // Test configuration...
    });
  });

  afterAll(async () => {
    await runtime?.stop();
  });

  it("plugin initializes correctly", async () => {
    const service = runtime.getService("my_service");
    expect(service).toBeDefined();
  });
});
```

---

<div id="publishing-plugins">

## 插件发布

</div>

<div id="npm-publishing">

### npm 发布

</div>

1. **选择包名称：**
   - 官方：`@elizaos/plugin-{name}`
   - 社区：`elizaos-plugin-{name}` 或带作用域的 `@yourorg/plugin-{name}`

2. **构建你的插件：**
   ```bash
   bun run build
   ```

3. **发布：**
   ```bash
   bun publish --access public
   ```

<div id="local-development">

### 本地开发

</div>

无需发布即可进行本地插件开发：

1. **工作区发现** — 将你的插件放在：
   - `./plugins/my-plugin/`（项目本地）
   - `~/.eliza/plugins/my-plugin/`（全局）

2. **基于配置的加载** — 添加到 `eliza.json`：
   ```json
   {
     "plugins": ["./path/to/my-plugin"]
   }
   ```

3. **用于开发的符号链接：**
   ```bash
   cd ~/.eliza/plugins
   ln -s /path/to/my-plugin my-plugin
   ```

---

<div id="plugin-manifest-system">

## 插件清单系统

</div>

插件可以包含一个 `elizaos.plugin.json` 清单文件以提供丰富的元数据：

<div id="manifest-structure">

### 清单结构

</div>

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "A plugin that does awesome things",
  "version": "1.0.0",
  "kind": "skill",
  
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
      "timeout": { "type": "number", "default": 30000 }
    },
    "required": ["apiKey"]
  },
  
  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "type": "password",
      "sensitive": true,
      "help": "Get your API key from the dashboard"
    },
    "timeout": {
      "label": "Timeout (ms)",
      "type": "number",
      "advanced": true
    }
  },
  
  "requiredSecrets": ["MY_PLUGIN_API_KEY"],
  "optionalSecrets": ["MY_PLUGIN_DEBUG"],
  "dependencies": ["other-plugin"],
  
  "channels": [],
  "providers": ["myContext"],
  "skills": [],
  "gatewayMethods": [],
  "cliCommands": []
}
```

<div id="pluginkind-types">

### PluginKind 类型

</div>

| Kind | 描述 |
|------|------|
| `memory` | 内存/存储适配器 |
| `channel` | 消息平台连接器 |
| `provider` | 上下文/数据提供者 |
| `skill` | 基于技能的扩展 |
| `database` | 数据库适配器 |

<div id="pluginorigin-types">

### PluginOrigin 类型

</div>

指示插件的发现来源：

| Origin | 描述 |
|--------|------|
| `bundled` | 随 Eliza 一起发布 |
| `global` | 来自 `~/.eliza/plugins/` |
| `workspace` | 来自 `./plugins/` |
| `config` | 在配置中显式列出 |
| `npm` | 已安装的 npm 包 |

---

<div id="evaluators">

## Evaluators

</div>

Evaluators 评估代理的响应，并可以触发后续操作。

<div id="evaluator-interface">

### Evaluator 接口

</div>

```typescript
interface Evaluator {
  /** Evaluator name */
  name: string;

  /** Description of what this evaluator checks */
  description: string;

  /** Always run this evaluator (vs. sampled) */
  alwaysRun?: boolean;

  /** Similar evaluator descriptions */
  similes?: string[];

  /** Example evaluations for LLM guidance */
  examples: EvaluationExample[];

  /** Validation function */
  validate: Validator;

  /** Handler that performs the evaluation */
  handler: Handler;
}
```

<div id="evaluator-example">

### Evaluator 示例

</div>

```typescript
const factCheckEvaluator: Evaluator = {
  name: "FACT_CHECK",
  description: "Verify factual claims in responses",
  alwaysRun: false,

  examples: [
    {
      messages: [
        { user: "user", content: { text: "What's the capital of France?" } },
        { user: "assistant", content: { text: "Paris is the capital of France." } },
      ],
    },
  ],

  validate: async (runtime, message) => {
    // Only evaluate responses with factual claims
    const text = message.content?.text ?? "";
    return text.includes("is") || text.includes("was");
  },

  handler: async (runtime, message, state) => {
    // Perform fact checking...
    return {
      success: true,
      text: "Fact check passed",
      data: { verified: true },
    };
  },
};
```

---

<div id="model-overrides">

## 模型覆盖

</div>

插件可以为特定推理类型注册自定义模型处理器。

<div id="available-model-types">

### 可用模型类型

</div>

```typescript
const ModelType = {
  // Text generation
  TEXT_SMALL: "TEXT_SMALL",       // Fast, cheap, simple tasks
  TEXT_LARGE: "TEXT_LARGE",       // Complex reasoning
  TEXT_COMPLETION: "TEXT_COMPLETION",

  // Embeddings
  TEXT_EMBEDDING: "TEXT_EMBEDDING",

  // Tokenization
  TEXT_TOKENIZER_ENCODE: "TEXT_TOKENIZER_ENCODE",
  TEXT_TOKENIZER_DECODE: "TEXT_TOKENIZER_DECODE",

  // Media
  IMAGE: "IMAGE",                          // Image generation
  IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",  // Vision/analysis
  TRANSCRIPTION: "TRANSCRIPTION",          // Speech-to-text
  TEXT_TO_SPEECH: "TEXT_TO_SPEECH",        // TTS
  AUDIO: "AUDIO",                          // Audio processing
  VIDEO: "VIDEO",                          // Video processing

  // Structured output
  OBJECT_SMALL: "OBJECT_SMALL",
  OBJECT_LARGE: "OBJECT_LARGE",

  // Research
  RESEARCH: "RESEARCH",
};
```

<div id="registering-model-handlers">

### 注册模型处理器

</div>

```typescript
const myPlugin: Plugin = {
  name: "custom-model-plugin",
  description: "Provides custom model handlers",

  models: {
    TEXT_SMALL: async (runtime, params) => {
      const { prompt, maxTokens, temperature } = params as GenerateTextParams;

      // Call your custom model...
      const response = await myCustomModel.generate(prompt, {
        maxTokens,
        temperature,
      });

      return {
        text: response.content,
        usage: {
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
        },
      };
    },

    IMAGE: async (runtime, params) => {
      const { prompt, width, height } = params as ImageGenerationParams;

      const imageUrl = await myImageModel.generate(prompt, width, height);

      return {
        images: [{ url: imageUrl }],
      };
    },
  },
};
```

---

<div id="entity-component-types">

## 实体组件类型

</div>

插件可以为实体定义自定义组件类型：

```typescript
const myPlugin: Plugin = {
  name: "entity-plugin",
  description: "Adds custom entity components",

  componentTypes: [
    {
      name: "userPreferences",
      schema: {
        type: "object",
        properties: {
          theme: { type: "string", enum: ["light", "dark"] },
          language: { type: "string" },
          notifications: { type: "boolean" },
        },
        required: ["theme"],
      },
      validator: (data) => {
        return data.theme === "light" || data.theme === "dark";
      },
    },
  ],
};
```

---

<div id="config-schema-validation-with-zod">

## 使用 Zod 进行配置模式验证

</div>

使用 Zod 对插件配置进行运行时验证：

```typescript
import { z } from "zod";
import type { Plugin } from "@elizaos/core";

// Define config schema
const ConfigSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
  baseUrl: z.string().url().optional(),
  timeout: z.number().positive().default(30000),
  retries: z.number().int().min(0).max(10).default(3),
  debug: z.boolean().default(false),
});

type PluginConfig = z.infer<typeof ConfigSchema>;

const myPlugin: Plugin = {
  name: "validated-plugin",
  description: "Plugin with Zod-validated config",

  init: async (config, runtime) => {
    // Validate and parse config
    const parsed = ConfigSchema.safeParse(config);

    if (!parsed.success) {
      const errors = parsed.error.errors
        .map(e => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      throw new Error(`Invalid config: ${errors}`);
    }

    const validConfig: PluginConfig = parsed.data;

    runtime.logger?.info("[validated-plugin] Config validated", {
      baseUrl: validConfig.baseUrl,
      timeout: validConfig.timeout,
      debug: validConfig.debug,
    });

    // Use validated config...
  },
};
```

---

<div id="best-practices">

## 最佳实践

</div>

1. **描述性名称** — Action 名称应清晰并使用大写字母加下划线（UPPERCASE_WITH_UNDERSCORES）
2. **良好的示例** — 提供对话示例，让 LLM 知道何时使用你的 action
3. **验证输入** — 使用参数前始终进行验证
4. **优雅地处理错误** — 在 ActionResult 中返回有意义的错误消息
5. **适当地记录日志** — 使用 `runtime.logger` 进行调试，不要使用 console.log
6. **清理资源** — Services 应正确停止并释放资源
7. **记录配置文档** — 列出所需的环境变量和设置
8. **全面测试** — 对 actions/providers 进行单元测试，对完整插件进行集成测试
9. **使用 Zod 验证配置** — 运行时验证可以尽早捕获配置错误
10. **包含清单** — 添加 `elizaos.plugin.json` 以实现丰富的 UI 集成

---

<div id="next-steps">

## 后续步骤

</div>

- [Skills 文档](/zh/plugins/skills) — 了解基于 markdown 的技能扩展
- [注册表指南](/zh/plugins/registry) — 发布到插件注册表
- [贡献指南](/zh/guides/contributing) — 为 Eliza/elizaOS 做贡献
