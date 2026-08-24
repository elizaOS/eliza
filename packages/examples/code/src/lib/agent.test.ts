/**
 * Unit coverage for the Code example's runtime assembly entrypoints:
 * initializeAgent's fail-fast provider configuration matrix (explicit
 * providers, claude/codex aliases, ELIZA_CODE_MODEL_PROVIDER fallback,
 * case/whitespace normalization) and shutdownAgent's stop delegation.
 * Real deterministic harness against process.env with snapshot restore;
 * cases stop at the first boundary a unit test can observe without
 * constructing a live AgentRuntime (the success path needs a database).
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeAgent, shutdownAgent } from "./agent.ts";

/**
 * initializeAgent reads AND mutates these via applyElizaCodeProviderEnv, so
 * every case starts from a clean slate and afterEach restores the original
 * machine environment.
 */
const CONTROLLED_VARS = [
  "ELIZA_CODE_PROVIDER",
  "ELIZA_CODE_MODEL_PROVIDER",
  "ELIZA_CODE_API_KEY",
  "ELIZA_CODE_BASE_URL",
  "ELIZA_CODE_MODEL_POWERFUL",
  "ELIZA_CODE_MODEL_FAST",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_LARGE_MODEL",
  "OPENAI_SMALL_MODEL",
  "OPENAI_MEDIUM_MODEL",
  "ANTHROPIC_API_KEY",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of CONTROLLED_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CONTROLLED_VARS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("initializeAgent", () => {
  it("rejects when no provider is configured", async () => {
    await expect(initializeAgent({ loadDotenv: false })).rejects.toThrowError(
      /No model provider configured/,
    );
  });

  it("requires ANTHROPIC_API_KEY for an explicit anthropic provider", async () => {
    process.env.ELIZA_CODE_PROVIDER = "anthropic";
    await expect(initializeAgent({ loadDotenv: false })).rejects.toThrowError(
      "ANTHROPIC_API_KEY is required (ELIZA_CODE_PROVIDER=anthropic).",
    );
  });

  it("requires OPENAI_API_KEY for an explicit openai provider", async () => {
    process.env.ELIZA_CODE_PROVIDER = "openai";
    await expect(initializeAgent({ loadDotenv: false })).rejects.toThrowError(
      "OPENAI_API_KEY is required (ELIZA_CODE_PROVIDER=openai).",
    );
  });

  it("maps the claude alias onto the anthropic key requirement", async () => {
    process.env.ELIZA_CODE_PROVIDER = "claude";
    await expect(initializeAgent({ loadDotenv: false })).rejects.toThrowError(
      "ANTHROPIC_API_KEY is required (ELIZA_CODE_PROVIDER=anthropic).",
    );
  });

  it("maps the codex alias onto the openai key requirement", async () => {
    process.env.ELIZA_CODE_PROVIDER = "codex";
    await expect(initializeAgent({ loadDotenv: false })).rejects.toThrowError(
      "OPENAI_API_KEY is required (ELIZA_CODE_PROVIDER=openai).",
    );
  });

  it("falls back to ELIZA_CODE_MODEL_PROVIDER for the explicit choice", async () => {
    process.env.ELIZA_CODE_MODEL_PROVIDER = "anthropic";
    await expect(initializeAgent({ loadDotenv: false })).rejects.toThrowError(
      "ANTHROPIC_API_KEY is required (ELIZA_CODE_PROVIDER=anthropic).",
    );
  });

  it("trims and case-folds the explicit provider before validating", async () => {
    process.env.ELIZA_CODE_PROVIDER = "  Anthropic ";
    await expect(initializeAgent({ loadDotenv: false })).rejects.toThrowError(
      "ANTHROPIC_API_KEY is required (ELIZA_CODE_PROVIDER=anthropic).",
    );
  });

  it("treats a whitespace-only provider as unset and reports no configuration", async () => {
    process.env.ELIZA_CODE_PROVIDER = "   ";
    await expect(initializeAgent({ loadDotenv: false })).rejects.toThrowError(
      /No model provider configured/,
    );
  });

  it("lets an explicit provider win over an auto-detectable anthropic key", async () => {
    process.env.ELIZA_CODE_PROVIDER = "openai";
    process.env.ANTHROPIC_API_KEY = "key-anthropic";
    await expect(initializeAgent({ loadDotenv: false })).rejects.toThrowError(
      "OPENAI_API_KEY is required (ELIZA_CODE_PROVIDER=openai).",
    );
  });
});

describe("shutdownAgent", () => {
  it("stops the runtime exactly once", async () => {
    let stopCalls = 0;
    const runtime = {
      stop: async () => {
        stopCalls += 1;
      },
    } as unknown as AgentRuntime;

    await shutdownAgent(runtime);

    expect(stopCalls).toBe(1);
  });

  it("propagates a stop failure to the caller", async () => {
    const runtime = {
      stop: async () => {
        throw new Error("runtime stop failed");
      },
    } as unknown as AgentRuntime;

    await expect(shutdownAgent(runtime)).rejects.toThrowError(
      "runtime stop failed",
    );
  });
});
