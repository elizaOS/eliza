import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTaskAgentFrameworkStateCache,
  getTaskAgentFrameworkState,
  type TaskAgentFrameworkProbe,
} from "../../src/services/task-agent-frameworks.js";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "BENCHMARK_MODEL_PROVIDER",
  "CEREBRAS_API_KEY",
  "CEREBRAS_BASE_URL",
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
  "PATH",
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
    ]),
  };
}

function delayedInstalledProbe(): TaskAgentFrameworkProbe {
  return {
    checkAvailableAgents: vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve([
              { adapter: "Claude Code", installed: true },
              { adapter: "OpenAI Codex", installed: true },
              { adapter: "OpenCode", installed: true },
            ]);
          }, 10);
        }),
    ),
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
    process.env.PATH = tempHome;
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

  it("defaults Cerebras-backed benchmark runs to OpenCode", async () => {
    setEnv({
      BENCHMARK_MODEL_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "csk-test",
    });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(state.preferred.id).toBe("opencode");
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

    expect(state.preferred.id).toBe("opencode");
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

  it("deduplicates concurrent preflight-backed cold fills", async () => {
    const probe = delayedInstalledProbe();

    const [first, second] = await Promise.all([
      getTaskAgentFrameworkState(runtime(), probe),
      getTaskAgentFrameworkState(runtime(), probe),
    ]);

    expect(probe.checkAvailableAgents).toHaveBeenCalledTimes(1);
    expect(
      first.frameworks.find((item) => item.id === "codex")?.installed,
    ).toBe(true);
    expect(
      second.frameworks.find((item) => item.id === "codex")?.installed,
    ).toBe(true);
  });

  it("keeps static and preflight discovery caches separate", async () => {
    const probe: TaskAgentFrameworkProbe = {
      checkAvailableAgents: vi.fn(async () => [
        {
          adapter: "OpenAI Codex",
          installed: true,
          installCommand: "preflight-codex-install",
        },
      ]),
    };

    const staticState = await getTaskAgentFrameworkState(runtime());
    const preflightState = await getTaskAgentFrameworkState(runtime(), probe);

    expect(probe.checkAvailableAgents).toHaveBeenCalledTimes(1);
    expect(
      staticState.frameworks.find((item) => item.id === "codex")
        ?.installCommand,
    ).toBeUndefined();
    expect(
      preflightState.frameworks.find((item) => item.id === "codex")
        ?.installCommand,
    ).toBe("preflight-codex-install");
  });
});
