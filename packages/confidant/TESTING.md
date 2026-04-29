# Testing with @elizaos/confidant

Confidant ships a framework-agnostic testing harness at the subpath
`@elizaos/confidant/testing`. Plugin authors and host-app authors test
against a real Confidant — real encryption, real audit log, real
policy engine — without needing the OS keychain, password-manager
CLIs, or `process.env`.

The harness has no test-runner dependencies; it works with vitest,
jest, mocha, bun:test, or anything else.

## Quick start

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestConfidant,
  resetTestRegistry,
  type TestConfidant,
} from "@elizaos/confidant/testing";

describe("MyPlugin", () => {
  let test: TestConfidant;

  afterEach(async () => {
    await test?.dispose();
    resetTestRegistry();
  });

  it("calls the API with the configured key", async () => {
    test = await createTestConfidant({
      schemas: {
        "tool.myservice.apiKey": {
          label: "MyService API Key",
          sensitive: true,
          pluginId: "@vendor/plugin-myservice",
        },
      },
      secrets: {
        "tool.myservice.apiKey": "test-api-key",
      },
    });

    const scoped = test.scopeFor("@vendor/plugin-myservice");
    const apiKey = await scoped.resolve("tool.myservice.apiKey");
    expect(apiKey).toBe("test-api-key");

    // Inspect the audit log
    expect(await test.getResolves()).toHaveLength(1);
    expect(await test.getDenials()).toHaveLength(0);
  });
});
```

That's the whole pattern. The harness:

- Creates a temp `confidant.json` (encrypted at rest, just like prod)
- Creates a temp audit log
- Pre-loads literal secrets (or references — see below)
- Registers schemas so the implicit-grant rule fires
- Cleans up on `dispose()`

## Options

```ts
createTestConfidant({
  // Pre-loaded literal values:
  secrets: { "tool.x.apiKey": "test-key" },

  // Pre-loaded references — pair with a MockBackend:
  references: { "llm.openrouter.apiKey": "op://Personal/OR/api-key" },

  // Schema registrations (drive implicit grants):
  schemas: {
    "tool.x.apiKey": {
      label: "X API Key",
      sensitive: true,
      pluginId: "@vendor/plugin-x",
    },
  },

  // Explicit cross-skill grants — for testing non-owning resolves:
  grants: {
    "@trusted/companion": ["tool.x.*"],
    "@security-test/audit": [
      { pattern: "*", mode: "audit", grantedAt: 0, reason: "test" },
    ],
  },

  // Custom backends (typically MockBackend instances):
  backends: [op, vault],

  // Custom prompt handler (default: MockPromptHandler approves all):
  promptHandler: new MockPromptHandler({ respondWith: false }),

  // Optional persistent workDir (default: mkdtemp + auto-cleanup):
  workDir: "/path/to/persistent/dir",
});
```

## Mocking external backends

`MockBackend` is a fully-functional in-memory `VaultBackend` that
records every call. Use it to test reference resolution without
hitting a real password manager:

```ts
import { MockBackend, createTestConfidant } from "@elizaos/confidant/testing";

const op = new MockBackend("1password", {
  "op://Personal/OpenRouter/api-key": "sk-or-v1-from-1p",
});

const test = await createTestConfidant({
  schemas: { "llm.openrouter.apiKey": { ... } },
  backends: [op],
  references: {
    "llm.openrouter.apiKey": "op://Personal/OpenRouter/api-key",
  },
});

await test.scopeFor("@elizaos/plugin-openrouter").resolve("llm.openrouter.apiKey");

// Inspect what the backend saw
expect(op.getResolves()).toEqual([
  { method: "resolve", ref: "op://Personal/OpenRouter/api-key" },
]);
```

### Failure injection

```ts
op.failNext(new Error("simulated 1Password lockout"));
await expect(scoped.resolve("llm.openrouter.apiKey")).rejects.toThrow(
  /simulated 1Password lockout/,
);
// Subsequent calls succeed — failures are one-shot.
```

`failNext` queues errors. Each subsequent call (in order: resolve /
store / remove) consumes one queued error, then normal behavior
resumes. Multiple failures can be queued.

### Runtime mutation

```ts
op.setValue("op://path/to/secret", "new-value");
op.removeValue("op://path/to/secret"); // next resolve throws BackendError
op.resetCalls(); // clear the call log without touching values
```

## Mocking the prompt handler

For prompt-mode grants (default policy when a non-owning skill resolves
a credential through an explicit `prompt`-mode grant), the harness
provides `MockPromptHandler`:

```ts
import { MockPromptHandler } from "@elizaos/confidant/testing";

// Auto-approve all (default):
const allow = new MockPromptHandler();

// Auto-deny:
const deny = new MockPromptHandler({ respondWith: false });

// Decide per-call:
const selective = new MockPromptHandler({
  respondWith: ({ skillId, secretId }) =>
    skillId.startsWith("@trusted/") && secretId.startsWith("tool."),
});

// Inspect what was prompted:
expect(allow.getCalls()).toHaveLength(1);
expect(allow.getCalls()[0]).toMatchObject({
  skillId: "@third-party/skill",
  secretId: "tool.x.apiKey",
});
```

## Asserting on the audit log

Every Confidant resolve writes to the audit log. The harness exposes
filters:

```ts
const all = await test.getAuditRecords();      // every entry
const ok  = await test.getResolves();          // granted: true
const no  = await test.getDenials();           // granted: false

