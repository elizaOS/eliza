---
title: "Plugin Development"
sidebarTitle: "Plugin Development"
description: "Create, test, and publish plugins for elizaOS."
---

This guide walks you through creating, testing, and publishing plugins for elizaOS.

## Table of Contents

1. [Plugin Architecture Overview](#plugin-architecture-overview)
2. [Creating Your First Plugin](#creating-your-first-plugin)
3. [Actions](#actions)
4. [Providers](#providers)
5. [Services](#services)
6. [Routes](#routes)
7. [Event Handlers](#event-handlers)
8. [Testing Plugins](#testing-plugins)
9. [Publishing Plugins](#publishing-plugins)

---

## Plugin Architecture Overview

A plugin is a modular extension that adds capabilities to an elizaOS agent. Plugins can provide:

- **Actions** — Things the agent can do (send messages, generate images, restart)
- **Providers** — Context injected into the agent's prompts (workspace files, session state)
- **Services** — Long-running background processes (WebSocket servers, polling loops)
- **Routes** — HTTP endpoints exposed by the agent's API
- **Event Handlers** — Callbacks for runtime events (message received, sent, etc.)
- **Evaluators** — Assessment logic for agent responses
- **Models** — Custom model handlers for specific inference types

### The Plugin Interface

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

### Plugin Lifecycle

1. **Discovery** — Plugins are discovered from:
   - Bundled plugins (shipped with Eliza)
   - Workspace plugins (`./plugins/`)
   - Global plugins (`~/.eliza/plugins/`)
   - npm packages (`@elizaos/plugin-*`)
   - Config-specified plugins

2. **Loading** — Plugin modules are imported and validated

3. **Dependency Resolution** — Plugins are sorted by dependencies and priority

4. **Initialization** — `plugin.init(config, runtime)` is called for each plugin

5. **Registration** — Actions, providers, services, routes, and events are registered with the runtime

---

## Creating Your First Plugin

### Minimal Plugin Structure

```
my-plugin/
├── package.json
├── src/
│   └── index.ts
└── tsconfig.json
```

### package.json

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

### src/index.ts

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

## Actions

Actions are things the agent can do. The LLM chooses to invoke an action based on the conversation context and the action's description/examples.

### Action Interface

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

### Action Parameters

Parameters allow the LLM to extract structured data from the conversation:

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

    // Send the message via the appropriate connector service
    // (implementation depends on the platform connector plugin)

    return {
      success: true,
      text: `Message sent to ${targetUser} on ${platform}`,
      data: { targetUser, platform },
    };
  },
};
```

### Action Result

Actions return an `ActionResult` object:

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

## Providers

Providers inject context into the agent's prompt. They're called before each LLM inference to supply relevant information.

### Provider Interface

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

### Provider Result

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

### Provider Example

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

## Services

Services are long-running background processes. They start when the runtime initializes and stop when it shuts down.

### Creating a Service

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

### Using Services in a Plugin

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

## Routes

Routes expose HTTP endpoints through the agent's API server.

### Route Types

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

### Route Example

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

## Event Handlers

Event handlers react to runtime events like messages received, sent, or world connections.

### Available Events

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

### Event Handler Example

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

## Testing Plugins

### Unit Tests with Vitest

```typescript
// my-plugin.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createMessageMemory, stringToUuid, type Memory } from "@elizaos/core";
import { createTestRuntime, type TestRuntimeResult } from "@elizaos/core";
import myPlugin from "./index";

function createTestMessage(text: string): Memory {
  return createMessageMemory({
    entityId: stringToUuid("test-user"),
    roomId: stringToUuid("test-room"),
    content: { text },
  });
}

describe("my-plugin", () => {
  let testRuntime: TestRuntimeResult;

  beforeAll(async () => {
    testRuntime = await createTestRuntime();
  });

  afterAll(async () => {
    await testRuntime.cleanup();
  });

  it("has required properties", () => {
    expect(myPlugin.name).toBe("my-plugin");
    expect(myPlugin.description).toBeDefined();
  });

  it("greet action validates correctly", async () => {
    const greetAction = myPlugin.actions?.find(a => a.name === "GREET");
    expect(greetAction).toBeDefined();

    const mockRuntime = testRuntime.runtime;
    const mockMessage = createTestMessage("hello");

    const isValid = await greetAction!.validate(mockRuntime, mockMessage);
    expect(isValid).toBe(true);
  });

  it("greet action returns greeting", async () => {
    const greetAction = myPlugin.actions?.find(a => a.name === "GREET");

    const mockRuntime = testRuntime.runtime;
    const mockMessage = createTestMessage("say hi to Bob");
    const options = { parameters: { name: "Bob" } };

    const result = await greetAction!.handler(mockRuntime, mockMessage, undefined, options);

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("Bob");
  });
});
```

### Integration Tests

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

## Publishing Plugins

### npm Publishing

1. **Choose a package name:**
   - Official: `@elizaos/plugin-{name}`
   - Community: `elizaos-plugin-{name}` or scoped `@yourorg/plugin-{name}`

2. **Build your plugin:**
   ```bash
   bun run build
   ```

3. **Publish:**
   ```bash
   bun publish --access public
   ```

### Local Development

For local plugin development without publishing:

1. **Workspace discovery** — Place your plugin in:
   - `./plugins/my-plugin/` (project-local)
   - `~/.eliza/plugins/custom/my-plugin/` (global drop-in)

2. **Config-based loading** — Add to `eliza.json`:
   ```json
   {
     "plugins": ["./path/to/my-plugin"]
   }
   ```

3. **Symlink for development:**
   ```bash
   cd ~/.eliza/plugins/custom
   ln -s /path/to/my-plugin my-plugin
   ```

---

## Plugin Manifest System

Plugins can include an `elizaos.plugin.json` manifest file for rich metadata:

### Manifest Structure

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

### PluginKind Types

| Kind | Description |
|------|-------------|
| `ai-provider` | AI/LLM model providers |
| `app` | Application plugins |
| `connector` | Messaging platform connectors |
| `feature` | Feature extensions and skills |
| `database` | Database adapters |

### PluginOrigin Types

Indicates where a plugin was discovered:

| Origin | Description |
|--------|-------------|
| `bundled` | Shipped with Eliza |
| `global` | From `~/.eliza/plugins/` |
| `workspace` | From `./plugins/` |
| `config` | Explicitly listed in config |
| `npm` | Installed npm package |

---

## Evaluators

Evaluators assess agent responses and can trigger follow-up actions.

### Evaluator Interface

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

### Evaluator Example

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

## Model Overrides

Plugins can register custom model handlers for specific inference types.

### Available Model Types

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

  // Research
  RESEARCH: "RESEARCH",
};
```

### Registering Model Handlers

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

## Entity Component Types

Plugins can define custom component types for entities:

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

## Config Schema Validation with Zod

Use Zod for runtime validation of plugin configuration:

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

## Best Practices

1. **Descriptive names** — Action names should be clear and UPPERCASE_WITH_UNDERSCORES
2. **Good examples** — Provide conversation examples so the LLM knows when to use your action
3. **Validate inputs** — Always validate parameters before using them
4. **Handle errors gracefully** — Return meaningful error messages in ActionResult
5. **Log appropriately** — Use `runtime.logger` for debugging, not console.log
6. **Clean up resources** — Services should properly stop and release resources
7. **Document configuration** — List required environment variables and settings
8. **Test thoroughly** — Unit test actions/providers, integration test the full plugin
9. **Use Zod for config** — Runtime validation catches configuration errors early
10. **Include manifest** — Add `elizaos.plugin.json` for rich UI integration

---

## Next Steps

- [Skills Documentation](/plugins/skills) — Learn about markdown-based skill extensions
- [Registry Guide](/plugins/registry) — Publishing to the plugin registry
- [Contributing Guide](/guides/contributing) — Contributing to Eliza/elizaOS
