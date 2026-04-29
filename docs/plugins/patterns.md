---
title: "Plugin Patterns"
sidebarTitle: "Patterns"
description: "Common plugin implementation patterns — singleton services, state providers, action chains, evaluator pipelines, error handling, and testing."
---

This page documents proven patterns for building reliable, maintainable Milady plugins.

## Singleton Service

Use a module-level variable to ensure only one instance of a resource exists, even if the plugin is initialized multiple times.

```typescript
import type { IAgentRuntime, Plugin, Service } from "@elizaos/core";

// Module-level singleton — shared across all calls to start()
let _connection: DatabaseConnection | undefined;

async function getConnection(): Promise<DatabaseConnection> {
  if (!_connection) {
    _connection = await DatabaseConnection.connect(process.env.DATABASE_URL!);
  }
  return _connection;
}

const dbService = {
  serviceType: "my_database",
  start: async (_runtime: IAgentRuntime): Promise<Service> => {
    await getConnection(); // Warm up the connection
    return {
      stop: async () => {
        await _connection?.disconnect();
        _connection = undefined;
      },
    } as Service;
  },
};

const myPlugin: Plugin = {
  name: "my-db-plugin",
  description: "Database plugin with singleton connection",
  services: [dbService as any],
};
```

## State Provider Pattern

Providers should be stateless — derive everything from the runtime or external sources rather than storing state in the closure.

```typescript
import type { Provider } from "@elizaos/core";

const accountProvider: Provider = {
  name: "accountContext",
  description: "Provides user account information from the current session",
  position: -5, // Run early so other providers can reference account data

  get: async (runtime, message, _state) => {
    // Derive from runtime settings — no local state
    const userId = message.entityId;
    const account = await runtime.getEntityById(userId);

    if (!account) {
      return { text: "", values: { hasAccount: false } };
    }

    return {
      text: `Current user: ${account.name} (ID: ${userId})`,
      values: {
        hasAccount: true,
        userId,
        userName: account.name,
      },
    };
  },
};
```

## Action Chain Pattern

Actions can trigger other actions by setting `continueChain: true` in the result and including metadata for the next action.

```typescript
import type { Action } from "@elizaos/core";

const fetchDataAction: Action = {
  name: "FETCH_AND_PROCESS",
  description: "Fetch data from API then process it",
  validate: async () => true,

  handler: async (runtime, message, state, options) => {
    // Step 1: Fetch
    const rawData = await fetch("https://api.example.com/data").then(r => r.json());

    // Pass data to next action via state
    return {
      success: true,
      text: "Data fetched, processing...",
      continueChain: true,
      data: { rawData },
      values: { pendingData: rawData },
    };
  },
};

const processDataAction: Action = {
  name: "PROCESS_DATA",
  description: "Process previously fetched data",
  validate: async (_runtime, _message, state) => {
    // Only valid when there is pending data
    return Boolean((state?.values as Record<string, unknown>)?.pendingData);
  },

  handler: async (_runtime, _message, state, _options) => {
    const data = (state?.values as Record<string, unknown>)?.pendingData;
    const processed = processData(data);

    return {
      success: true,
      text: `Processed ${processed.count} records`,
      data: { processed },
    };
  },
};

function processData(data: unknown) {
  // Transform data...
  return { count: Array.isArray(data) ? data.length : 0 };
}
```

## Configuration Pattern

Validate all required configuration in `init()` and fail loudly rather than silently operating in a degraded state.

```typescript
import { z } from "zod";
import type { Plugin } from "@elizaos/core";

const ConfigSchema = z.object({
  apiKey: z.string().min(1, "API key is required"),
  baseUrl: z.string().url().default("https://api.example.com"),
  timeout: z.number().int().positive().default(30_000),
  retries: z.number().int().min(0).max(10).default(3),
});

type Config = z.infer<typeof ConfigSchema>;
let _config: Config | undefined;

const myPlugin: Plugin = {
  name: "configured-plugin",
  description: "Plugin with validated configuration",

  init: async (rawConfig, runtime) => {
    // Pull from config object OR environment variables
    const input = {
      apiKey: (rawConfig?.apiKey as string) || process.env.MY_PLUGIN_API_KEY,
      baseUrl: (rawConfig?.baseUrl as string) || process.env.MY_PLUGIN_BASE_URL,
      timeout: rawConfig?.timeout,
      retries: rawConfig?.retries,
    };

    const result = ConfigSchema.safeParse(input);
    if (!result.success) {
      const messages = result.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join("; ");
      throw new Error(`[configured-plugin] Invalid configuration: ${messages}`);
    }

    _config = result.data;
    runtime.logger?.info("[configured-plugin] Config validated", {
      baseUrl: _config.baseUrl,
      timeout: _config.timeout,
    });
  },

  actions: [],
};

export default myPlugin;
```

