---
title: "Testing Plugins"
sidebarTitle: "Testing"
description: "Unit, integration, and E2E testing patterns for elizaOS plugins using Vitest."
---

This guide covers testing patterns for elizaOS plugins — from unit testing individual actions and providers to integration testing with the runtime, and embedding test suites in your plugin.

## Setup

Plugins use [Vitest](https://vitest.dev/) as the test runner. Add it to your plugin's dev dependencies:

```json
{
  "devDependencies": {
    "vitest": "^4.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest watch",
    "test:coverage": "vitest run --coverage"
  }
}
```

---

## Mock Runtime Factory

Most plugin tests need a mock `IAgentRuntime`. Create a shared helper:

```typescript
// tests/helpers.ts
import { vi } from 'vitest';
import {
  AgentRuntime,
  createCharacter,
  createMessageMemory,
  InMemoryDatabaseAdapter,
  stringToUuid,
  type IAgentRuntime,
  type Memory,
  type State,
} from '@elizaos/core';

export function createMockRuntime(
  overrides?: Partial<IAgentRuntime>
): IAgentRuntime {
  const runtime = new AgentRuntime({
    agentId: stringToUuid('test-agent'),
    character: createCharacter({ name: 'Test Agent' }),
    adapter: new InMemoryDatabaseAdapter(),
    plugins: [],
    logLevel: 'error',
  });

  runtime.getSetting = vi.fn((key: string) => process.env[key]);
  runtime.getService = vi.fn();
  runtime.composeState = vi
    .fn()
    .mockResolvedValue({ values: {}, data: {}, text: '' } satisfies State);

  Object.assign(runtime, overrides);
  return runtime;
}

export function createMockMessage(
  text: string,
  overrides?: Partial<Memory>
): Memory {
  return {
    ...createMessageMemory({
      id: stringToUuid('test-message'),
      entityId: stringToUuid('test-user'),
      roomId: stringToUuid('test-room'),
      content: { text },
    }),
    ...overrides,
  };
}
```

---

## Unit Testing Actions

Test the `validate` and `handler` methods independently:

```typescript
// tests/actions/weather.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkWeatherAction } from '../../src/actions/weather';
import { createMockRuntime, createMockMessage } from '../helpers';

describe('checkWeatherAction', () => {
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    runtime = createMockRuntime({
      getSetting: vi.fn((key) => {
        if (key === 'WEATHER_API_KEY') return 'test-key-123';
        return undefined;
      }),
    });
  });

  describe('validate', () => {
    it('returns true when API key is configured', async () => {
      const message = createMockMessage('What is the weather?');
      const result = await checkWeatherAction.validate(runtime, message);
      expect(result).toBe(true);
    });

    it('returns false when API key is missing', async () => {
      const noKeyRuntime = createMockRuntime();
      const message = createMockMessage('What is the weather?');
      const result = await checkWeatherAction.validate(noKeyRuntime, message);
      expect(result).toBe(false);
    });
  });

  describe('handler', () => {
    it('returns weather data on success', async () => {
      // Mock the fetch call
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ temp: 22, condition: 'Sunny' }),
      });

      const message = createMockMessage('Weather in Tokyo');
      const state: State = { values: {}, data: {}, text: '' };
      const result = await checkWeatherAction.handler(
        runtime,
        message,
        state,
        { parameters: { city: 'Tokyo' } }
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain('Tokyo');
    });

    it('returns error on API failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const message = createMockMessage('Weather in Tokyo');
      const state: State = { values: {}, data: {}, text: '' };
      const result = await checkWeatherAction.handler(
        runtime,
        message,
        state,
        { parameters: { city: 'Tokyo' } }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
```

---

## Unit Testing Providers

Providers return context strings. Test that the output is well-formatted and contains expected data:

```typescript
// tests/providers/status.test.ts
import { describe, it, expect } from 'vitest';
import { pluginStatusProvider } from '../../src/providers/status';
import { createMockRuntime, createMockMessage } from '../helpers';

describe('pluginStatusProvider', () => {
  it('returns active status when API key is set', async () => {
    process.env.WEATHER_API_KEY = 'test-key';
    const runtime = createMockRuntime();
    const message = createMockMessage('hello');

    const state: State = { values: {}, data: {}, text: '' };
    const result = await pluginStatusProvider.get(runtime, message, state);

    expect(result).toBeDefined();
    expect(typeof result.text).toBe('string');
    expect(result.text).toContain('active');

    delete process.env.WEATHER_API_KEY;
  });

  it('returns inactive status when API key is missing', async () => {
    delete process.env.WEATHER_API_KEY;
    const runtime = createMockRuntime();
    const message = createMockMessage('hello');

    const state: State = { values: {}, data: {}, text: '' };
    const result = await pluginStatusProvider.get(runtime, message, state);

    expect(result.text).toContain('missing');
  });
});
```

---

## Unit Testing Services

Test that services start and stop cleanly without leaking resources:

```typescript
// tests/services/weather-cache.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WeatherCacheService } from '../../src/services/weather-cache';
import { createMockRuntime } from '../helpers';

describe('WeatherCacheService', () => {
  let service: { stop: () => Promise<void> } | undefined;

  it('starts without errors', async () => {
    const runtime = createMockRuntime();
    service = await WeatherCacheService.start(runtime);
    expect(service).toBeDefined();
    expect(service.stop).toBeTypeOf('function');
  });

  it('stops cleanly', async () => {
    const runtime = createMockRuntime();
    service = await WeatherCacheService.start(runtime);
    await expect(service.stop()).resolves.toBeUndefined();
    service = undefined;
  });

  afterEach(async () => {
    if (service) await service.stop();
  });
});
```

---

## Integration Testing

For tests that need the full runtime (database, memory, state composition), bootstrap a test runtime:

```typescript
// tests/integration/plugin.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IAgentRuntime } from '@elizaos/core';
import weatherPlugin from '../../src/index';

describe('weather plugin integration', () => {
  let runtime: IAgentRuntime;

  beforeAll(async () => {
    // If your test setup bootstraps a real runtime:
    // runtime = await createTestRuntime({ plugins: [weatherPlugin] });

    // Or use a mock with real state composition:
    const runtimeMock = {
      agentId: 'test-agent',
      getSetting: (key: string) => process.env[key],
      logger: console,
      // Add other methods your plugin needs
    } satisfies Partial<IAgentRuntime>;
    runtime = runtimeMock as IAgentRuntime;

    // Initialize the plugin
    if (weatherPlugin.init) {
      await weatherPlugin.init({}, runtime);
    }
  });

  it('registers all actions', () => {
    expect(weatherPlugin.actions).toHaveLength(1);
    expect(weatherPlugin.actions![0].name).toBe('CHECK_WEATHER');
  });

  it('registers all providers', () => {
    expect(weatherPlugin.providers).toHaveLength(1);
    expect(weatherPlugin.providers![0].name).toBe('weatherPluginStatus');
  });

  it('plugin init logs correctly', () => {
    // Verify init was called without errors
    expect(weatherPlugin.name).toBe('weather-plugin');
  });
});
```

---

## Mocking Patterns

### Mocking LLM Responses

When testing actions that call the LLM via `runtime.useModel`:

```typescript
const runtime = createMockRuntime({
  useModel: vi.fn().mockResolvedValue({
    text: 'The weather in Tokyo is 22°C and sunny.',
  }),
});
```

### Mocking Database Calls

```typescript
const runtime = createMockRuntime({
  getMemoryManager: vi.fn().mockReturnValue({
    searchMemories: vi.fn().mockResolvedValue([]),
    createMemory: vi.fn().mockResolvedValue(undefined),
  }),
});
```

### Mocking External APIs

Use `vi.fn()` on `globalThis.fetch` or inject a mock HTTP client:

```typescript
globalThis.fetch = vi.fn()
  .mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ data: 'first call' }),
  })
  .mockResolvedValueOnce({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
  });
```

---

## TestSuite: Embedded Plugin Tests

Plugins can embed tests via the `tests` field. These run when users execute `eliza plugins test <name>`:

```typescript
import type { Plugin, TestSuite, Memory, State } from '@elizaos/core';
import { checkWeatherAction } from './actions/weather';
import { pluginStatusProvider } from './providers/status';

const weatherTests: TestSuite = {
  name: 'weather-plugin-tests',
  tests: [
    {
      name: 'action validates with API key',
      fn: async (runtime) => {
        const msg = { content: { text: 'weather' } } as Memory;
        const valid = await checkWeatherAction.validate(runtime, msg);
        if (!valid) throw new Error('Expected validation to pass');
      },
    },
    {
      name: 'provider returns context',
      fn: async (runtime) => {
        const msg = { content: { text: 'status' } } as Memory;
        const state: State = { values: {}, data: {}, text: '' };
        const result = await pluginStatusProvider.get(runtime, msg, state);
        if (!result.text) throw new Error('Expected non-empty text');
      },
    },
  ],
};

const weatherPlugin: Plugin = {
  name: 'weather-plugin',
  description: 'Weather information plugin',
  actions: [checkWeatherAction],
  providers: [pluginStatusProvider],
  tests: [weatherTests],
};

export default weatherPlugin;
```

---

## Running Tests

```bash
# Run all tests
vitest run

# Run with coverage report
vitest run --coverage

# Run a specific test file
vitest run tests/actions/weather.test.ts

# Watch mode (re-runs on file changes)
vitest watch
```

### Coverage Thresholds

The monorepo enforces minimum coverage in `vitest.config.ts`:

| Metric | Minimum |
|--------|---------|
| Lines | 25% |
| Functions | 25% |
| Statements | 25% |
| Branches | 15% |

For standalone published plugins, aim for **80% coverage** — this is the recommended bar for quality.

---

## E2E Testing

For end-to-end testing with a running agent, the starter template includes a Cypress scaffold:

```
my-plugin/
├── cypress/
│   ├── e2e/
│   │   └── plugin.cy.ts
│   └── support/
│       └── commands.ts
└── cypress.config.ts
```

E2E tests start the agent, load the plugin, and verify behavior through the chat or API:

```typescript
// cypress/e2e/plugin.cy.ts
describe('Weather Plugin E2E', () => {
  it('responds to weather queries', () => {
    cy.request('POST', 'http://localhost:18789/api/conversations', {
      title: 'Weather Plugin Test',
    }).then(({ body }) => {
      const conversationId = body.conversation.id;
      cy.request(
        'POST',
        `http://localhost:18789/api/conversations/${conversationId}/messages`,
        { text: 'What is the weather in London?' },
      ).then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body.text).to.include('London');
      });
    });
  });
});
```

---

## Related

- [Create a Plugin](/plugins/create-a-plugin) — Build a plugin from scratch
- [Plugin Patterns](/plugins/patterns) — Common implementation patterns
- [Plugin Schemas](/plugins/schemas) — Full type reference
- [Contributing Guide](/guides/contributing) — Test conventions for the monorepo
