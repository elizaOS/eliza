/**
 * Tests for task-agent framework discovery, specifically covering the
 * `agents.defaults.orchestrator.codexSubscriptionRestrictedToCodexFramework`
 * config flag. When set, Codex (ChatGPT Plus/Pro) subscription tokens must
 * only count toward `subscriptionReady`/`authReady` for the `codex` framework.
 *
 * We isolate the filesystem by pointing ELIZA_STATE_DIR and HOME at a temp
 * directory, then writing a fake Codex auth.json + eliza.json. No mocks of
 * the module graph — we exercise the real config readers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfigCodexSubscriptionRestrictedToCodexFramework } from "../services/config-env.js";
import {
  clearTaskAgentFrameworkStateCache,
  getTaskAgentFrameworkState,
  getTaskAgentModelPrefs,
} from "../services/task-agent-frameworks.js";

function createRuntime(
  settings: Record<string, string | undefined> = {},
): IAgentRuntime {
  const runtime = {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getSetting: (key: string) => settings[key],
    getService: () => null,
  };
  return runtime as unknown as IAgentRuntime;
}

interface FrameworkFixture {
  tmpRoot: string;
  previous: {
    ELIZA_STATE_DIR: string | undefined;
    ELIZA_NAMESPACE: string | undefined;
    ELIZA_CONFIG_PATH: string | undefined;
    HOME: string | undefined;
    USERPROFILE: string | undefined;
    OPENAI_API_KEY: string | undefined;
    ANTHROPIC_API_KEY: string | undefined;
    GOOGLE_API_KEY: string | undefined;
    GOOGLE_GENERATIVE_AI_API_KEY: string | undefined;
    PARALLAX_LLM_PROVIDER: string | undefined;
    PARALLAX_DEFAULT_AGENT_TYPE: string | undefined;
    PARALLAX_CLAUDE_MODEL_POWERFUL: string | undefined;
    PARALLAX_CLAUDE_MODEL_FAST: string | undefined;
    PARALLAX_CODEX_MODEL_POWERFUL: string | undefined;
    PARALLAX_CODEX_MODEL_FAST: string | undefined;
    PARALLAX_GEMINI_MODEL_POWERFUL: string | undefined;
    PARALLAX_GEMINI_MODEL_FAST: string | undefined;
    PARALLAX_AIDER_MODEL_POWERFUL: string | undefined;
    PARALLAX_AIDER_MODEL_FAST: string | undefined;
  };
}

function setupFixture(): FrameworkFixture {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "orch-frameworks-"));
  const stateDir = path.join(tmpRoot, ".eliza");
  const homeDir = path.join(tmpRoot, "home");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.join(homeDir, ".codex"), { recursive: true });

  const previous = {
    ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
    ELIZA_NAMESPACE: process.env.ELIZA_NAMESPACE,
    ELIZA_CONFIG_PATH: process.env.ELIZA_CONFIG_PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    PARALLAX_LLM_PROVIDER: process.env.PARALLAX_LLM_PROVIDER,
    PARALLAX_DEFAULT_AGENT_TYPE: process.env.PARALLAX_DEFAULT_AGENT_TYPE,
    PARALLAX_CLAUDE_MODEL_POWERFUL: process.env.PARALLAX_CLAUDE_MODEL_POWERFUL,
    PARALLAX_CLAUDE_MODEL_FAST: process.env.PARALLAX_CLAUDE_MODEL_FAST,
    PARALLAX_CODEX_MODEL_POWERFUL: process.env.PARALLAX_CODEX_MODEL_POWERFUL,
    PARALLAX_CODEX_MODEL_FAST: process.env.PARALLAX_CODEX_MODEL_FAST,
    PARALLAX_GEMINI_MODEL_POWERFUL: process.env.PARALLAX_GEMINI_MODEL_POWERFUL,
    PARALLAX_GEMINI_MODEL_FAST: process.env.PARALLAX_GEMINI_MODEL_FAST,
    PARALLAX_AIDER_MODEL_POWERFUL: process.env.PARALLAX_AIDER_MODEL_POWERFUL,
    PARALLAX_AIDER_MODEL_FAST: process.env.PARALLAX_AIDER_MODEL_FAST,
  };

  process.env.ELIZA_STATE_DIR = stateDir;
  delete process.env.ELIZA_NAMESPACE;
  delete process.env.ELIZA_CONFIG_PATH;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  // Scrub API keys so authReady only flows through sub detection in these tests.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.PARALLAX_LLM_PROVIDER;
  delete process.env.PARALLAX_DEFAULT_AGENT_TYPE;
  delete process.env.PARALLAX_CLAUDE_MODEL_POWERFUL;
  delete process.env.PARALLAX_CLAUDE_MODEL_FAST;
  delete process.env.PARALLAX_CODEX_MODEL_POWERFUL;
  delete process.env.PARALLAX_CODEX_MODEL_FAST;
  delete process.env.PARALLAX_GEMINI_MODEL_POWERFUL;
  delete process.env.PARALLAX_GEMINI_MODEL_FAST;
  delete process.env.PARALLAX_AIDER_MODEL_POWERFUL;
  delete process.env.PARALLAX_AIDER_MODEL_FAST;

  // Plant a Codex subscription token so hasCodexSubscriptionAuth() returns true.
  writeFileSync(
    path.join(homeDir, ".codex", "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-codex-test-token" }),
    "utf8",
  );

  clearTaskAgentFrameworkStateCache();
  return { tmpRoot, previous };
}

function teardownFixture(fixture: FrameworkFixture): void {
  for (const [key, value] of Object.entries(fixture.previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  rmSync(fixture.tmpRoot, { recursive: true, force: true });
  clearTaskAgentFrameworkStateCache();
}

function writeElizaConfig(
  fixture: FrameworkFixture,
  config: Record<string, unknown>,
): void {
  writeFileSync(
    path.join(fixture.tmpRoot, ".eliza", "eliza.json"),
    JSON.stringify(config),
    "utf8",
  );
  clearTaskAgentFrameworkStateCache();
}

describe("task-agent model preferences", () => {
  let fixture: FrameworkFixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    teardownFixture(fixture);
  });

  it("uses central powerful defaults for Claude and Codex task agents", () => {
    writeElizaConfig(fixture, {});

    expect(getTaskAgentModelPrefs(createRuntime(), "claude")).toEqual({
      powerful: "claude-opus-4-7",
    });
    expect(getTaskAgentModelPrefs(createRuntime(), "codex")).toEqual({
      powerful: "gpt-5.5",
      fast: "gpt-5.5-mini",
    });
  });

  it("keeps runtime settings ahead of spawn metadata and central defaults", () => {
    const runtime = createRuntime({
      PARALLAX_CODEX_MODEL_POWERFUL: "gpt-user-power",
      PARALLAX_CODEX_MODEL_FAST: "gpt-user-fast",
    });

    expect(
      getTaskAgentModelPrefs(runtime, "codex", {
        powerful: "gpt-hardcoded-power",
        fast: "gpt-hardcoded-fast",
      }),
    ).toEqual({
      powerful: "gpt-user-power",
      fast: "gpt-user-fast",
    });
  });

  it("reads model overrides from the persisted config env section", () => {
    writeElizaConfig(fixture, {
      env: {
        PARALLAX_CODEX_MODEL_POWERFUL: "gpt-config-power",
      },
    });

    expect(getTaskAgentModelPrefs(createRuntime(), "codex")).toEqual({
      powerful: "gpt-config-power",
      fast: "gpt-5.5-mini",
    });
  });
});

describe("codexSubscriptionRestrictedToCodexFramework flag", () => {
  let fixture: FrameworkFixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  afterEach(() => {
    teardownFixture(fixture);
  });

  it("preserves today's behavior when the flag is unset (Codex sub counted for codex)", async () => {
    writeElizaConfig(fixture, {});
    const state = await getTaskAgentFrameworkState(createRuntime());
    const codex = state.frameworks.find((f) => f.id === "codex");
    expect(codex?.subscriptionReady).toBe(true);
  });

  it("preserves today's behavior when the flag is explicitly false", async () => {
    writeElizaConfig(fixture, {
      agents: {
        defaults: {
          orchestrator: { codexSubscriptionRestrictedToCodexFramework: false },
        },
      },
    });
    const state = await getTaskAgentFrameworkState(createRuntime());
    const codex = state.frameworks.find((f) => f.id === "codex");
    expect(codex?.subscriptionReady).toBe(true);
    expect(codex?.authReady).toBe(true);
  });

  it("still counts Codex sub toward codex framework when flag is true", async () => {
    writeElizaConfig(fixture, {
      agents: {
        defaults: {
          orchestrator: { codexSubscriptionRestrictedToCodexFramework: true },
        },
      },
    });
    const state = await getTaskAgentFrameworkState(createRuntime());
    const codex = state.frameworks.find((f) => f.id === "codex");
    expect(codex?.subscriptionReady).toBe(true);
    expect(codex?.authReady).toBe(true);
  });

  it("does not mark claude framework as subscriptionReady via Codex sub even without the flag", async () => {
    writeElizaConfig(fixture, {});
    const state = await getTaskAgentFrameworkState(createRuntime());
    const claude = state.frameworks.find((f) => f.id === "claude");
    // Regression guard: claude's subscriptionReady is independent of Codex sub.
    expect(claude?.subscriptionReady).toBe(false);
  });

  it("gates aider's authReady through Codex sub only when flag is unset", async () => {
    // Flip between flag=false and flag=true with the same Codex sub token in
    // place. If aider's authReady is different between runs, the gate works.
    // If it's identical (e.g. the developer has a real Claude sub in the
    // macOS keychain that satisfies claudeAuthReady regardless), skip — the
    // behavior under test is masked by an environment signal we can't clear.
    writeElizaConfig(fixture, {
      agents: {
        defaults: {
          orchestrator: { codexSubscriptionRestrictedToCodexFramework: false },
        },
      },
    });
    const unrestricted = await getTaskAgentFrameworkState(createRuntime());
    const aiderUnrestricted = unrestricted.frameworks.find(
      (f) => f.id === "aider",
    );
    // Without the flag, Codex sub alone should make aider auth-ready.
    expect(aiderUnrestricted?.authReady).toBe(true);

    writeElizaConfig(fixture, {
      agents: {
        defaults: {
          orchestrator: { codexSubscriptionRestrictedToCodexFramework: true },
        },
      },
    });
    const restricted = await getTaskAgentFrameworkState(createRuntime());
    const aiderRestricted = restricted.frameworks.find((f) => f.id === "aider");
    const claudeRestricted = restricted.frameworks.find(
      (f) => f.id === "claude",
    );

    // If the host provides a Claude sub via keychain/API key, aider stays
    // auth-ready through that path — the flag only removes the Codex route.
    if (claudeRestricted?.authReady) {
      expect(aiderRestricted?.authReady).toBe(true);
    } else {
      expect(aiderRestricted?.authReady).toBe(false);
    }
  });

  it("reads the flag from agents.defaults.orchestrator in eliza.json", () => {
    writeElizaConfig(fixture, {});
    expect(readConfigCodexSubscriptionRestrictedToCodexFramework()).toBe(false);

    writeElizaConfig(fixture, {
      agents: {
        defaults: {
          orchestrator: { codexSubscriptionRestrictedToCodexFramework: true },
        },
      },
    });
    expect(readConfigCodexSubscriptionRestrictedToCodexFramework()).toBe(true);

    writeElizaConfig(fixture, {
      agents: {
        defaults: {
          orchestrator: { codexSubscriptionRestrictedToCodexFramework: false },
        },
      },
    });
    expect(readConfigCodexSubscriptionRestrictedToCodexFramework()).toBe(false);

    // Non-boolean values don't accidentally coerce to true.
    writeElizaConfig(fixture, {
      agents: {
        defaults: {
          orchestrator: {
            codexSubscriptionRestrictedToCodexFramework: "true",
          },
        },
      },
    });
    expect(readConfigCodexSubscriptionRestrictedToCodexFramework()).toBe(false);
  });
});
