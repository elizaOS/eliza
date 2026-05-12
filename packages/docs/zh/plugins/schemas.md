---
title: "插件模式定义"
sidebarTitle: "模式定义"
description: "插件清单、操作、提供者、评估器、服务、路由和模型处理器的完整模式参考。"
---

本页记录了 Eliza/elizaOS 中每个插件原语的 TypeScript 接口和 JSON 模式。

<div id="plugin-interface">

## Plugin Interface

</div>

插件包的顶层导出。

```typescript
interface Plugin {
  /** Unique plugin name (kebab-case recommended) */
  name: string;

  /** Human-readable description shown in the admin panel */
  description: string;

  /** Called once when the plugin is loaded by the runtime */
  init?: (config: Record<string, unknown>, runtime: IAgentRuntime) => Promise<void>;

  /** Static configuration defaults */
  config?: Record<string, unknown>;

  /** Things the agent can do */
  actions?: Action[];

  /** Context injected into the agent prompt */
  providers?: Provider[];

  /** Post-response assessment logic */
  evaluators?: Evaluator[];

  /** Long-running background processes */
  services?: ServiceClass[];

  /** HTTP endpoints exposed by the API server */
  routes?: Route[];

  /** Runtime event callbacks */
  events?: Record<string, EventHandler[]>;

  /** Custom model inference handlers */
  models?: Record<string, ModelHandler>;

  /** Custom entity component type definitions */
  componentTypes?: ComponentType[];

  /** Load order relative to other plugins (higher = loaded later) */
  priority?: number;

  /** Plugin names this plugin depends on (ensures ordering) */
  dependencies?: string[];

  /** Test suites included with the plugin */
  tests?: TestSuite[];
}
```

<div id="action-schema">

## Action Schema

</div>

```typescript
interface Action {
  /** Unique name in SCREAMING_SNAKE_CASE */
  name: string;

  /** Shown to the LLM — determines when the action is selected */
  description: string;

  /** Alternative names the LLM may use to invoke this action */
  similes?: string[];

  /**
   * Return true when this action can run in the current context.
   * Called before every potential invocation.
   */
  validate: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ) => Promise<boolean>;

  /**
   * Perform the action. Return an ActionResult or undefined.
   * Do not throw — return success: false with an error message instead.
   */
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[],
  ) => Promise<ActionResult | undefined>;

  /** Structured parameters the LLM extracts from the conversation */
  parameters?: ActionParameter[];

  /** Example conversations demonstrating usage (guides LLM selection) */
  examples?: ActionExample[][];

  /** Evaluation priority — higher values are checked first */
  priority?: number;

  /** Optional categorization tags */
  tags?: string[];
}

interface ActionParameter {
  name: string;
  description: string;
  required: boolean;
  schema: JsonSchema;
}

interface ActionResult {
  success: boolean;
  text?: string;
  values?: Record<string, unknown>;
  data?: Record<string, unknown>;
  error?: string | Error;
  continueChain?: boolean;
  cleanup?: () => void | Promise<void>;
}
```

<div id="provider-schema">

## Provider Schema

</div>

```typescript
interface Provider {
  /** Provider name — used for logging and deduplication */
  name: string;

  /** Description of what context this provider supplies */
  description?: string;

  /**
   * Ordering hint. Negative values run before core providers.
   * Positive values run after. Default: 0.
   */
  position?: number;

  /**
   * If true, this provider is NOT included automatically.
   * Must be referenced explicitly in prompts.
   */
  private?: boolean;

  /** Returns context to inject into the agent prompt */
  get: (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ) => Promise<ProviderResult>;
}

interface ProviderResult {
  /** Text block injected into the prompt */
  text?: string;

  /** Key-value pairs for template substitution */
  values?: Record<string, unknown>;

  /** Structured data for programmatic access */
  data?: Record<string, unknown>;
}
```

<div id="evaluator-schema">

## Evaluator Schema

</div>