// Reset between assertion phases of a long-running test:
await test.clearAuditLog();
```

Audit records have the shape:

```ts
{
  ts: number,
  skill: string,        // skill id that asked
  secret: SecretId,     // which credential
  granted: boolean,
  source?: VaultSource, // where the value came from (file, keyring, ...)
  cached?: boolean,
  reason?: string,      // present on denials
}
```

Crucially, **the value never appears in the log**. You can assert this
directly:

```ts
const { promises: fs } = await import("node:fs");
const log = await fs.readFile(test.auditLogPath, "utf8");
expect(log).not.toContain("PLAINTEXT_MARKER");
```

## Schema isolation between tests

The schema registry is process-global. If your test file has multiple
`describe` blocks that register different schemas, reset between
cases:

```ts
import { resetTestRegistry } from "@elizaos/confidant/testing";

afterEach(() => resetTestRegistry());
```

(`resetTestRegistry` is the public name for the test-only
`__resetSecretSchemaForTests` reset; same function.)

## Common patterns

### Plugin-author test (the typical case)

```ts
import { createTestConfidant, resetTestRegistry } from "@elizaos/confidant/testing";
import { defineSchemaFromRegistry } from "@elizaos/confidant";
import registryEntry from "../registry.json";
import { myPlugin } from "../src/index.js";

beforeEach(async () => {
  resetTestRegistry();
  defineSchemaFromRegistry(registryEntry, {
    domain: "tool",
    subject: "myservice",
  });
});

it("does the thing", async () => {
  const test = await createTestConfidant({
    secrets: { "tool.myservice.apiKey": "test-key" },
  });

  const fakeRuntime = {
    confidant: test.confidant,
    // ...other runtime mocks
  };
  await myPlugin.init(fakeRuntime);

  expect(await test.getResolves()).toHaveLength(1);
  await test.dispose();
});
```

### Cross-plugin denial test

Verify your plugin can't read another plugin's credentials:

```ts
it("does not read other plugins' credentials", async () => {
  const test = await createTestConfidant({
    schemas: {
      "llm.openai.apiKey": {
        label: "k",
        sensitive: true,
        pluginId: "@elizaos/plugin-openai",
      },
    },
    secrets: { "llm.openai.apiKey": "competitor-secret" },
  });
  await expect(
    test.scopeFor("@vendor/my-plugin").resolve("llm.openai.apiKey"),
  ).rejects.toThrow();
  await test.dispose();
});
```

### Testing the migration bridge

```ts
import { mirrorLegacyEnvCredentials } from "@elizaos/confidant";

it("hydrates from process.env without copying values", async () => {
  const test = await createTestConfidant({
    schemas: { "llm.openrouter.apiKey": { ... } },
    backends: [new EnvLegacyBackend({ OPENROUTER_API_KEY: "sk-or-test" })],
  });
  await mirrorLegacyEnvCredentials(test.confidant, [
    { providerId: "openrouter", envVar: "OPENROUTER_API_KEY" },
  ]);
  expect(
    await test.scopeFor("@elizaos/plugin-openrouter").resolve("llm.openrouter.apiKey"),
  ).toBe("sk-or-test");
  await test.dispose();
});
```

### Testing a host-app's bootstrap

```ts
import { registerElizaSecretSchemas, mirrorLegacyEnvCredentials } from "@elizaos/confidant";

it("host bootstrap wires the full catalog", async () => {
  registerElizaSecretSchemas();
  const test = await createTestConfidant({
    backends: [new EnvLegacyBackend({
      OPENROUTER_API_KEY: "sk-1",
      EVM_PRIVATE_KEY: "0xABC",
      ELEVENLABS_API_KEY: "el-1",
    })],
  });
  await mirrorLegacyEnvCredentials(test.confidant, [
    { providerId: "openrouter", envVar: "OPENROUTER_API_KEY" },
    { providerId: "evm", envVar: "EVM_PRIVATE_KEY" },
    { providerId: "elevenlabs", envVar: "ELEVENLABS_API_KEY" },
  ]);
  // Each plugin can now read its credential through the runtime's
  // scoped Confidant.
  await test.dispose();
});
```

## What you don't need to mock

- **The Confidant interface itself** — use `createTestConfidant`. It's
  the real thing.
- **Encryption** — runs for real. Tests prove production behavior.
- **The audit log** — written for real. Inspect it directly.
- **Permission policy** — runs for real. Use `grants` and `schemas` to
  set up the access pattern, then test the boundaries.
- **OS keychain** — the harness uses `inMemoryMasterKey` so no
  keychain access happens. The encryption is still real.

## What you do need to mock

- **Password-manager backends** (`1password`, `protonpass`,
  `cloud`) — use `MockBackend`.
- **Prompt UI** — use `MockPromptHandler`.
- **`process.env` for legacy bridge tests** — pass an `EnvLegacyBackend`
  with a fake `env` argument: `new EnvLegacyBackend({ OPENROUTER_API_KEY: "test" })`.
