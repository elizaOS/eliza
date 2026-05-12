---
title: "Create a Plugin"
sidebarTitle: "Create a Plugin"
description: "Step-by-step tutorial for building a Eliza plugin from scratch — scaffolding, actions, providers, testing, and local development."
---

This tutorial walks you through creating a complete plugin from scratch. By the end you will have a working plugin with an action, a provider, and a background service running inside the Eliza runtime.

## Prerequisites

- Node.js 22 or later
- A working Eliza installation (`eliza start` runs without errors)

## Step 1: Scaffold the Project

Create the directory structure:

```
my-plugin/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
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
    "dev": "tsc --watch",
    "test": "vitest run"
  },
  "dependencies": {
    "@elizaos/core": "^2.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^4.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "declaration": true,
    "strict": true
  },
  "include": ["src"]
}
```

## Step 2: Implement an Action

Actions are things the agent can do. The LLM selects actions from the registered list based on description and examples.

```typescript
// src/actions/weather.ts
import type { Action } from "@elizaos/core";

export const checkWeatherAction: Action = {
  name: "CHECK_WEATHER",
  description: "Check the current weather for a city",
  similes: ["GET_WEATHER", "WEATHER_LOOKUP", "FORECAST"],

  validate: async (_runtime, _message, _state) => {
    // Return false if the required API key is missing
    return Boolean(process.env.WEATHER_API_KEY);
  },

  handler: async (_runtime, _message, _state, options, _callback) => {
    const params = options?.parameters as Record<string, unknown> | undefined;
    const city = typeof params?.city === "string" ? params.city : "London";

    try {
      const url = `https://api.example-weather.com/current?city=${encodeURIComponent(city)}&key=${process.env.WEATHER_API_KEY}`;
      const res = await fetch(url);
      const data = await res.json() as { temp: number; condition: string };

      return {
        success: true,
        text: `Weather in ${city}: ${data.temp}°C, ${data.condition}`,
        data: { city, temp: data.temp, condition: data.condition },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to fetch weather: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  parameters: [
    {
      name: "city",
      description: "The city to check weather for",
      required: false,
      schema: { type: "string" },
    },
  ],

  examples: [
    [
      { user: "user", content: { text: "What's the weather in Tokyo?" } },
      { user: "assistant", content: { text: "Weather in Tokyo: 22°C, Partly cloudy", action: "CHECK_WEATHER" } },
    ],
  ],
};
```

## Step 3: Implement a Provider

Providers inject context into the agent's prompt before each LLM inference. Unlike actions, they run automatically.

```typescript
// src/providers/status.ts
import type { Provider } from "@elizaos/core";

export const pluginStatusProvider: Provider = {
  name: "weatherPluginStatus",
  description: "Provides current plugin status and configuration",
  position: 10, // Run after core providers

  get: async (_runtime, _message, _state) => {
    const hasApiKey = Boolean(process.env.WEATHER_API_KEY);

    return {
      text: hasApiKey
        ? "Weather plugin is active. You can check weather for any city."
        : "Weather plugin is configured but missing WEATHER_API_KEY.",
      values: {
        weatherPluginActive: hasApiKey,
      },
    };
  },
};
```

## Step 4: Implement a Service

Services are long-running background processes that start with the runtime.

```typescript
// src/services/weather-cache.ts
import type { IAgentRuntime, Service } from "@elizaos/core";

let cacheInterval: NodeJS.Timeout | undefined;
const weatherCache = new Map<string, { temp: number; condition: string; fetchedAt: number }>();

export const WeatherCacheService = {
  serviceType: "weather_cache",

  start: async (_runtime: IAgentRuntime): Promise<Service> => {
    // Refresh cache every 10 minutes
    cacheInterval = setInterval(() => {
      const now = Date.now();
      for (const [city, entry] of weatherCache) {
        if (now - entry.fetchedAt > 10 * 60 * 1000) {
          weatherCache.delete(city);
        }
      }
    }, 60_000);

    return {
      stop: async () => {
        if (cacheInterval) clearInterval(cacheInterval);
        weatherCache.clear();
      },
    } as Service;
  },
};
```

## Step 5: Assemble the Plugin

```typescript
// src/index.ts
import type { Plugin } from "@elizaos/core";
import { checkWeatherAction } from "./actions/weather";
import { pluginStatusProvider } from "./providers/status";
import { WeatherCacheService } from "./services/weather-cache";

