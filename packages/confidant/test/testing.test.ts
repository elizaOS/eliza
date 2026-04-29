import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestConfidant,
  MockBackend,
  MockPromptHandler,
  resetTestRegistry,
  type TestConfidant,
} from "../src/testing.js";
import { PermissionDeniedError } from "../src/policy/grants.js";
import { BackendError } from "../src/backends/types.js";

beforeEach(() => resetTestRegistry());
afterEach(() => resetTestRegistry());

describe("createTestConfidant — plugin-author ergonomics", () => {
  let test: TestConfidant;
  afterEach(async () => {
    if (test) await test.dispose();
  });

  it("pre-loads literal secrets and resolves them via the implicit owner grant", async () => {
    test = await createTestConfidant({
      schemas: {
        "tool.myservice.apiKey": {
          label: "MyService API Key",
          sensitive: true,
          pluginId: "@vendor/plugin-myservice",
        },
      },
      secrets: {
        "tool.myservice.apiKey": "test-api-key-1",
      },
    });
    const scoped = test.scopeFor("@vendor/plugin-myservice");
    expect(await scoped.resolve("tool.myservice.apiKey")).toBe("test-api-key-1");

    const resolves = await test.getResolves();
    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toMatchObject({
      skill: "@vendor/plugin-myservice",
      secret: "tool.myservice.apiKey",
      granted: true,
    });
  });

  it("ciphertext is real on disk — plaintext is not present", async () => {
    test = await createTestConfidant({
      schemas: {
        "tool.myservice.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-myservice",
        },
      },
      secrets: { "tool.myservice.apiKey": "PLAINTEXT_MARKER" },
    });
    const { promises: fs } = await import("node:fs");
    const raw = await fs.readFile(test.storePath, "utf8");
    expect(raw).not.toContain("PLAINTEXT_MARKER");
  });

  it("non-owning skill is denied by default", async () => {
    test = await createTestConfidant({
      schemas: {
        "tool.myservice.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-myservice",
        },
      },
      secrets: { "tool.myservice.apiKey": "secret" },
    });
    const intruder = test.scopeFor("@third-party/intruder");
    await expect(
      intruder.resolve("tool.myservice.apiKey"),
    ).rejects.toThrow(PermissionDeniedError);

    const denials = await test.getDenials();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      skill: "@third-party/intruder",
      secret: "tool.myservice.apiKey",
      granted: false,
    });
  });

  it("explicit grants enable cross-skill access", async () => {
    test = await createTestConfidant({
      schemas: {
        "tool.myservice.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-myservice",
        },
      },
      secrets: { "tool.myservice.apiKey": "secret" },
      grants: {
        "@trusted/companion": ["tool.myservice.apiKey"],
      },
    });
    const companion = test.scopeFor("@trusted/companion");
    expect(await companion.resolve("tool.myservice.apiKey")).toBe("secret");
  });

  it("explicit grants accept full Grant objects (not just patterns)", async () => {
    test = await createTestConfidant({
      schemas: {
        "tool.x.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-x",
        },
      },
      secrets: { "tool.x.apiKey": "v" },
      grants: {
        "@trusted/c": [
          { pattern: "tool.x.*", mode: "always", grantedAt: 1, reason: "test" },
        ],
      },
    });
    expect(
      await test.scopeFor("@trusted/c").resolve("tool.x.apiKey"),
    ).toBe("v");
  });

  it("getAuditRecords / getResolves / getDenials filter correctly", async () => {
    test = await createTestConfidant({
      schemas: {
        "tool.x.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-x",
        },
      },
      secrets: { "tool.x.apiKey": "v" },
    });
    await test.scopeFor("@vendor/plugin-x").resolve("tool.x.apiKey");
    await expect(
      test.scopeFor("@third-party/y").resolve("tool.x.apiKey"),
    ).rejects.toThrow();

    const all = await test.getAuditRecords();
    const resolves = await test.getResolves();
    const denials = await test.getDenials();
    expect(all).toHaveLength(2);
    expect(resolves).toHaveLength(1);
    expect(denials).toHaveLength(1);
  });

  it("clearAuditLog resets the log between assertion phases", async () => {
    test = await createTestConfidant({
      schemas: {
        "tool.x.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-x",
        },
      },
      secrets: { "tool.x.apiKey": "v" },
    });
    await test.scopeFor("@vendor/plugin-x").resolve("tool.x.apiKey");
    expect((await test.getAuditRecords()).length).toBeGreaterThan(0);
    await test.clearAuditLog();
    expect(await test.getAuditRecords()).toEqual([]);
  });

  it("dispose cleans up the temp directory", async () => {
    const t = await createTestConfidant({});
    const path = t.storePath;
    await t.dispose();
    const { promises: fs } = await import("node:fs");
    await expect(fs.access(path)).rejects.toThrow();
  });

  it("workDir override persists artifacts past dispose", async () => {
    const { promises: fs } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const persistent = await fs.mkdtemp(join(tmpdir(), "confidant-persist-"));
    try {
      const t = await createTestConfidant({
        workDir: persistent,
        secrets: {} as Record<string, string>,
      });
      await t.dispose();
      // Directory still exists because we passed workDir explicitly.
      await expect(fs.access(persistent)).resolves.toBeUndefined();
    } finally {
      await fs.rm(persistent, { recursive: true, force: true });
    }
  });
});

