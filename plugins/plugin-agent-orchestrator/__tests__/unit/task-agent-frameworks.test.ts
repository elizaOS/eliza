/**
 * Verifies getTaskAgentFrameworkState.
 * Runs against a real temporary filesystem with a stubbed runtime; no live model.
 */
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
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_API_KEY",
  "CODEX_API_KEY",
  "ELIZA_AGENT_SELECTION_STRATEGY",
  "ELIZA_CODEX_ACP_COMMAND",
  "ELIZA_CONFIG_PATH",
  "ELIZA_DEFAULT_AGENT_TYPE",
  "ELIZA_ELIZAOS_ACP_COMMAND",
  "ELIZA_FRAMEWORK_PREFLIGHT_TIMEOUT_MS",
  "ELIZA_LLM_PROVIDER",
  "ELIZA_PI_AGENT_ACP_COMMAND",
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

function writeExecutable(filePath: string) {
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(filePath, 0o755);
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

  it("does not expose OpenCode for Cerebras-backed benchmark runs", async () => {
    setEnv({
      BENCHMARK_MODEL_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "csk-test",
    });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(state.frameworks.some((item) => item.id === "opencode")).toBe(false);
    expect(
      state.frameworks.find((item) => item.id === "codex")?.authReady,
    ).toBe(false);
  });

  it("prefers eliza-code as the BYO default once eliza-code is installed", async () => {
    writeExecutable(path.join(tempHome, "eliza-code-acp"));
    setEnv({
      ELIZA_ELIZAOS_ACP_COMMAND: "eliza-code-acp",
      BENCHMARK_MODEL_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "csk-test",
    });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(state.preferred.id).toBe("elizaos");
    expect(
      state.frameworks.find((item) => item.id === "elizaos")?.installed,
    ).toBe(true);
    expect(state.frameworks.some((item) => item.id === "opencode")).toBe(false);
  });

  it("honors ElizaOS as an explicit native task-agent default", async () => {
    setEnv({
      ELIZA_DEFAULT_AGENT_TYPE: "elizaos",
      BENCHMARK_MODEL_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "csk-test",
    });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(state.preferred.id).toBe("elizaos");
    expect(
      state.frameworks.find((item) => item.id === "elizaos")?.installed,
    ).toBe(true);
    expect(
      state.frameworks.find((item) => item.id === "elizaos")?.authReady,
    ).toBe(true);
  });

  it("honors Pi Agent as an explicit native task-agent default", async () => {
    setEnv({
      ELIZA_DEFAULT_AGENT_TYPE: "pi-agent",
      BENCHMARK_MODEL_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "csk-test",
    });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(state.preferred.id).toBe("pi-agent");
    expect(
      state.frameworks.find((item) => item.id === "pi-agent")?.installed,
    ).toBe(true);
    expect(
      state.frameworks.find((item) => item.id === "pi-agent")?.authReady,
    ).toBe(true);
  });

  it("fails Pi Agent readiness closed when a configured ACP command is missing", async () => {
    writeExecutable(path.join(tempHome, "pi-agent"));
    setEnv({
      ELIZA_PI_AGENT_ACP_COMMAND: "missing-pi-agent-acp --stdio",
    });

    const state = await getTaskAgentFrameworkState(runtime());

    expect(
      state.frameworks.find((item) => item.id === "pi-agent")?.installed,
    ).toBe(false);
  });

  it("rejects a configured Pi Agent ACP command when the file is not executable", async () => {
    const commandPath = path.join(tempHome, "pi-agent-acp");
    fs.writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(commandPath, 0o644);
    setEnv({
      ELIZA_PI_AGENT_ACP_COMMAND: "pi-agent-acp --stdio",
    });

    const state = await getTaskAgentFrameworkState(runtime());

    expect(
      state.frameworks.find((item) => item.id === "pi-agent")?.installed,
    ).toBe(false);
  });

  it("accepts a configured Pi Agent ACP shell command when the leading executable exists", async () => {
    writeExecutable(path.join(tempHome, "pi-agent-acp"));
    setEnv({
      ELIZA_PI_AGENT_ACP_COMMAND: "pi-agent-acp --stdio --flag value",
    });

    const state = await getTaskAgentFrameworkState(runtime());

    expect(
      state.frameworks.find((item) => item.id === "pi-agent")?.installed,
    ).toBe(true);
  });

  it("does not treat a Cerebras-mirrored OpenAI key as Codex auth", async () => {
    setEnv({
      BENCHMARK_MODEL_PROVIDER: "cerebras",
      CEREBRAS_API_KEY: "csk-test",
      OPENAI_API_KEY: "csk-test",
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
    });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(state.frameworks.some((item) => item.id === "opencode")).toBe(false);
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

  it("fails Codex readiness closed when a configured ACP command is missing", async () => {
    writeExecutable(path.join(tempHome, "codex"));
    setEnv({
      CODEX_API_KEY: "codex-test",
      ELIZA_CODEX_ACP_COMMAND: "missing-codex-acp --stdio",
    });

    const state = await getTaskAgentFrameworkState(runtime());

    expect(
      state.frameworks.find((item) => item.id === "codex")?.installed,
    ).toBe(false);
  });

  it("rejects a configured Codex ACP command when the file is not executable", async () => {
    const commandPath = path.join(tempHome, "codex-acp");
    fs.writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(commandPath, 0o644);
    setEnv({
      CODEX_API_KEY: "codex-test",
      ELIZA_CODEX_ACP_COMMAND: "codex-acp --stdio",
    });

    const state = await getTaskAgentFrameworkState(runtime());

    expect(
      state.frameworks.find((item) => item.id === "codex")?.installed,
    ).toBe(false);
  });

  it("accepts a configured Codex ACP shell command when the leading executable exists", async () => {
    writeExecutable(path.join(tempHome, "codex-acp"));
    setEnv({
      CODEX_API_KEY: "codex-test",
      ELIZA_CODEX_ACP_COMMAND: "codex-acp --stdio --flag value",
    });

    const state = await getTaskAgentFrameworkState(runtime());

    expect(
      state.frameworks.find((item) => item.id === "codex")?.installed,
    ).toBe(true);
  });

  it("validates configured ElizaOS ACP absolute commands instead of trusting the env var", async () => {
    const commandPath = path.join(tempHome, "eliza-code-acp");
    writeExecutable(commandPath);

    setEnv({ ELIZA_ELIZAOS_ACP_COMMAND: `"${commandPath}" --stdio` });
    const installedState = await getTaskAgentFrameworkState(runtime());
    expect(
      installedState.frameworks.find((item) => item.id === "elizaos")
        ?.installed,
    ).toBe(true);

    clearTaskAgentFrameworkStateCache();
    setEnv({ ELIZA_ELIZAOS_ACP_COMMAND: `${commandPath}-missing --stdio` });
    const missingState = await getTaskAgentFrameworkState(runtime());
    expect(
      missingState.frameworks.find((item) => item.id === "elizaos")?.installed,
    ).toBe(false);
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

  it.each([
    "249",
    "250oops",
    "250.5",
    "2.5e2",
    "0250",
    "2147483648",
    "9007199254740992",
  ])("rejects malformed framework preflight timeout %s", async (value) => {
    const probe = installedProbe();
    setEnv({ ELIZA_FRAMEWORK_PREFLIGHT_TIMEOUT_MS: value });

    await expect(
      getTaskAgentFrameworkState(runtime(), probe),
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "FRAMEWORK_PREFLIGHT_TIMEOUT_INVALID",
      context: {
        configured: value,
        minimum: 250,
        maximum: 2_147_483_647,
      },
    });
    expect(probe.checkAvailableAgents).not.toHaveBeenCalled();
  });

  it("accepts the minimum framework preflight timeout", async () => {
    setEnv({ ELIZA_FRAMEWORK_PREFLIGHT_TIMEOUT_MS: "250" });

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(
      state.frameworks.find((item) => item.id === "codex")?.installed,
    ).toBe(true);
  });

  it("accepts Node's maximum timer delay for framework preflight", async () => {
    setEnv({ ELIZA_FRAMEWORK_PREFLIGHT_TIMEOUT_MS: "2147483647" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const state = await getTaskAgentFrameworkState(runtime(), installedProbe());

    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      2_147_483_647,
    );
    setTimeoutSpy.mockRestore();
    expect(
      state.frameworks.find((item) => item.id === "codex")?.installed,
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

// Model prefs must honor a freshly-saved config-file value on the NEXT spawn:
// runtime.getSetting snapshots character settings at boot, so config-env is
// checked first (matching how the codex/opencode prefs already behave).
describe("getTaskAgentModelPrefs", () => {
  const PREF_ENV_KEYS = [
    "ELIZA_CONFIG_PATH",
    "ELIZA_CLAUDE_MODEL_POWERFUL",
    "ELIZA_CLAUDE_MODEL_FAST",
  ] as const;
  const savedPrefEnv = new Map<string, string | undefined>();
  let prefTempHome: string;

  beforeEach(() => {
    for (const key of PREF_ENV_KEYS) {
      savedPrefEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    prefTempHome = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-modelprefs-"));
    process.env.ELIZA_CONFIG_PATH = path.join(
      prefTempHome,
      "missing-eliza.json",
    );
  });

  afterEach(() => {
    for (const key of PREF_ENV_KEYS) {
      const value = savedPrefEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedPrefEnv.clear();
    fs.rmSync(prefTempHome, { recursive: true, force: true });
  });

  it("defaults the claude powerful model to claude-opus-4-8", () => {
    const prefs = getTaskAgentModelPrefs(runtime(), "claude");
    expect(prefs?.powerful).toBe("claude-opus-4-8");
  });

  it("resolves a freshly-saved config value without restart (config beats the stale runtime snapshot)", () => {
    const configPath = path.join(prefTempHome, "eliza.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        env: { ELIZA_CLAUDE_MODEL_POWERFUL: "claude-sonnet-5" },
      }),
    );
    process.env.ELIZA_CONFIG_PATH = configPath;
    // The runtime still holds the boot-time value — the config file must win.
    const stale = runtime({ ELIZA_CLAUDE_MODEL_POWERFUL: "claude-opus-4-7" });
    expect(getTaskAgentModelPrefs(stale, "claude")?.powerful).toBe(
      "claude-sonnet-5",
    );
    // Without the config entry, the runtime setting is the fallback.
    fs.writeFileSync(configPath, JSON.stringify({ env: {} }));
    expect(getTaskAgentModelPrefs(stale, "claude")?.powerful).toBe(
      "claude-opus-4-7",
    );
  });
});
