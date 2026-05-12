/**
 * Regression test for wave-6-f3 (bench-server Cerebras endpoint).
 *
 * Background: the W1-3 baseline (see
 * docs/audits/lifeops-2026-05-11/rebaseline-report.md) recorded 25 zero
 * scores from the eliza-tier bench because every useModel(TEXT_LARGE, ...)
 * call returned AI_APICallError: Not Found. Root cause: the OpenAI plugin
 * was routing through @ai-sdk/openai's Responses API (POST /v1/responses)
 * which Cerebras does not expose, instead of the Chat Completions API
 * (POST /v1/chat/completions).
 *
 * Two surfaces guard against regression:
 *
 *  1. packages/app-core/src/benchmark/cerebras-autowire.ts auto-wires
 *     OPENAI_BASE_URL=https://api.cerebras.ai/v1 (and pins the model id
 *     and provider hint) so the bench server boots with Cerebras config
 *     the openai plugin actually reads.
 *  2. plugins/plugin-openai/models/text.ts constructs its language model
 *     via openai.chat(modelName) (the chat-completions path) instead of
 *     openai.responses(...) or openai.languageModel(...). The
 *     @ai-sdk/openai provider maps chat() to /chat/completions and
 *     responses() to /responses (verified in
 *     node_modules under @ai-sdk+openai built dist).
 *
 * This test verifies (1) and inspects the plugin source for (2).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { autoWireCerebras } from "../cerebras-autowire";

const HERE = dirname(fileURLToPath(import.meta.url));

const ENV_KEYS = [
  "CEREBRAS_API_KEY",
  "CEREBRAS_BASE_URL",
  "CEREBRAS_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_LARGE_MODEL",
  "OPENAI_SMALL_MODEL",
  "MILADY_PROVIDER",
] as const;

describe("bench-server Cerebras autowiring", () => {
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prior = original.get(key);
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
    original.clear();
  });

  it("promotes CEREBRAS_API_KEY to chat-completions OpenAI-compat env when no OpenAI config is present", () => {
    process.env.CEREBRAS_API_KEY = "csk-test";

    autoWireCerebras();

    // Critical assertion: the wired base URL ends in /v1, NOT /v1/responses.
    // The ai-sdk/openai client's openai.chat(model) appends /chat/completions
    // to this URL, so the final wire path is /v1/chat/completions.
    expect(process.env.OPENAI_BASE_URL).toBe("https://api.cerebras.ai/v1");
    expect(process.env.OPENAI_BASE_URL).not.toContain("/responses");
    expect(process.env.OPENAI_API_KEY).toBe("csk-test");
    expect(process.env.MILADY_PROVIDER).toBe("cerebras");
    expect(process.env.OPENAI_LARGE_MODEL).toBe("gpt-oss-120b");
    expect(process.env.OPENAI_SMALL_MODEL).toBe("gpt-oss-120b");
  });

  it("respects an explicit CEREBRAS_BASE_URL override", () => {
    process.env.CEREBRAS_API_KEY = "csk-test";
    process.env.CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

    autoWireCerebras();

    expect(process.env.OPENAI_BASE_URL).toBe("https://api.cerebras.ai/v1");
    expect(process.env.OPENAI_BASE_URL).not.toContain("/responses");
  });

  it("respects an explicit CEREBRAS_MODEL override", () => {
    process.env.CEREBRAS_API_KEY = "csk-test";
    process.env.CEREBRAS_MODEL = "qwen-3-235b-a22b-instruct-2507";

    autoWireCerebras();

    expect(process.env.OPENAI_LARGE_MODEL).toBe(
      "qwen-3-235b-a22b-instruct-2507",
    );
    expect(process.env.OPENAI_SMALL_MODEL).toBe(
      "qwen-3-235b-a22b-instruct-2507",
    );
  });

  it("is a no-op when CEREBRAS_API_KEY is unset", () => {
    autoWireCerebras();

    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.MILADY_PROVIDER).toBeUndefined();
  });

  it("does not overwrite an explicit OPENAI_API_KEY (Anthropic and OpenAI-direct paths stay untouched)", () => {
    process.env.CEREBRAS_API_KEY = "csk-test";
    process.env.OPENAI_API_KEY = "sk-real-openai";

    autoWireCerebras();

    expect(process.env.OPENAI_API_KEY).toBe("sk-real-openai");
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.MILADY_PROVIDER).toBeUndefined();
  });

  it("does not overwrite an explicit OPENAI_BASE_URL", () => {
    process.env.CEREBRAS_API_KEY = "csk-test";
    process.env.OPENAI_BASE_URL = "https://api.openrouter.ai/api/v1";

    autoWireCerebras();

    expect(process.env.OPENAI_BASE_URL).toBe(
      "https://api.openrouter.ai/api/v1",
    );
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.MILADY_PROVIDER).toBeUndefined();
  });

  it("does not overwrite an explicit MILADY_PROVIDER", () => {
    process.env.CEREBRAS_API_KEY = "csk-test";
    process.env.MILADY_PROVIDER = "anthropic";

    autoWireCerebras();

    expect(process.env.MILADY_PROVIDER).toBe("anthropic");
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("preserves operator-supplied OPENAI_LARGE_MODEL and OPENAI_SMALL_MODEL pins", () => {
    process.env.CEREBRAS_API_KEY = "csk-test";
    process.env.OPENAI_LARGE_MODEL = "custom-large";
    process.env.OPENAI_SMALL_MODEL = "custom-small";

    // OPENAI_LARGE_MODEL and OPENAI_SMALL_MODEL don't gate the autowire
    // branch (only OPENAI_API_KEY, OPENAI_BASE_URL, and MILADY_PROVIDER do),
    // so we expect the base URL, key, and provider hint to land, but the
    // explicit model pins must survive.
    autoWireCerebras();

    expect(process.env.OPENAI_BASE_URL).toBe("https://api.cerebras.ai/v1");
    expect(process.env.OPENAI_LARGE_MODEL).toBe("custom-large");
    expect(process.env.OPENAI_SMALL_MODEL).toBe("custom-small");
  });
});

describe("plugin-openai model construction (static source check)", () => {
  // This is the second guard against the W1-3 404 regression. The model
  // construction site in plugin-openai/models/text.ts must use
  // openai.chat(modelName) (which routes to /v1/chat/completions) and
  // must NOT use openai.responses(...) or openai.languageModel(...)
  // (which would route to /v1/responses -- a path Cerebras does not expose).
  it("constructs the language model via openai.chat(), not openai.responses() or openai.languageModel()", () => {
    const textModelPath = join(
      HERE,
      "..",
      "..",
      "..",
      "..",
      "..",
      "plugins",
      "plugin-openai",
      "models",
      "text.ts",
    );
    const source = readFileSync(textModelPath, "utf8");

    // The only model construction call must be openai.chat(...).
    expect(source).toContain("openai.chat(");
    expect(source).not.toMatch(/openai\.responses\(/);
    expect(source).not.toMatch(/openai\.languageModel\(/);
  });
});
