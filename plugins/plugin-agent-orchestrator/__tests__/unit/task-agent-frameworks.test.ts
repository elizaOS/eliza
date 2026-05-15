import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTaskAgentFrameworkStateCache,
  getTaskAgentFrameworkState,
  getTaskAgentModelPrefs,
  type TaskAgentFrameworkProbe,
} from "../../src/services/task-agent-frameworks.js";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "BENCHMARK_MODEL_PROVIDER",
  "CEREBRAS_API_KEY",
  "CEREBRAS_BASE_URL",
  "CEREBRAS_MODEL",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_API_KEY",
  "CODEX_API_KEY",
  "ELIZA_AGENT_SELECTION_STRATEGY",
  "ELIZA_CONFIG_PATH",
  "ELIZA_DEFAULT_AGENT_TYPE",
  "ELIZA_LLM_PROVIDER",
  "ELIZA_PROVIDER",
  "HOME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

const savedEnv = new Map<string, string | undefined>();
let tempHome: string;

function runtime(settings: Record<string, string | undefined> = {}) {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

function installedProbe(): TaskAgentFrameworkProbe {
  return {
    checkAvailableAgents: vi.fn(async () => [
      { adapter: "Claude Code", installed: true },
      { adapter: "OpenAI Codex", installed: true },
      { adapter: "OpenCode", installed: true },
      { adapter: "elizaOS", installed: true },
      { adapter: "Pi Agent", installed: true },
    ]),
  };
}

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("getTaskAgentFrameworkState", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-frameworks-"));
    process.env.HOME = tempHome;
    process.env.ELIZA_CONFIG_PATH = path.join(tempHome, "missing-eliza.json");
    clearTaskAgentFrameworkStateCache();
  });

  afterEach(() => {
    clearTaskAgentFrameworkStateCache();
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedEnv.clear();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("defaults Cerebras-backed benchmark runs to elizaOS", async () => {
    setEnv({
      BENCHMARK_MODEL_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "csk-test",
    });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(state.preferred.id).toBe("elizaos");
    expect(
      state.frameworks.find((item) => item.id === "elizaos")?.authReady,
    ).toBe(true);
    expect(
      state.frameworks.find((item) => item.id === "opencode")?.authReady,
    ).toBe(true);
    expect(
      state.frameworks.find((item) => item.id === "codex")?.authReady,
    ).toBe(false);
  });

  it("does not treat a Cerebras-mirrored OpenAI key as Codex auth", async () => {
    setEnv({
      BENCHMARK_MODEL_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "csk-test",
      OPENAI_API_KEY: "csk-test",
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
    });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(state.preferred.id).toBe("elizaos");
    expect(
      state.frameworks.find((item) => item.id === "elizaos")?.authReady,
    ).toBe(true);
    expect(
      state.frameworks.find((item) => item.id === "codex")?.authReady,
    ).toBe(false);
  });

  it("prefers Codex when a Codex-specific key is present", async () => {
    setEnv({ CODEX_API_KEY: "codex-test" });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(state.preferred.id).toBe("codex");
    expect(
      state.frameworks.find((item) => item.id === "codex")?.authReady,
    ).toBe(true);
  });

  it("prefers Claude when a Claude-specific key is present", async () => {
    setEnv({ ANTHROPIC_API_KEY: "anthropic-test" });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(state.preferred.id).toBe("claude");
    expect(
      state.frameworks.find((item) => item.id === "claude")?.authReady,
    ).toBe(true);
  });

  it("uses Cerebras model overrides for elizaOS and pi-agent model prefs", () => {
    setEnv({ CEREBRAS_MODEL: "gpt-oss-120b-test" });

    expect(getTaskAgentModelPrefs(runtime(), "elizaos")).toEqual({
      powerful: "gpt-oss-120b-test",
    });
    expect(getTaskAgentModelPrefs(runtime(), "pi-agent")).toEqual({
      powerful: "gpt-oss-120b-test",
    });
  });

  it("lets adapter-specific model prefs override generic Cerebras defaults", () => {
    setEnv({ CEREBRAS_MODEL: "gpt-oss-120b-generic" });

    expect(
      getTaskAgentModelPrefs(
        runtime({ ELIZA_ELIZAOS_MODEL_POWERFUL: "gpt-oss-120b-eliza" }),
        "elizaos",
      ),
    ).toEqual({ powerful: "gpt-oss-120b-eliza" });
  });
});
