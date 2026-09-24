/**
 * Backend-resolution tests with a fully controlled env object (never the
 * ambient process.env, so the suite is deterministic regardless of the shell's
 * keys). Pins the selection order and the NOT_CONFIGURED contract: no reachable
 * backend is a typed error, never a fabricated default.
 */

import { describe, expect, it } from "vitest";
import { EvidenceError } from "../errors.ts";
import {
  AnthropicBackend,
  DEFAULT_ANTHROPIC_MODEL,
  OpenAiCompatibleBackend,
} from "./backends.ts";
import { createBackendClient, resolveBackend } from "./config.ts";

const EMPTY: NodeJS.ProcessEnv = {};

describe("resolveBackend", () => {
  it("honors an explicit backend option over env", () => {
    expect(
      resolveBackend({ backend: "openai" }, { ANTHROPIC_API_KEY: "x" }),
    ).toBe("openai");
  });

  it("honors ELIZA_VISION_QA_BACKEND when no option given", () => {
    expect(
      resolveBackend(
        {},
        {
          ELIZA_VISION_QA_BACKEND: "local",
          ELIZA_VISION_QA_BASE_URL: "http://x",
        },
      ),
    ).toBe("local");
  });

  it("defaults to anthropic when the key is present", () => {
    expect(resolveBackend({}, { ANTHROPIC_API_KEY: "sk-ant" })).toBe(
      "anthropic",
    );
  });

  it("falls back to local when a base URL is set but no anthropic key", () => {
    expect(
      resolveBackend(
        {},
        { ELIZA_VISION_QA_BASE_URL: "http://127.0.0.1:8080/v1" },
      ),
    ).toBe("local");
    expect(resolveBackend({ baseUrl: "http://local" }, EMPTY)).toBe("local");
  });

  it("throws NOT_CONFIGURED with nothing reachable — no fabricated default", () => {
    try {
      resolveBackend({}, EMPTY);
      throw new Error("expected resolveBackend to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceError);
      expect((error as EvidenceError).code).toBe("VISION_NOT_CONFIGURED");
    }
  });

  it("rejects an invalid explicit backend value", () => {
    expect(() =>
      resolveBackend({}, { ELIZA_VISION_QA_BACKEND: "gemini" }),
    ).toThrowError(/invalid/);
  });
});

describe("createBackendClient", () => {
  it("builds an Anthropic client with the default model", () => {
    const client = createBackendClient(
      "anthropic",
      {},
      { ANTHROPIC_API_KEY: "k" },
    );
    expect(client).toBeInstanceOf(AnthropicBackend);
    expect(client.model).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("builds an openai-compatible client for the local backend from base URL", () => {
    const client = createBackendClient(
      "local",
      {},
      { ELIZA_VISION_QA_BASE_URL: "http://127.0.0.1:8080/v1" },
    );
    expect(client).toBeInstanceOf(OpenAiCompatibleBackend);
  });

  it("throws NOT_CONFIGURED when anthropic is selected without a key", () => {
    expect(() => createBackendClient("anthropic", {}, EMPTY)).toThrowError(
      /requires ANTHROPIC_API_KEY/,
    );
  });

  it("throws NOT_CONFIGURED when local is selected without a base URL", () => {
    expect(() => createBackendClient("local", {}, EMPTY)).toThrowError(
      /requires ELIZA_VISION_QA_BASE_URL/,
    );
  });

  it("respects a model override", () => {
    const client = createBackendClient(
      "anthropic",
      { model: "claude-custom" },
      { ANTHROPIC_API_KEY: "k" },
    );
    expect(client.model).toBe("claude-custom");
  });
});