describe("MockBackend — reference resolution", () => {
  let test: TestConfidant;
  afterEach(async () => {
    if (test) await test.dispose();
  });

  it("resolves references via a registered MockBackend", async () => {
    const op = new MockBackend("1password", {
      "op://Personal/OpenRouter/api-key": "sk-or-v1-from-1p",
    });
    test = await createTestConfidant({
      schemas: {
        "llm.openrouter.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@elizaos/plugin-openrouter",
        },
      },
      backends: [op],
      references: {
        "llm.openrouter.apiKey": "op://Personal/OpenRouter/api-key",
      },
    });
    const scoped = test.scopeFor("@elizaos/plugin-openrouter");
    expect(await scoped.resolve("llm.openrouter.apiKey")).toBe(
      "sk-or-v1-from-1p",
    );
    expect(op.getResolves()).toHaveLength(1);
    expect(op.getResolves()[0]).toMatchObject({
      method: "resolve",
      ref: "op://Personal/OpenRouter/api-key",
    });
  });

  it("failNext queues a forced failure for the next call", async () => {
    const op = new MockBackend("1password", {
      "op://x/y/z": "value",
    });
    test = await createTestConfidant({
      schemas: {
        "llm.x.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-x",
        },
      },
      backends: [op],
      references: { "llm.x.apiKey": "op://x/y/z" },
    });
    op.failNext(new Error("simulated 1Password lockout"));
    await expect(
      test.scopeFor("@vendor/plugin-x").resolve("llm.x.apiKey"),
    ).rejects.toThrow(/simulated 1Password lockout/);

    // Subsequent call succeeds — failures are one-shot.
    expect(
      await test.scopeFor("@vendor/plugin-x").resolve("llm.x.apiKey"),
    ).toBe("value");
  });

  it("setValue / removeValue mutate the mock's state at runtime", async () => {
    const op = new MockBackend("1password");
    test = await createTestConfidant({
      schemas: {
        "llm.x.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-x",
        },
      },
      backends: [op],
      references: { "llm.x.apiKey": "op://a/b/c" },
    });

    // No value → BackendError
    await expect(
      test.scopeFor("@vendor/plugin-x").resolve("llm.x.apiKey"),
    ).rejects.toThrow(BackendError);

    op.setValue("op://a/b/c", "now-it-works");
    expect(
      await test.scopeFor("@vendor/plugin-x").resolve("llm.x.apiKey"),
    ).toBe("now-it-works");

    op.removeValue("op://a/b/c");
    await expect(
      test.scopeFor("@vendor/plugin-x").resolve("llm.x.apiKey"),
    ).rejects.toThrow(BackendError);
  });

  it("resetCalls clears the call log without mutating values", async () => {
    const op = new MockBackend("1password", { "op://x/y/z": "v" });
    test = await createTestConfidant({
      schemas: {
        "llm.x.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-x",
        },
      },
      backends: [op],
      references: { "llm.x.apiKey": "op://x/y/z" },
    });
    await test.scopeFor("@vendor/plugin-x").resolve("llm.x.apiKey");
    expect(op.getCalls()).toHaveLength(1);
    op.resetCalls();
    expect(op.getCalls()).toEqual([]);
    // Value still resolves — only the call log was cleared.
    expect(
      await test.scopeFor("@vendor/plugin-x").resolve("llm.x.apiKey"),
    ).toBe("v");
  });
});

