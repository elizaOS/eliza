/**
 * Regression for incident #27268. `createOpenAIClient` builds the OpenAI client
 * from the resolved key; when no key resolves (no OPENAI_API_KEY / compatible
 * alias and not proxy mode) the provider cannot serve the call.
 *
 * The throw is TYPED (`ElizaError` with code `OPENAI_CREDENTIAL_UNAVAILABLE`)
 * so the runtime's `useModel` failover loop classifies it as fallback-class and
 * advances to the next registered RESPONSE_HANDLER — e.g. a pooled
 * ChatGPT/Codex handler (plugin-codex-cli) leasing an `openai-codex`
 * subscription seat through the local codex-proxy — instead of stranding the
 * brain on the pre-fix bare "OPENAI_API_KEY is required" Error.
 *
 * These are node/shape tests: no network, no live model calls.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAIClient, OPENAI_CREDENTIAL_UNAVAILABLE } from "../providers/openai";

function buildRuntime(settings: Record<string, string | undefined>): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => (key in settings ? (settings[key] ?? null) : null)),
  } as unknown as IAgentRuntime;
}

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "EVOLINK_API_KEY",
  "OPENAI_BASE_URL",
  "ELIZA_PROVIDER",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = originalEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  vi.restoreAllMocks();
});

describe("createOpenAIClient missing-credential classification (incident #27268)", () => {
  it("throws a typed, fallback-classifiable ElizaError when no key resolves (fail-closed)", () => {
    const runtime = buildRuntime({});
    let thrown: unknown;
    try {
      createOpenAIClient(runtime);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    const err = thrown as ElizaError;
    // The typed code is what unblocks failover to a pooled openai-codex handler.
    expect(err.code).toBe(OPENAI_CREDENTIAL_UNAVAILABLE);
    expect(OPENAI_CREDENTIAL_UNAVAILABLE).toBe("OPENAI_CREDENTIAL_UNAVAILABLE");
    // Operator-facing hint preserved verbatim.
    expect(err.message).toContain("OPENAI_API_KEY is required");
    // Not a hard/fatal secret leak: ephemeral, no key material in the message.
    expect(err.severity).toBe("ephemeral");
    expect(err.message).not.toMatch(/sk-/);
  });

  it("short-circuits on an explicit OPENAI_API_KEY (no throw, env-first unchanged)", () => {
    const runtime = buildRuntime({ OPENAI_API_KEY: "sk-test-key" });
    // A concrete client is returned; construction does not throw.
    const client = createOpenAIClient(runtime);
    expect(typeof client).toBe("function");
  });
});
