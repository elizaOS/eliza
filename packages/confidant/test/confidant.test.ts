import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetSecretSchemaForTests,
  defineSecretSchema,
} from "../src/secret-schema.js";
import { generateMasterKey } from "../src/crypto/envelope.js";
import { inMemoryMasterKey } from "../src/crypto/master-key.js";
import { createConfidant } from "../src/confidant.js";
import { EnvLegacyBackend } from "../src/backends/env-legacy.js";
import { PermissionDeniedError } from "../src/policy/grants.js";
import {
  emptyStore,
  setPermissions,
  writeStore,
} from "../src/store.js";

describe("Confidant", () => {
  let dir: string;
  let storePath: string;
  let auditPath: string;

  beforeEach(async () => {
    __resetSecretSchemaForTests();
    dir = await fs.mkdtemp(join(tmpdir(), "confidant-"));
    storePath = join(dir, "confidant.json");
    auditPath = join(dir, "audit", "confidant.jsonl");
  });

  afterEach(async () => {
    __resetSecretSchemaForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeConfidant(env?: NodeJS.ProcessEnv) {
    return createConfidant({
      storePath,
      auditLogPath: auditPath,
      masterKey: inMemoryMasterKey(generateMasterKey()),
      backends: [new EnvLegacyBackend(env)],
    });
  }

  it("sets a literal and resolves it back", async () => {
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "sk-or-v1-real");
    expect(await c.resolve("llm.openrouter.apiKey")).toBe("sk-or-v1-real");
  });

  it("ciphertext on disk is not the plaintext", async () => {
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "sk-or-v1-real");
    const raw = await fs.readFile(storePath, "utf8");
    expect(raw).not.toContain("sk-or-v1-real");
  });

  it("setReference + env-legacy resolution", async () => {
    const env = { OPENROUTER_API_KEY: "from-env-var" } as NodeJS.ProcessEnv;
    const c = makeConfidant(env);
    await c.setReference("llm.openrouter.apiKey", "env://OPENROUTER_API_KEY");
    expect(await c.resolve("llm.openrouter.apiKey")).toBe("from-env-var");
  });

  it("has() reports stored ids without revealing the value", async () => {
    const c = makeConfidant();
    expect(await c.has("llm.openrouter.apiKey")).toBe(false);
    await c.set("llm.openrouter.apiKey", "v");
    expect(await c.has("llm.openrouter.apiKey")).toBe(true);
  });

  it("list() returns ids, optionally filtered by prefix", async () => {
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "a");
    await c.set("llm.openai.apiKey", "b");
    await c.set("connector.telegram.botToken", "c");
    expect((await c.list()).slice().sort()).toEqual([
      "connector.telegram.botToken",
      "llm.openai.apiKey",
      "llm.openrouter.apiKey",
    ]);
    expect((await c.list("llm")).slice().sort()).toEqual([
      "llm.openai.apiKey",
      "llm.openrouter.apiKey",
    ]);
  });

  it("describe() returns metadata without the value", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "sk-or-v1-real");
    const desc = await c.describe("llm.openrouter.apiKey");
    expect(desc).toMatchObject({
      id: "llm.openrouter.apiKey",
      source: "file",
      isReference: false,
    });
    expect(desc?.schema?.label).toBe("OpenRouter API Key");
    // value never appears in descriptor
    expect(JSON.stringify(desc)).not.toContain("sk-or-v1-real");
  });

  it("remove() deletes the entry", async () => {
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "v");
    await c.remove("llm.openrouter.apiKey");
    expect(await c.has("llm.openrouter.apiKey")).toBe(false);
  });

  it("setReference rejects file:// (use set() for literals)", async () => {
    const c = makeConfidant();
    await expect(
      c.setReference("llm.openrouter.apiKey", "file://"),
    ).rejects.toThrow(/setReference does not accept file:/);
  });

  it("rejects invalid secret ids on every entry point", async () => {
    const c = makeConfidant();
    await expect(c.set("BAD_ID" as unknown as string, "v")).rejects.toThrow();
    await expect(c.has("not.an.id" as never)).resolves.toBe(false); // valid pattern but no entry
    await expect(c.resolve("BAD" as unknown as string)).rejects.toThrow();
  });

  it("scoped resolve denies by default for non-owning skills", async () => {
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "v");
    const scoped = c.scopeFor("weather-bot");
    await expect(scoped.resolve("llm.openrouter.apiKey")).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it("scoped resolve allows the registering plugin (implicit grant)", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "sk-or-v1");
    const scoped = c.scopeFor("@elizaos/plugin-openrouter");
    expect(await scoped.resolve("llm.openrouter.apiKey")).toBe("sk-or-v1");
  });

  it("scoped lazyResolve fetches per call", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "v1");
    const scoped = c.scopeFor("@elizaos/plugin-openrouter");
    const lazy = scoped.lazyResolve("llm.openrouter.apiKey");
    expect(await lazy()).toBe("v1");
    await c.set("llm.openrouter.apiKey", "v2");
    expect(await lazy()).toBe("v2");
  });

  it("scoped resolve honors persisted explicit grants", async () => {
    // Pre-seed the store with an explicit grant before constructing.
    await writeStore(
      storePath,
      setPermissions(emptyStore(), "weather-bot", {
        grants: [
          {
            pattern: "llm.openrouter.apiKey",
            mode: "always",
            grantedAt: 1,
          },
        ],
      }),
    );
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "ok");
    const scoped = c.scopeFor("weather-bot");
    expect(await scoped.resolve("llm.openrouter.apiKey")).toBe("ok");
  });

  it("prompt-mode grant requires a PromptHandler; missing handler -> deny", async () => {
    await writeStore(
      storePath,
      setPermissions(emptyStore(), "weather-bot", {
        grants: [
          { pattern: "llm.openrouter.*", mode: "prompt", grantedAt: 1 },
        ],
      }),
    );
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "v");
    const scoped = c.scopeFor("weather-bot");
    await expect(scoped.resolve("llm.openrouter.apiKey")).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it("prompt-mode grant with handler asks once, caches approval per session", async () => {
    await writeStore(
      storePath,
      setPermissions(emptyStore(), "weather-bot", {
        grants: [
          { pattern: "llm.openrouter.*", mode: "prompt", grantedAt: 1 },
        ],
      }),
    );
    let prompts = 0;
    const c = createConfidant({
      storePath,
      auditLogPath: auditPath,
      masterKey: inMemoryMasterKey(generateMasterKey()),
      backends: [new EnvLegacyBackend()],
      promptHandler: {
        promptForGrant: async () => {
          prompts += 1;
          return true;
        },
      },
    });
    await c.set("llm.openrouter.apiKey", "v");
    const scoped = c.scopeFor("weather-bot");
    expect(await scoped.resolve("llm.openrouter.apiKey")).toBe("v");
    expect(await scoped.resolve("llm.openrouter.apiKey")).toBe("v");
    expect(prompts).toBe(1);
  });

  it("denial is recorded in the audit log", async () => {
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "v");
    const scoped = c.scopeFor("weather-bot");
    await expect(scoped.resolve("llm.openrouter.apiKey")).rejects.toThrow();
    const log = await fs.readFile(auditPath, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      skill: "weather-bot",
      secret: "llm.openrouter.apiKey",
      granted: false,
    });
  });

  it("granted resolves are recorded in the audit log", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "v");
    const scoped = c.scopeFor("@elizaos/plugin-openrouter");
    await scoped.resolve("llm.openrouter.apiKey");
    const log = await fs.readFile(auditPath, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({
      skill: "@elizaos/plugin-openrouter",
      secret: "llm.openrouter.apiKey",
      granted: true,
      source: "file",
    });
  });

  it("audit log NEVER contains the secret value", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const c = makeConfidant();
    const secret = "sk-or-v1-very-secret-VALUE";
    await c.set("llm.openrouter.apiKey", secret);
    const scoped = c.scopeFor("@elizaos/plugin-openrouter");
    await scoped.resolve("llm.openrouter.apiKey");
    const log = await fs.readFile(auditPath, "utf8");
    expect(log).not.toContain(secret);
  });

  it("concurrent set() calls do not corrupt the store", async () => {
    const c = makeConfidant();
    await Promise.all([
      c.set("llm.a.apiKey", "1"),
      c.set("llm.b.apiKey", "2"),
      c.set("llm.c.apiKey", "3"),
      c.set("llm.d.apiKey", "4"),
      c.set("llm.e.apiKey", "5"),
    ]);
    expect(await c.resolve("llm.a.apiKey")).toBe("1");
    expect(await c.resolve("llm.b.apiKey")).toBe("2");
    expect(await c.resolve("llm.c.apiKey")).toBe("3");
    expect(await c.resolve("llm.d.apiKey")).toBe("4");
    expect(await c.resolve("llm.e.apiKey")).toBe("5");
  });

  it("scopeFor rejects empty skill ids", () => {
    const c = makeConfidant();
    expect(() => c.scopeFor("")).toThrow();
    expect(() => c.scopeFor(undefined as never)).toThrow();
  });

  it("resolveDetailed reports source and cache flag", async () => {
    const c = makeConfidant();
    await c.set("llm.openrouter.apiKey", "v");
    const detail = await c.resolveDetailed("llm.openrouter.apiKey");
    expect(detail).toMatchObject({ value: "v", source: "file", cached: false });
  });
});
