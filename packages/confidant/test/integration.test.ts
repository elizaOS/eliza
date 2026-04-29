import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto/envelope.js";
import { inMemoryMasterKey } from "../src/crypto/master-key.js";
import { createConfidant } from "../src/confidant.js";
import { EnvLegacyBackend } from "../src/backends/env-legacy.js";
import { PermissionDeniedError } from "../src/policy/grants.js";
import {
  __resetSecretSchemaForTests,
  defineSecretSchema,
  lookupSchema,
} from "../src/secret-schema.js";

/**
 * End-to-end integration tests proving Confidant's contract is sufficient
 * to close the failure modes documented in §2 of the design doc. Each test
 * names a specific bug from existing elizaOS-based agents and demonstrates
 * that the bug is structurally impossible against the new architecture.
 */

describe("Confidant — bug-fix demonstrations", () => {
  let dir: string;
  let storePath: string;
  let auditPath: string;

  beforeEach(async () => {
    __resetSecretSchemaForTests();
    dir = await fs.mkdtemp(join(tmpdir(), "confidant-int-"));
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

  /**
   * BUG #3 in §2 of the design doc — "Catalog as authoritative."
   *
   * In the legacy save path, `Object.values(config).find(non-empty)` is
   * used to "find the API key" before calling `switchProvider`. That's
   * sensitive to JS object iteration order: whichever field the user
   * typed FIRST wins. If the user types the model field before the API
   * key field, the model slug overwrites the API key.
   *
   * Confidant closes this by making the schema authoritative. Each field
   * has a registered `sensitive` boolean. A schema-driven save path can
   * always identify which field is the credential, regardless of input
   * order.
   */
  it("model-slug-overwrites-API-key (bug #3): schema makes the legacy heuristic structurally unnecessary", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
      "llm.openrouter.largeModel": {
        label: "Large Model",
        sensitive: false,
        pluginId: "@elizaos/plugin-openrouter",
      },
      "llm.openrouter.smallModel": {
        label: "Small Model",
        sensitive: false,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });

    // Reproduce the user's actual incident: typing the LARGE_MODEL field
    // first, then the API key. JS Map preserves insertion order — exactly
    // the order Object.values() would surface in the legacy save path.
    const userInput = new Map<string, string>();
    userInput.set("llm.openrouter.largeModel", "tencent/hy3-preview");
    userInput.set("llm.openrouter.apiKey", "sk-or-v1-real-key");
    userInput.set("llm.openrouter.smallModel", "google/gemini-2.0-flash-001");

    // Legacy buggy heuristic — the actual code at
    // packages/app-core/src/state/usePluginsSkillsState.ts:246-251.
    const legacyHeuristic = Array.from(userInput.values()).find(
      (v) => typeof v === "string" && v.trim().length > 0,
    );
    expect(legacyHeuristic).toBe("tencent/hy3-preview"); // ← the bug

    // Schema-driven approach: ask the registry which field is sensitive.
    const credentials = Array.from(userInput).filter(
      ([id]) => lookupSchema(id)?.sensitive === true,
    );
    expect(credentials).toEqual([
      ["llm.openrouter.apiKey", "sk-or-v1-real-key"],
    ]);

    // End-to-end: persist exactly the registered credential, not a guess.
    const confidant = makeConfidant();
    for (const [id, value] of credentials) {
      await confidant.set(id, value);
    }
    expect(await confidant.resolve("llm.openrouter.apiKey")).toBe(
      "sk-or-v1-real-key",
    );
    expect(await confidant.has("llm.openrouter.largeModel")).toBe(false);
  });

  /**
   * BUG #1 in §2 — "Skill exfiltration."
   *
   * `process.env` is process-global; any plugin can read every credential.
   * Confidant's mediation boundary is `ScopedConfidant` per skill, with
   * deny-by-default and explicit grants.
   */
  it("skill exfiltration (bug #1): non-owning skills cannot resolve another plugin's credentials", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
      "llm.openai.apiKey": {
        label: "OpenAI API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openai",
      },
    });
    const confidant = makeConfidant();
    await confidant.set("llm.openrouter.apiKey", "sk-or-secret");
    await confidant.set("llm.openai.apiKey", "sk-openai-secret");

    // OpenRouter plugin can read its own; cannot read OpenAI's.
    const openrouter = confidant.scopeFor("@elizaos/plugin-openrouter");
    expect(await openrouter.resolve("llm.openrouter.apiKey")).toBe(
      "sk-or-secret",
    );
    await expect(openrouter.resolve("llm.openai.apiKey")).rejects.toThrow(
      PermissionDeniedError,
    );

    // A user-installed third-party skill ("weather-bot") can't read either.
    const weatherBot = confidant.scopeFor("weather-bot");
    await expect(
      weatherBot.resolve("llm.openrouter.apiKey"),
    ).rejects.toThrow(PermissionDeniedError);
    await expect(
      weatherBot.resolve("llm.openai.apiKey"),
    ).rejects.toThrow(PermissionDeniedError);
  });

  /**
   * BUG #6 in §2 — "No reveal."
   *
   * The Settings UI cannot round-trip a saved API key today; users have
   * to open ~/.milady/milady.json by hand to verify what was stored.
   * Confidant supports a programmatic round-trip (the foundation a UI
   * "Reveal" button would call); this test demonstrates parity.
   */
  it("no-reveal (bug #6): saved values can be round-tripped programmatically", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const confidant = makeConfidant();
    const saved = "sk-or-v1-from-settings-ui";
    await confidant.set("llm.openrouter.apiKey", saved);
    const detail = await confidant.resolveDetailed("llm.openrouter.apiKey");
    expect(detail.value).toBe(saved);
    expect(detail.source).toBe("file");
    expect(detail.cached).toBe(false);
  });

  /**
   * The combined claim of §2: "the schema is the single source of truth."
   *
   * No code path inside Confidant uses `Object.values(...).find(...)` or
   * any field-order-dependent heuristic to identify what's a credential.
   * Even a save path that took every form value verbatim would correctly
   * persist the API key under its registered id.
   */
  it("schema-driven save: arbitrary input order produces correct persistence", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
      "llm.openrouter.largeModel": {
        label: "Large Model",
        sensitive: false,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const orderings: Array<Array<[string, string]>> = [
      [
        ["llm.openrouter.apiKey", "sk-or-v1-A"],
        ["llm.openrouter.largeModel", "model-A"],
      ],
      [
        ["llm.openrouter.largeModel", "model-B"],
        ["llm.openrouter.apiKey", "sk-or-v1-B"],
      ],
    ];
    for (const ordering of orderings) {
      const confidant = makeConfidant();
      for (const [id, value] of ordering) {
        await confidant.set(id, value);
      }
      const expectedKey = ordering.find(
        ([id]) => id === "llm.openrouter.apiKey",
      )?.[1];
      expect(await confidant.resolve("llm.openrouter.apiKey")).toBe(
        expectedKey,
      );
    }
  });

  /**
   * Storage opacity: a consumer that calls `resolve(id)` cannot tell
   * whether the value lives in the file, the keyring, env, or a future
   * password-manager backend. The interface absorbs the difference.
   */
  it("storage opacity: same id can be a literal one moment and a reference the next", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const env = { OPENROUTER_API_KEY: "from-env-var" } as NodeJS.ProcessEnv;
    const confidant = createConfidant({
      storePath,
      auditLogPath: auditPath,
      masterKey: inMemoryMasterKey(generateMasterKey()),
      backends: [new EnvLegacyBackend(env)],
    });

    // Literal phase
    await confidant.set("llm.openrouter.apiKey", "literal-value");
    expect(await confidant.resolve("llm.openrouter.apiKey")).toBe(
      "literal-value",
    );

    // Switch to reference; consumer's call signature is unchanged.
    await confidant.setReference(
      "llm.openrouter.apiKey",
      "env://OPENROUTER_API_KEY",
    );
    expect(await confidant.resolve("llm.openrouter.apiKey")).toBe(
      "from-env-var",
    );
  });

  /**
   * The full audit trail: a granted resolve and a denied resolve are both
   * recorded, with the secret value never appearing in the log.
   */
  it("audit trail: every resolve is recorded with id + skill + outcome, never the value", async () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const confidant = makeConfidant();
    const secret = "sk-or-v1-must-not-appear-in-log";
    await confidant.set("llm.openrouter.apiKey", secret);

    // Granted (implicit owner).
    const owner = confidant.scopeFor("@elizaos/plugin-openrouter");
    await owner.resolve("llm.openrouter.apiKey");

    // Denied (third-party).
    const intruder = confidant.scopeFor("@third-party/intruder-bot");
    await expect(
      intruder.resolve("llm.openrouter.apiKey"),
    ).rejects.toThrow(PermissionDeniedError);

    const log = await fs.readFile(auditPath, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      skill: "@elizaos/plugin-openrouter",
      secret: "llm.openrouter.apiKey",
      granted: true,
    });
    expect(lines[1]).toMatchObject({
      skill: "@third-party/intruder-bot",
      secret: "llm.openrouter.apiKey",
      granted: false,
    });
    expect(log).not.toContain(secret);
  });
});