describe("MockKeyringBackend — OS-keychain reference resolution", () => {
  let test: TestConfidant;
  afterEach(async () => {
    if (test) await test.dispose();
  });

  it("resolves keyring://service/account references", async () => {
    const { MockKeyringBackend } = await import("../src/testing.js");
    const mac = new MockKeyringBackend({
      "elizaos/llm.openrouter.apiKey": "sk-or-v1-from-keychain",
    });
    test = await createTestConfidant({
      schemas: {
        "llm.openrouter.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@elizaos/plugin-openrouter",
        },
      },
      backends: [mac],
      references: {
        "llm.openrouter.apiKey":
          "keyring://elizaos/llm.openrouter.apiKey",
      },
    });
    expect(
      await test
        .scopeFor("@elizaos/plugin-openrouter")
        .resolve("llm.openrouter.apiKey"),
    ).toBe("sk-or-v1-from-keychain");
    expect(mac.getResolves()).toHaveLength(1);
  });

  it("setEntry / removeEntry use the (service, account) shape", async () => {
    const { MockKeyringBackend } = await import("../src/testing.js");
    const mac = new MockKeyringBackend();
    test = await createTestConfidant({
      schemas: {
        "wallet.evm.privateKey": {
          label: "k",
          sensitive: true,
          pluginId: "@elizaos/plugin-evm",
        },
      },
      backends: [mac],
      references: {
        "wallet.evm.privateKey": MockKeyringBackend.reference(
          "elizaos",
          "wallet.evm.privateKey",
        ),
      },
    });

    // Not staged yet — resolves throw.
    await expect(
      test
        .scopeFor("@elizaos/plugin-evm")
        .resolve("wallet.evm.privateKey"),
    ).rejects.toThrow();

    mac.setEntry("elizaos", "wallet.evm.privateKey", "0xDEADBEEF");
    expect(
      await test
        .scopeFor("@elizaos/plugin-evm")
        .resolve("wallet.evm.privateKey"),
    ).toBe("0xDEADBEEF");

    mac.removeEntry("elizaos", "wallet.evm.privateKey");
    await expect(
      test
        .scopeFor("@elizaos/plugin-evm")
        .resolve("wallet.evm.privateKey"),
    ).rejects.toThrow();
  });

  it("MockKeyringBackend.reference produces canonical URIs", async () => {
    const { MockKeyringBackend } = await import("../src/testing.js");
    expect(MockKeyringBackend.reference("elizaos", "x.y.z")).toBe(
      "keyring://elizaos/x.y.z",
    );
    expect(MockKeyringBackend.reference("@app/scope", "field")).toBe(
      "keyring://@app/scope/field",
    );
  });

  it("simulates platform-specific failures via failNext", async () => {
    const { MockKeyringBackend } = await import("../src/testing.js");
    const mac = new MockKeyringBackend({
      "elizaos/llm.x.apiKey": "value",
    });
    test = await createTestConfidant({
      schemas: {
        "llm.x.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-x",
        },
      },
      backends: [mac],
      references: {
        "llm.x.apiKey": "keyring://elizaos/llm.x.apiKey",
      },
    });
    // Simulate a "Linux Secret Service unavailable" error.
    mac.failNext(
      new Error("OS keychain unavailable: no Secret Service agent"),
    );
    await expect(
      test.scopeFor("@vendor/plugin-x").resolve("llm.x.apiKey"),
    ).rejects.toThrow(/no Secret Service/);
  });
});

describe("MockPromptHandler — prompt-mode grants", () => {
  let test: TestConfidant;
  afterEach(async () => {
    if (test) await test.dispose();
  });

  it("approves every request with respondWith: true (default)", async () => {
    const handler = new MockPromptHandler();
    test = await createTestConfidant({
      schemas: {
        "tool.x.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-x",
        },
      },
      secrets: { "tool.x.apiKey": "v" },
      grants: {
        "@third-party/skill": [
          { pattern: "tool.x.*", mode: "prompt", grantedAt: 1 },
        ],
      },
      promptHandler: handler,
    });
    expect(
      await test.scopeFor("@third-party/skill").resolve("tool.x.apiKey"),
    ).toBe("v");
    expect(handler.getCalls()).toHaveLength(1);
    expect(handler.getCalls()[0]).toMatchObject({
      skillId: "@third-party/skill",
      secretId: "tool.x.apiKey",
    });
  });

  it("respondWith: false simulates user denial", async () => {
    const handler = new MockPromptHandler({ respondWith: false });
    test = await createTestConfidant({
      schemas: {
        "tool.x.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-x",
        },
      },
      secrets: { "tool.x.apiKey": "v" },
      grants: {
        "@third-party/skill": [
          { pattern: "tool.x.*", mode: "prompt", grantedAt: 1 },
        ],
      },
      promptHandler: handler,
    });
    await expect(
      test.scopeFor("@third-party/skill").resolve("tool.x.apiKey"),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("respondWith function decides per-call", async () => {
    const handler = new MockPromptHandler({
      respondWith: ({ skillId }) => skillId === "@trusted/skill",
    });
    test = await createTestConfidant({
      schemas: {
        "tool.x.apiKey": {
          label: "k",
          sensitive: true,
          pluginId: "@vendor/plugin-x",
        },
      },
      secrets: { "tool.x.apiKey": "v" },
      grants: {
        "@trusted/skill": [
          { pattern: "tool.x.*", mode: "prompt", grantedAt: 1 },
        ],
        "@untrusted/skill": [
          { pattern: "tool.x.*", mode: "prompt", grantedAt: 1 },
        ],
      },
      promptHandler: handler,
    });
    expect(
      await test.scopeFor("@trusted/skill").resolve("tool.x.apiKey"),
    ).toBe("v");
    await expect(
      test.scopeFor("@untrusted/skill").resolve("tool.x.apiKey"),
    ).rejects.toThrow(PermissionDeniedError);
  });
});
