/**
 * Guards `extractAndPersistFirstRunApiKey` against persisting a MASKED
 * provider key. The dashboard's GET /api/first-run response masks stored keys
 * as `****xxxx`; a client that echoes that placeholder back must never have it
 * written into config/env as if it were the credential — it either resolves to
 * the real key from local stores (process.env) or the persist is refused, so a
 * previously-working key on disk is never clobbered by the placeholder.
 *
 * Runs the REAL helper against the real on-disk eliza.json in a throwaway
 * ELIZA_STATE_DIR (same harness as first-run-persistence.restart.test.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadElizaConfig } from "@elizaos/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractAndPersistFirstRunApiKey } from "./server-first-run-helpers";

let stateDir: string;
let prevStateDir: string | undefined;
let prevHome: string | undefined;
let prevPersistPath: string | undefined;
let prevOpenAiKey: string | undefined;

beforeEach(() => {
  prevStateDir = process.env.ELIZA_STATE_DIR;
  prevHome = process.env.ELIZA_HOME;
  prevPersistPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
  prevOpenAiKey = process.env.OPENAI_API_KEY;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "first-run-masked-key-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_HOME = stateDir;
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("ELIZA_STATE_DIR", prevStateDir);
  restore("ELIZA_HOME", prevHome);
  restore("ELIZA_PERSIST_CONFIG_PATH", prevPersistPath);
  restore("OPENAI_API_KEY", prevOpenAiKey);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function readPersistedOpenAiKey(): unknown {
  const env = (loadElizaConfig() as Record<string, unknown>).env as
    | { vars?: Record<string, unknown> }
    | undefined;
  return env?.vars?.OPENAI_API_KEY;
}

function maskedBody(): Record<string, unknown> {
  return {
    credentialInputs: { llmApiKey: "****ab12" },
    serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
  };
}

describe("extractAndPersistFirstRunApiKey masked-key handling", () => {
  it("refuses to persist a masked key when no real key is resolvable (and never clobbers the stored one)", async () => {
    // Seed the durable config with a REAL key — the state a masked echo-back
    // request arrives in (the mask was produced FROM this stored key).
    const seeded = await extractAndPersistFirstRunApiKey({
      credentialInputs: { llmApiKey: "sk-real-abc123" },
      serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
    });
    expect(seeded).toBe("OPENAI_API_KEY");
    expect(readPersistedOpenAiKey()).toBe("sk-real-abc123");

    // Simulate a boot where the key lives only on disk (nothing resolvable
    // from process.env), then replay the masked placeholder.
    delete process.env.OPENAI_API_KEY;
    const result = await extractAndPersistFirstRunApiKey(maskedBody());

    expect(result).toBeNull();
    // The placeholder must not leak into the process env…
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    // …and the stored real key must survive untouched.
    expect(readPersistedOpenAiKey()).toBe("sk-real-abc123");
  });

  it("resolves a masked key to the real local credential instead of persisting the placeholder", async () => {
    process.env.OPENAI_API_KEY = "sk-env-real-999";

    const result = await extractAndPersistFirstRunApiKey(maskedBody());

    expect(result).toBe("OPENAI_API_KEY");
    expect(readPersistedOpenAiKey()).toBe("sk-env-real-999");
    expect(process.env.OPENAI_API_KEY).toBe("sk-env-real-999");
  });

  it("still persists a real user-typed key unchanged", async () => {
    const result = await extractAndPersistFirstRunApiKey({
      credentialInputs: { llmApiKey: "sk-typed-777" },
      serviceRouting: { llmText: { backend: "openai", transport: "direct" } },
    });
    expect(result).toBe("OPENAI_API_KEY");
    expect(readPersistedOpenAiKey()).toBe("sk-typed-777");
  });
});
