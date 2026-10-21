/**
 * Proves a malformed `OLLAMA_BASE_URL` cannot masquerade as "no Ollama endpoint
 * configured".
 *
 * The chat route picks its wall-clock deadline from this classification: a
 * remote Ollama (Pi -> VPS) gets 600s because a turn runs several model calls,
 * everything else gets 180s. When the configured value fails `new URL()`
 * (`192.168.1.50:11434` is a common scheme-less form), the parse error was
 * swallowed into `false`, so the operator's deliberate remote endpoint was
 * silently treated as absent and slow turns died as
 * "chat generation timed out after 180000ms" instead of naming the broken
 * variable.
 */
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveChatGenerationTimeoutMs } from "../src/api/chat-routes.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const REMOTE_TIMEOUT_MS = 600_000;

const TOUCHED_ENV = [
  "OLLAMA_BASE_URL",
  "OLLAMA_API_ENDPOINT",
  "ELIZA_CHAT_GENERATION_TIMEOUT_MS",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of TOUCHED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of TOUCHED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("reports an unparseable Ollama endpoint instead of silently using the local timeout", () => {
  // Premise: this is the exact shape `new URL()` rejects.
  expect(() => new URL("192.168.1.50:11434")).toThrow();

  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  process.env.OLLAMA_BASE_URL = "192.168.1.50:11434";

  // An unparseable endpoint still must not be guessed into "remote"...
  expect(resolveChatGenerationTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  // ...but the misconfiguration must be visible rather than swallowed.
  expect(warn).toHaveBeenCalledTimes(1);
  const reported = String(warn.mock.calls[0]?.[0] ?? "");
  expect(reported).toContain("OLLAMA_BASE_URL");
  expect(reported).toContain("192.168.1.50:11434");
});

it("names the misconfigured variable without copying endpoint credentials into the log", () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  // Userinfo without a host is the shape that carries credentials *and* fails
  // `new URL()`, so it reaches the warning path with the secret still attached.
  expect(() => new URL("http://user:sup3rtoken@")).toThrow();
  process.env.OLLAMA_BASE_URL = "http://user:sup3rtoken@";

  expect(resolveChatGenerationTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  expect(warn).toHaveBeenCalledTimes(1);
  const reported = String(warn.mock.calls[0]?.[0] ?? "");
  expect(reported).toContain("OLLAMA_BASE_URL");
  expect(reported).not.toContain("sup3rtoken");
  expect(reported).not.toContain("user:");
  // Still identifiable as the operator's setting, minus the credential.
  expect(reported).toContain("http://***@");
});

it("keeps a valid remote endpoint on the long timeout without warning", () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  process.env.OLLAMA_BASE_URL = "http://pi.lan:11434/api";

  expect(resolveChatGenerationTimeoutMs()).toBe(REMOTE_TIMEOUT_MS);
  expect(warn).not.toHaveBeenCalled();
});

it("stays quiet for the legitimate no-endpoint and localhost cases", () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

  expect(resolveChatGenerationTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);

  process.env.OLLAMA_API_ENDPOINT = "http://localhost:11434";
  expect(resolveChatGenerationTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);

  expect(warn).not.toHaveBeenCalled();
});