```typescript
interface Evaluator {
  /** Evaluator name */
  name: string;

  /** Description of what this evaluator checks */
  description: string;

  /**
   * If true, runs after every response.
   * If false (default), runs probabilistically based on examples.
   */
  alwaysRun?: boolean;

  /** Alternative descriptions */
  similes?: string[];

  /** Example input/output pairs for LLM guidance */
  examples: EvaluationExample[];

  /** Return true if this evaluator applies to the current context */
  validate: Validator;

  /** Perform the evaluation — can trigger side effects or follow-ups */
  handler: Handler;
}

interface EvaluationExample {
  messages: Array<{
    user: string;
    content: { text: string };
  }>;
}
```

<div id="service-schema">

## Service Schema

</div>

```typescript
interface ServiceDefinition {
  /** Unique service type identifier (used by runtime.getService()) */
  serviceType: string;

  /** Human-readable description */
  description?: string;

  /**
   * Called when the runtime starts.
   * Must return a Service instance with a stop() method.
   */
  start: (runtime: IAgentRuntime) => Promise<Service>;

  /** Optional global cleanup called when the runtime stops */
  stop?: () => Promise<void>;
}

interface Service {
  stop: () => Promise<void>;
  [key: string]: unknown; // Additional public service methods
}
```

<div id="route-schema">

## Route Schema

</div>

```typescript
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Route {
  type: HttpMethod | "STATIC";
  path: string;

  /** Route handler — omit only for STATIC routes */
  handler?: (
    req: RouteRequest,
    res: RouteResponse,
    runtime: IAgentRuntime,
  ) => Promise<void>;

  /** If true, accessible without authentication */
  public?: boolean;

  /** Required when public: true */
  name?: string;

  /** Set to true to accept multipart/form-data uploads */
  isMultipart?: boolean;

  /** Directory path to serve (STATIC routes only) */
  filePath?: string;
}
```

<div id="model-handler-schema">

## Model Handler Schema

</div>

```typescript
type ModelHandler = (
  runtime: IAgentRuntime,
  params: GenerateTextParams | ImageGenerationParams | EmbeddingParams | unknown,
) => Promise<ModelResult>;

// Available model type keys:
const MODEL_TYPES = [
  "TEXT_SMALL",           // Fast text generation
  "TEXT_LARGE",           // Large context text generation
  "TEXT_COMPLETION",      // Completion-style generation
  "TEXT_EMBEDDING",       // Embedding vectors
  "TEXT_TOKENIZER_ENCODE",
  "TEXT_TOKENIZER_DECODE",
  "IMAGE",                // Image generation
  "IMAGE_DESCRIPTION",    // Vision / image analysis
  "TRANSCRIPTION",        // Speech-to-text
  "TEXT_TO_SPEECH",       // TTS
  "AUDIO",                // Audio processing
  "VIDEO",                // Video processing
  "RESEARCH",             // Research/search-augmented generation
] as const;
```

<div id="plugin-manifest-elizaosplugin-json">

## Plugin Manifest (elizaos.plugin.json)

</div>

可选的 JSON 清单，用于丰富的用户界面集成和市场元数据。

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "A plugin that does useful things",
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
      "label": "Request Timeout (ms)",
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

<div id="kind-values">

### kind 值

</div>

| 值 | 描述 |
|------|------|
| `memory` | 内存或存储适配器 |
| `channel` | 消息平台连接器 |
| `provider` | 上下文或数据提供者 |
| `skill` | 基于技能的功能扩展 |
| `database` | 数据库适配器 |

<div id="component-type-schema">

## Component Type Schema

</div>

用于定义附加到实体记录的自定义结构化数据。

```typescript
interface ComponentType {
  /** Component type identifier */
  name: string;

  /** JSON Schema for the component's data shape */
  schema: JsonSchema;

  /** Optional runtime validation function */
  validator?: (data: unknown) => boolean;
}
```

<div id="related">

## 相关内容

</div>

- [创建插件](/zh/plugins/create-a-plugin) — 从零开始构建插件
- [插件模式](/zh/plugins/patterns) — 常见实现模式
- [插件架构](/zh/plugins/architecture) — 系统设计与生命周期