## Error Handling Pattern

Always return structured errors instead of throwing from action handlers. Reserve throws for unrecoverable initialization failures.

```typescript
import type { Action } from "@elizaos/core";

const safeAction: Action = {
  name: "SAFE_OPERATION",
  description: "Demonstrates safe error handling",
  validate: async () => true,

  handler: async (runtime, _message, _state, options) => {
    try {
      const params = options?.parameters as Record<string, unknown> | undefined;

      // Validate parameters
      if (!params?.targetId) {
        return {
          success: false,
          error: "Missing required parameter: targetId",
        };
      }

      const targetId = String(params.targetId);

      // Validate business rules
      if (targetId.length > 64) {
        return {
          success: false,
          error: "targetId exceeds maximum length of 64 characters",
        };
      }

      // Perform operation
      const result = await performOperation(targetId);

      return {
        success: true,
        text: `Operation completed: ${result.summary}`,
        data: result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.logger?.error("[SAFE_OPERATION] Unexpected error:", message);
      return {
        success: false,
        error: `Unexpected error: ${message}`,
      };
    }
  },
};

async function performOperation(id: string) {
  return { summary: `Processed ${id}` };
}
```

## Evaluator Pipeline Pattern

Evaluators run after the agent generates a response. Chain multiple evaluators for layered post-processing.

```typescript
import type { Evaluator } from "@elizaos/core";

// First evaluator: detect intent
const intentEvaluator: Evaluator = {
  name: "DETECT_INTENT",
  description: "Classify the user's intent from the conversation",
  alwaysRun: true,

  examples: [],
  validate: async () => true,

  handler: async (runtime, message, state) => {
    const text = message.content?.text ?? "";
    const intent = classifyIntent(text);

    return {
      success: true,
      text: `Detected intent: ${intent}`,
      values: { detectedIntent: intent },
    };
  },
};

// Second evaluator: act on detected intent
const intentActionEvaluator: Evaluator = {
  name: "ACT_ON_INTENT",
  description: "Trigger follow-up based on detected intent",
  alwaysRun: false,

  examples: [],
  validate: async (_runtime, _message, state) => {
    return Boolean((state?.values as Record<string, unknown>)?.detectedIntent);
  },

  handler: async (runtime, _message, state) => {
    const intent = (state?.values as Record<string, unknown>)?.detectedIntent as string;
    // Act on intent...
    return { success: true, text: `Acted on intent: ${intent}` };
  },
};

function classifyIntent(text: string): string {
  if (text.includes("buy") || text.includes("purchase")) return "purchase";
  if (text.includes("help") || text.includes("how")) return "support";
  return "general";
}
```

## Plugin Testing Pattern

Structure tests by unit (isolated action/provider/service tests) and integration (full runtime).

```typescript
// my-plugin.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import myPlugin from "./index";

// --- Mocks ---
const createMockRuntime = (overrides = {}) => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getSetting: vi.fn().mockReturnValue(undefined),
  getEntityById: vi.fn().mockResolvedValue(null),
  ...overrides,
});

const createMockMessage = (text: string, entityId = "user-1") => ({
  entityId,
  content: { text },
  roomId: "room-1",
});

// --- Plugin Structure ---
describe("plugin structure", () => {
  it("has required fields", () => {
    expect(myPlugin.name).toBeDefined();
    expect(myPlugin.description).toBeDefined();
  });

  it("exports valid actions", () => {
    for (const action of myPlugin.actions ?? []) {
      expect(action.name).toBeDefined();
      expect(action.description).toBeDefined();
      expect(action.validate).toBeTypeOf("function");
      expect(action.handler).toBeTypeOf("function");
    }
  });
});

// --- Action Tests ---
describe("SAFE_OPERATION action", () => {
  const runtime = createMockRuntime();
  const message = createMockMessage("do the operation");
  const action = { /* your action */ validate: async () => true, handler: async () => ({ success: true }) };

  it("validates successfully", async () => {
    const valid = await action.validate(runtime as any, message as any, undefined as any);
    expect(valid).toBe(true);
  });
});
```

## Related

- [Plugin Architecture](/plugins/architecture) — How the system works
- [Plugin Schemas](/plugins/schemas) — Schema reference
- [Create a Plugin](/plugins/create-a-plugin) — Tutorial from scratch
