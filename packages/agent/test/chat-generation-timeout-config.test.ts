/**
 * Proves a malformed Ollama endpoint cannot masquerade as "no Ollama endpoint
 * configured". `resolveChatGenerationTimeoutMs` reads that answer only to pick
 * a generation deadline: a `catch { return false }` on an unparseable
 * `OLLAMA_BASE_URL` silently swapped the 600s remote deadline for the 180s
 * local one, so a slow remote model surfaced to the client as a bogus
 * "Chat generation timed out" turn instead of a configuration error.
 */
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveChatGenerationTimeoutMs } from "../src/api/chat-routes.ts";

const ENV_KEYS = [
  "OLLAMA_BASE_URL",
  "OLLAMA_API_ENDPOINT",
  "ELIZA_CHAT_GENERATION_TIMEOUT_MS",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("keeps the local deadline when no Ollama endpoint is configured", () => {
  expect(resolveChatGenerationTimeoutMs()).toBe(180000);
});

it("keeps the local deadline for a loopback Ollama endpoint", () => {
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434/api/";
  expect(resolveChatGenerationTimeoutMs()).toBe(180000);
});

it("keeps the remote deadline for a remote Ollama endpoint", () => {
  process.env.OLLAMA_BASE_URL = "http://gpu-box.lan:11434";
  expect(resolveChatGenerationTimeoutMs()).toBe(600000);
});

it("rejects a configured endpoint that is not a URL instead of using the local deadline", () => {
  process.env.OLLAMA_BASE_URL = "http://";
  let observed: unknown;
  try {
    observed = { resolvedWith: resolveChatGenerationTimeoutMs() };
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(ElizaError);
  expect(observed).toMatchObject({
    code: "OLLAMA_ENDPOINT_INVALID",
    cause: expect.any(Error),
    context: { endpoint: "http://" },
  });
});