const weatherPlugin: Plugin = {
  name: "weather-plugin",
  description: "Provides real-time weather information for any city",
  priority: 10,

  init: async (_config, runtime) => {
    runtime.logger?.info("[weather-plugin] Initialized");
    if (!process.env.WEATHER_API_KEY) {
      runtime.logger?.warn("[weather-plugin] WEATHER_API_KEY not set — CHECK_WEATHER action will be disabled");
    }
  },

  actions: [checkWeatherAction],
  providers: [pluginStatusProvider],
  services: [WeatherCacheService],
};

export default weatherPlugin;
```

This is a minimal plugin. The `Plugin` interface also supports `evaluators`, `routes`, `events`, `models`, `componentTypes`, and `tests`. See [Plugin Schemas](/plugins/schemas) for all available extension points.

## Step 6: Write Tests

```typescript
// src/index.test.ts
import { describe, it, expect } from "vitest";
import {
  AgentRuntime,
  createCharacter,
  createMessageMemory,
  InMemoryDatabaseAdapter,
  stringToUuid,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import weatherPlugin from "./index";

function createRuntime(): IAgentRuntime {
  return new AgentRuntime({
    agentId: stringToUuid("weather-test-agent"),
    character: createCharacter({ name: "Weather Test" }),
    adapter: new InMemoryDatabaseAdapter(),
    plugins: [],
    logLevel: "error",
  });
}

const mockMessage: Memory = createMessageMemory({
  entityId: stringToUuid("weather-test-user"),
  roomId: stringToUuid("weather-test-room"),
  content: { text: "What is the weather in Paris?" },
});

describe("weather-plugin", () => {
  it("exports a valid plugin", () => {
    expect(weatherPlugin.name).toBe("weather-plugin");
    expect(weatherPlugin.actions).toHaveLength(1);
    expect(weatherPlugin.providers).toHaveLength(1);
  });

  it("CHECK_WEATHER action fails validation without API key", async () => {
    delete process.env.WEATHER_API_KEY;
    const action = weatherPlugin.actions![0];
    const valid = await action.validate(createRuntime(), mockMessage);
    expect(valid).toBe(false);
  });

  it("CHECK_WEATHER action passes validation with API key", async () => {
    process.env.WEATHER_API_KEY = "test-key";
    const action = weatherPlugin.actions![0];
    const valid = await action.validate(createRuntime(), mockMessage);
    expect(valid).toBe(true);
    delete process.env.WEATHER_API_KEY;
  });
});
```

## Step 7: Register with Runtime

| Option | Best for | How it works |
|--------|----------|--------------|
| **A: Local Plugin** | Active development and testing | Auto-discovered from the project's `plugins/` directory |
| **B: Config-Based** | Persistent installations with explicit control | Referenced by path in `eliza.json` |
| **C: Character File** | Per-agent plugin sets | Listed in the character definition, loaded at agent start |

### Option A: Local Plugin (Development)

Place the plugin directory inside the project:

```
eliza-project/
└── plugins/
    └── weather-plugin/
        ├── package.json
        └── src/index.ts
```

Eliza automatically discovers plugins in the `plugins/` directory.

### Option B: Config-Based Loading

Add to `eliza.json`:

```json
{
  "plugins": {
    "allow": ["weather-plugin"],
    "entries": {
      "weather-plugin": {
        "path": "./plugins/weather-plugin"
      }
    }
  }
}
```

### Option C: Character File

```json
{
  "name": "MyAgent",
  "plugins": ["./plugins/weather-plugin"],
  "settings": {
    "secrets": {
      "WEATHER_API_KEY": "your-key-here"
    }
  }
}
```

## Step 8: Build and Test

```bash
# Build the plugin
cd my-plugin && bun run build

# Run tests
bun test

# Start Eliza with the plugin loaded
eliza start
```

Check the logs for `[weather-plugin] Initialized` to confirm the plugin loaded.

## Plugin Manifest (`elizaos.plugin.json`)

Every published plugin should include an `elizaos.plugin.json` manifest at its package root. This file tells the runtime and admin UI how to configure and display your plugin.

```json
{
  "id": "plugin-weather",
  "name": "Weather Plugin",
  "version": "1.0.0",
  "kind": "feature",
  "description": "Provides real-time weather data to your agent",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "string",
        "description": "OpenWeatherMap API key"
      },
      "units": {
        "type": "string",
        "enum": ["metric", "imperial"],
        "default": "metric"
      }
    },
    "required": ["apiKey"]
  },
  "uiHints": {
    "apiKey": {
      "label": "API Key",
      "type": "password",
      "help": "Get one at openweathermap.org/appid"
    },
    "units": {
      "label": "Temperature Units",
      "type": "select",
      "advanced": false
    }
  },
  "requiredSecrets": ["WEATHER_API_KEY"],
  "channels": ["chat", "telegram", "discord"],
  "dependencies": ["knowledge"]
}
```

### Manifest Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique plugin identifier (kebab-case) |
| `name` | `string` | Human-readable display name |
| `version` | `string` | Semver version |
| `kind` | `PluginKind` | One of: `feature`, `ai-provider`, `connector`, `database`, `app`, `memory`, `channel`, `provider`, `skill` |
| `configSchema` | `JsonSchema` | JSON Schema for plugin configuration |
| `uiHints` | `Record<string, PluginConfigUiHint>` | Hints for admin panel rendering, keyed by config property name |
| `requiredSecrets` | `string[]` | Environment variables that must be set |
| `channels` | `string[]` | Supported communication channels |
| `dependencies` | `string[]` | Other plugins this depends on |

Additional fields like `optionalSecrets`, `providers`, `skills`, `gatewayMethods`, and `cliCommands` are also supported. See [Plugin Schemas](/plugins/schemas) for the complete manifest reference.

### UI Hints

The `uiHints` object controls how config fields appear in the admin dashboard. Each key matches a property name in `configSchema`:

```typescript
interface PluginConfigUiHint {
  label: string;      // display label
  type: 'text' | 'password' | 'number' | 'select' | 'toggle' | 'textarea';
  help?: string;      // tooltip or helper text
  sensitive?: boolean; // if true, value is masked in the UI
  advanced?: boolean; // if true, hidden under "Advanced" toggle
}
```

---

## How Plugin Discovery Works

When Eliza starts, it discovers plugins from multiple sources in this order:

1. **Eliza plugin** — Built-in workspace context and session management
2. **Core plugins** — Always loaded (`@elizaos/plugin-sql`, `@elizaos/plugin-local-embedding`, etc.)
3. **Connector plugins** — Auto-enabled when channel config exists (e.g., `telegram` config → `@elizaos/plugin-telegram`)
4. **Provider plugins** — Auto-enabled when API key env var is set (e.g., `ANTHROPIC_API_KEY` → `@elizaos/plugin-anthropic`)
5. **Feature plugins** — Enabled via feature flags in `eliza.json` (e.g., `features.browser: true` → `@elizaos/plugin-browser`)
6. **Ejected plugins** — Git-cloned upstream plugins in `~/.eliza/plugins/ejected/` (take priority over npm versions)
7. **User-installed plugins** — Installed via `eliza plugins install`
8. **Custom plugins** — Dropped into `~/.eliza/plugins/custom/`

### Auto-Enable by Environment Variable

Set an API key and the corresponding plugin loads automatically:

| Environment Variable | Plugin |
|---------------------|--------|
| `ANTHROPIC_API_KEY` | `@elizaos/plugin-anthropic` |
| `OPENAI_API_KEY` | `@elizaos/plugin-openai` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `@elizaos/plugin-google-genai` |
| `GROQ_API_KEY` | `@elizaos/plugin-groq` |
| `OPENROUTER_API_KEY` | `@elizaos/plugin-openrouter` |

### Auto-Enable by Connector Config

Configure a channel in `eliza.json` and the connector plugin loads:

```json
{
  "connectors": {
    "telegram": { "botToken": "..." },
    "discord": { "token": "..." }
  }
}
```

This auto-loads `@elizaos/plugin-telegram` and `@elizaos/plugin-discord`.

### Disabling Auto-Enabled Plugins

Override in `eliza.json`:

```json
{
  "plugins": {
    "entries": {
      "telegram": { "enabled": false }
    }
  }
}
```

---

## Starter Template

If you have the upstream `elizaos` CLI installed globally, you can scaffold a plugin project:

```bash
# Requires the elizaos CLI (npm i -g elizaos)
npx elizaos create my-plugin --template plugin --language typescript
```

Alternatively, copy the manual scaffold from [Step 1](#step-1-scaffold-the-project) above — it produces the same structure.

The template includes:
- Pre-configured `package.json` with `@elizaos/core` peer dependency
- TypeScript config targeting ES2022
- Example action, provider, and service
- Vitest test setup with runtime mocks
- `elizaos.plugin.json` manifest

---

## Next Steps

- [Testing Guide](/plugins/testing) — Unit, integration, and E2E testing patterns
- [Decision Guide](/plugins/decision-guide) — Choosing between Actions, Providers, Services, and Skills
- [Plugin Patterns](/plugins/patterns) — Common patterns for services, state, and error handling
- [Plugin Schemas](/plugins/schemas) — Full schema reference for all plugin types
- [Publish a Plugin](/plugins/publish) — Publish to the npm registry
