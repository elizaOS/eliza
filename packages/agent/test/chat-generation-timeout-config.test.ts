/**
 * An operator-supplied Ollama endpoint that cannot be parsed is broken
 * configuration, not "no remote endpoint configured". Before the fix the URL
 * parse failure was swallowed and the local generation timeout was returned, so
 * the eventual failure surfaced as "Chat generation timed out after 180000ms"
 * with no hint that the endpoint string was the cause.
 */
import { afterEach, expect, it, vi } from "vitest";
import { resolveChatGenerationTimeoutMs } from "../src/api/chat-routes.ts";

const LOCAL_DEFAULT_MS = 180000;
const REMOTE_MS = 600000;

const savedBaseUrl = process.env.OLLAMA_BASE_URL;
const savedApiEndpoint = process.env.OLLAMA_API_ENDPOINT;
const savedExplicitTimeout = process.env.ELIZA_CHAT_GENERATION_TIMEOUT_MS;

afterEach(() => {
  restore("OLLAMA_BASE_URL", savedBaseUrl);
  restore("OLLAMA_API_ENDPOINT", savedApiEndpoint);
  restore("ELIZA_CHAT_GENERATION_TIMEOUT_MS", savedExplicitTimeout);
  vi.restoreAllMocks();
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function silenceExplicitTimeout(): void {
  delete process.env.ELIZA_CHAT_GENERATION_TIMEOUT_MS;
}

it("reports an unparseable OLLAMA_BASE_URL instead of silently treating it as unset", () => {
  silenceExplicitTimeout();
  delete process.env.OLLAMA_API_ENDPOINT;
  process.env.OLLAMA_BASE_URL = "http://";
  const warn = vi.fn();

  // A typo must not break chat, so the local timeout is still the answer...
  expect(resolveChatGenerationTimeoutMs({ warn })).toBe(LOCAL_DEFAULT_MS);
  // ...but it must no longer be indistinguishable from "nothing configured".
  expect(warn).toHaveBeenCalledTimes(1);
  const [entry, message] = warn.mock.calls[0];
  expect(JSON.stringify([entry, message])).toContain("OLLAMA_BASE_URL");
  expect(JSON.stringify([entry, message])).toContain("http://");
});

it("keeps an unset endpoint silent and still honours a usable remote one", () => {
  silenceExplicitTimeout();
  const warn = vi.fn();

  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_API_ENDPOINT;
  expect(resolveChatGenerationTimeoutMs({ warn })).toBe(LOCAL_DEFAULT_MS);
  expect(warn).not.toHaveBeenCalled();

  process.env.OLLAMA_BASE_URL = "https://ollama.internal:11434/api";
  expect(resolveChatGenerationTimeoutMs({ warn })).toBe(REMOTE_MS);
  expect(warn).not.toHaveBeenCalled();
});

it("warns once per broken endpoint value rather than on every chat request", () => {
  silenceExplicitTimeout();
  delete process.env.OLLAMA_API_ENDPOINT;
  process.env.OLLAMA_BASE_URL = "https://[::1";
  const warn = vi.fn();

  resolveChatGenerationTimeoutMs({ warn });
  resolveChatGenerationTimeoutMs({ warn });
  resolveChatGenerationTimeoutMs({ warn });

  expect(warn).toHaveBeenCalledTimes(1);
});
