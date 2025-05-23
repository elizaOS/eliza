---
sidebar_position: 12
title: Testing Providers, Actions & Evaluators
description: Learn how to write component and end-to-end tests for ElizaOS primitives
keywords: [testing, providers, actions, evaluators, vitest, e2e]
image: /img/cli.jpg
---

# 🧪 Testing Core Primitives

ElizaOS encourages thorough testing of providers, actions and evaluators. Component tests use **Vitest**, while scenario tests run through the ElizaOS runtime.

## Component Tests

For unit style tests, import helpers from the bootstrap plugin test utilities
and call the primitive directly.

```ts
import { describe, it, expect } from 'vitest';
import { timeProvider } from '@elizaos/plugin-bootstrap';
import {
  createMockRuntime,
  createMockMemory,
} from '@elizaos/plugin-bootstrap/__tests__/test-utils';

describe('time provider', () => {
  it('returns a time string', async () => {
    const runtime = createMockRuntime();
    const msg = createMockMemory();
    const result = await timeProvider.get(runtime as any, msg as any);
    expect(result.values.time).toBeDefined();
  });
});
```

## End-to-End Tests

Scenario tests use a `TestSuite` loaded by the CLI `test` command. Each test
receives a running `IAgentRuntime` instance.

```ts
import type { TestSuite } from '@elizaos/core';
import { bootstrapPlugin } from '@elizaos/plugin-bootstrap';

export class BootstrapSuite implements TestSuite {
  name = 'bootstrap_example';
  tests = [
    {
      name: 'reply action works',
      fn: async (runtime) => {
        const action = runtime.actions.find((a) => a.name === 'REPLY');
        if (!action) throw new Error('action missing');
        await action.handler(
          runtime,
          { content: { text: 'hi' } } as any,
          { values: {} } as any,
          {},
          () => {}
        );
      },
    },
  ];
}
export default new BootstrapSuite();
```

Run all tests with:

```bash
elizaos test
```

Component and e2e tests can be filtered using `--name` and built beforehand with
`bun run build`.
