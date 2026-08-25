/**
 * Gap (J): sub-agent model + auth selection is dispersed across `buildEnv`
 * (private, in acp-service.ts) and `buildOpencodeAcpEnv` / `buildOpencodeSpawnConfig`
 * (opencode-config.ts) and was never contract-tested as a single resolved tuple.
 *
 * For a spawn, the runtime must resolve, deterministically, the tuple of:
 *   (provider, model, auth/env keys INJECTED, keys DROPPED)
 * from `agentType` + the available account/credential inputs. That decision is
 * load-bearing for billing + auth correctness: a regression that, say, forwards
 * a parent `OPENAI_API_KEY` into a Codex *subscription* spawn silently bills the
 * wrong account and breaks ChatGPT-account auth; one that keeps an OAuth token in
 * `ANTHROPIC_API_KEY` makes a Claude sub-agent fail "Invalid API key".
 *
 * This file is a CONTRACT/snapshot guard over that resolved tuple, exercised two
 * ways so it covers the actual production code paths (no reimplementation):
 *
 *  1. The OPENCODE provider/model matrix via the EXPORTED pure functions
 *     `buildOpencodeAcpEnv` / `buildOpencodeSpawnConfig` across auth modes
 *     (api-key · cloud · cerebras · local · user-config · none).
 *
 *  2. The Claude / Codex / opencode / elizaos / pi-agent CREDENTIAL-DROP +
 *     INJECTION matrix through the smallest exported seam that reaches the
 *     private `buildEnv`: a real `AcpService.spawnSession` whose native transport
 *     is mocked, capturing the exact env handed to the subprocess (the same seam
 *     `multi-account-spawn.test.ts` uses). Auth mode is driven by the pooled
 *     account bridge (oauth subscription vs api-key) and by parent `process.env`.
 *
 * Assertions snapshot the resolved tuple per (agentType × authMode) so any change
 * to which model/auth a backend resolves to fails loudly.
 */

import { CODING_AGENT_SELECTOR_BRIDGE_SYMBOL } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcpJsonRpcMessage,
  ApprovalPreset,
} from "../../src/services/types.js";

// ---------------------------------------------------------------------------
// Native transport mock — capture the env handed to the spawned subprocess.
// (Mirrors multi-account-spawn.test.ts so we drive the REAL buildEnv path.)
// ---------------------------------------------------------------------------

type NativeEventHandler = (
  event: AcpJsonRpcMessage,
  sessionId?: string,
) => void;
type NativeOptions = {
  command: string;
  cwd: string;
  approvalPreset: ApprovalPreset;
  timeoutMs?: number;
  terminal?: boolean;
  env?: NodeJS.ProcessEnv;
  onEvent?: NativeEventHandler;
  onStderr?: (chunk: string) => void;
};
type MockNativeClient = {
  opts: NativeOptions;
  eventHandler?: NativeEventHandler;
  start: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setEventHandler: (handler: NativeEventHandler | undefined) => void;
  setTimeoutMs: (timeoutMs: number | undefined) => void;
};
type NativeMockState = {
  NativeAcpClient?: new (opts: NativeOptions) => MockNativeClient;
  instances: MockNativeClient[];
};

function getNativeMockState(): NativeMockState {
  const g = globalThis as typeof globalThis & {
    __modelChooserNativeMock?: NativeMockState;
  };
  g.__modelChooserNativeMock ??= { instances: [] };
  return g.__modelChooserNativeMock;
}

const nativeClientMock = getNativeMockState();

vi.mock("../../src/services/acp-native-transport.js", () => {
  const state = getNativeMockState();
  state.NativeAcpClient = class MockNativeAcpClient
    implements MockNativeClient
  {
    opts: NativeOptions;
    eventHandler?: NativeEventHandler;
    start = vi.fn(async () => undefined);
    createSession = vi.fn(async () => ({
      sessionId: "protocol-session",
      agentSessionId: "agent-session",
    }));
    prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
    cancel = vi.fn(async () => undefined);
    closeSession = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    constructor(opts: NativeOptions) {
      this.opts = opts;
      this.eventHandler = opts.onEvent;
      getNativeMockState().instances.push(this);
    }
    setEventHandler(handler: NativeEventHandler | undefined) {
      this.eventHandler = handler;
      this.opts.onEvent = handler;
    }
    setTimeoutMs(timeoutMs: number | undefined) {
      this.opts.timeoutMs = timeoutMs;
    }
  };
  return { NativeAcpClient: state.NativeAcpClient };
});

// Baseline git capture uses execFile; make it a no-op so spawns don't hang.
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const callback = typeof _opts === "function" ? _opts : cb;
      if (typeof callback === "function") {
        callback(new Error("git unavailable in test"), "", "");
      }
    },
  ),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
  spawn: vi.fn(),
}));

import { AcpService } from "../../src/services/acp-service.js";
import {
  buildOpencodeAcpEnv,
  buildOpencodeSpawnConfig,
} from "../../src/services/opencode-config.js";

// ---------------------------------------------------------------------------
// Pooled-account bridge helpers (drives oauth/api-key auth mode on spawn).
// ---------------------------------------------------------------------------

const BRIDGE_SYMBOL = CODING_AGENT_SELECTOR_BRIDGE_SYMBOL;

interface FakeSelection {
  providerId: string;
  accountId: string;
  label: string;
  source: "oauth" | "api-key";
  strategy: string;
  envPatch: Record<string, string>;
}

function installBridge(byAgent: Record<string, FakeSelection | null>): void {
  (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
    describe: () => ({}),
    select: vi.fn(async (agentType: string) => byAgent[agentType] ?? null),
    markRateLimited: vi.fn(async () => undefined),
    markNeedsReauth: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
  };
}

function clearBridge(): void {
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
}

function runtime(settings: Record<string, string | undefined> = {}) {
  const values = {
    ELIZA_ACP_TRANSPORT: "native",
    // NativeAcpClient is mocked in this contract suite; command provisioning is
    // outside its scope and must not depend on workspace build artifacts.
    ELIZA_ELIZAOS_ACP_COMMAND: "test-eliza-code-acp",
    ...settings,
  };
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn((key: string) => values[key]),
    services: new Map<string, unknown[]>(),
  } as never;
}

function lastNativeEnv(): NodeJS.ProcessEnv {
  const client = nativeClientMock.instances.at(-1);
  if (!client) throw new Error("expected NativeAcpClient to be constructed");
  return client.opts.env ?? {};
}

// The auth keys we care about for the resolved-tuple snapshot. Everything else
// (PATH, ELIZA_*, opencode autoupdate flags) is noise for the model/auth contract.
const AUTH_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "CODEX_HOME",
  "CEREBRAS_API_KEY",
  "OPENCODE_MODEL",
] as const;

/** Project a captured env down to (injected auth keys present, of-interest keys absent). */
function authProjection(env: NodeJS.ProcessEnv): {
  injected: Record<string, string>;
  dropped: string[];
} {
  const injected: Record<string, string> = {};
  const dropped: string[] = [];
  for (const key of AUTH_KEYS) {
    const value = env[key];
    if (typeof value === "string") injected[key] = value;
    else dropped.push(key);
  }
  return { injected, dropped: dropped.sort() };
}

// Snapshot in a stable, casing-insensitive order.
function stableKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

/** Set process.env keys for the duration of a callback, restoring after. */
async function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) prev[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => {
  nativeClientMock.instances.length = 0;
  clearBridge();
});
afterEach(() => {
  clearBridge();
});

// ===========================================================================
// 1. OPENCODE provider/model/auth contract — pure exported resolver.
// ===========================================================================

describe("model-chooser contract: opencode provider/model resolution (pure)", () => {
  // Each case asserts the FULL resolved tuple (provider, model, smallModel) for
  // a given auth mode. Regression guard on which backend opencode targets.
  const settingsRuntime = (settings: Record<string, string | undefined> = {}) =>
    ({ getSetting: vi.fn((key: string) => settings[key]) }) as never;

  it("cerebras (api-key) → cerebras provider + Gemma default", () => {
    const config = buildOpencodeSpawnConfig(settingsRuntime(), {
      // sealed synthetic env (env !== process.env disables config-file fallback)
      CEREBRAS_API_KEY: "csk-pooled",
    });
    expect(config).not.toBeNull();
    expect({
      provider: config?.providerId,
      label: config?.providerLabel,
      model: config?.model,
      smallModel: config?.smallModel,
    }).toEqual({
      provider: "cerebras",
      label: "Cerebras",
      model: "cerebras/gemma-4-31b",
      smallModel: undefined,
    });
    const parsed = JSON.parse(config?.configContent ?? "{}");
    expect(parsed.provider.cerebras.npm).toBe("@ai-sdk/cerebras");
    expect(parsed.provider.cerebras.options.baseURL).toBe(
      "https://api.cerebras.ai/v1",
    );
    expect(parsed.provider.cerebras.options.apiKey).toBe("csk-pooled");
  });

  it("local (opt-in) → eliza-local OpenAI-compatible provider, no key leaked", () => {
    const config = buildOpencodeSpawnConfig(settingsRuntime(), {
      ELIZA_OPENCODE_LOCAL: "1",
      ELIZA_OPENCODE_BASE_URL: "http://localhost:11434/v1",
      ELIZA_OPENCODE_MODEL_POWERFUL: "eliza-1-4b",
    });
    expect({
      provider: config?.providerId,
      model: config?.model,
    }).toEqual({ provider: "eliza-local", model: "eliza-local/eliza-1-4b" });
    const parsed = JSON.parse(config?.configContent ?? "{}");
    expect(parsed.provider["eliza-local"].npm).toBe(
      "@ai-sdk/openai-compatible",
    );
    expect(parsed.provider["eliza-local"].options.baseURL).toBe(
      "http://localhost:11434/v1",
    );
    // No api key configured → none placed in options (no accidental key leak).
    expect(parsed.provider["eliza-local"].options.apiKey).toBeUndefined();
  });

  it("user-config (subscription default) → bare model passthrough, provider 'user'", () => {
    const config = buildOpencodeSpawnConfig(settingsRuntime(), {
      ELIZA_OPENCODE_MODEL_POWERFUL: "anthropic/claude-sonnet-4-5",
      ELIZA_OPENCODE_MODEL_FAST: "openai/gpt-4.1-mini",
    });
    expect({
      provider: config?.providerId,
      model: config?.model,
      smallModel: config?.smallModel,
    }).toEqual({
      provider: "user",
      model: "anthropic/claude-sonnet-4-5",
      smallModel: "openai/gpt-4.1-mini",
    });
  });

  it("vault:// api key is NOT used as a provider key (no unresolved-pointer leak)", () => {
    const config = buildOpencodeSpawnConfig(settingsRuntime(), {
      ELIZA_OPENCODE_BASE_URL: "https://api.cerebras.ai/v1",
      ELIZA_OPENCODE_API_KEY: "vault://ELIZA_OPENCODE_API_KEY",
      CEREBRAS_API_KEY: "csk-real",
      ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
    });
    expect(config?.providerId).toBe("cerebras");
    const parsed = JSON.parse(config?.configContent ?? "{}");
    expect(parsed.provider.cerebras.options.apiKey).toBe("csk-real");
    expect(JSON.stringify(parsed)).not.toContain("vault://");
  });

  it("no provider + no model → null (single-account fallback, nothing forced)", () => {
    expect(buildOpencodeSpawnConfig(settingsRuntime(), {})).toBeNull();
  });

  it("an overrideModel wins over the configured powerful model", () => {
    const config = buildOpencodeSpawnConfig(
      settingsRuntime(),
      { CEREBRAS_API_KEY: "csk-pooled" },
      "llama-3.3-70b",
    );
    expect(config?.model).toBe("cerebras/llama-3.3-70b");
  });
});

describe("model-chooser contract: buildOpencodeAcpEnv stamps resolved model into env", () => {
  const settingsRuntime = (settings: Record<string, string | undefined> = {}) =>
    ({ getSetting: vi.fn((key: string) => settings[key]) }) as never;

  it("injects OPENCODE_CONFIG_CONTENT + OPENCODE_MODEL for a resolved cerebras spawn", () => {
    const result = buildOpencodeAcpEnv(settingsRuntime(), {
      CEREBRAS_API_KEY: "csk-pooled",
    });
    expect(result.config?.providerId).toBe("cerebras");
    expect(result.env.OPENCODE_MODEL).toBe("cerebras/gemma-4-31b");
    expect(result.env.OPENCODE_CONFIG_CONTENT).toBe(
      result.config?.configContent,
    );
    // Spawn hardening flags are always present.
    expect(result.env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(result.env.OPENCODE_DISABLE_TERMINAL_TITLE).toBe("1");
  });

  it("ignores pre-supplied OPENCODE_CONFIG_CONTENT and regenerates from resolved auth", () => {
    const result = buildOpencodeAcpEnv(settingsRuntime(), {
      OPENCODE_CONFIG_CONTENT: '{"model":"preset/model"}',
      CEREBRAS_API_KEY: "csk-pooled",
    });
    expect(result.config?.providerId).toBe("cerebras");
    expect(result.env.OPENCODE_MODEL).toBe("cerebras/gemma-4-31b");
    expect(result.env.OPENCODE_CONFIG_CONTENT).toBe(
      result.config?.configContent,
    );
  });
});

// ===========================================================================
// 2. Claude/Codex/opencode/elizaos/pi-agent credential-drop + injection
//    matrix through the real spawnSession -> private buildEnv seam.
// ===========================================================================

/**
 * Spawn the given agent type under a given account/env setup and return the
 * resolved auth projection captured from the subprocess env. This is the actual
 * production buildEnv output — including the per-agent-type credential drops.
 */
async function resolveSpawnAuth(input: {
  agentType: string;
  selection?: FakeSelection | null;
  parentEnv?: Record<string, string | undefined>;
}): Promise<{ injected: Record<string, string>; dropped: string[] }> {
  if (input.selection !== undefined) {
    installBridge({ [input.agentType]: input.selection });
  }
  let projection!: { injected: Record<string, string>; dropped: string[] };
  const hermeticEnv = Object.fromEntries(
    AUTH_KEYS.map((key) => [key, input.parentEnv?.[key]]),
  ) as Record<string, string | undefined>;
  await withEnv(hermeticEnv, async () => {
    const service = new AcpService(runtime());
    await service.start();
    try {
      await service.spawnSession({
        name: `${input.agentType}-contract`,
        agentType: input.agentType as never,
        workdir: "/tmp/acp-model-chooser-test",
      });
      projection = authProjection(lastNativeEnv());
    } finally {
      await service.stop();
    }
  });
  return projection;
}

describe("model-chooser contract: claude auth resolution", () => {
  it("subscription (oauth) — injects CLAUDE_CODE_OAUTH_TOKEN, DROPS forwarded ANTHROPIC_API_KEY", async () => {
    const { injected, dropped } = await resolveSpawnAuth({
      agentType: "claude",
      selection: {
        providerId: "anthropic-subscription",
        accountId: "acc-work",
        label: "Work",
        source: "oauth",
        strategy: "least-used",
        envPatch: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-WORK" },
      },
      // A parent api key that MUST be dropped so the OAuth token authenticates.
      parentEnv: { ANTHROPIC_API_KEY: "sk-ant-api-parent-should-drop" },
    });
    expect(injected.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-WORK");
    expect(stableKeys(injected)).not.toContain("ANTHROPIC_API_KEY");
    expect(dropped).toContain("ANTHROPIC_API_KEY");
  });

  it("api-key (no pool) — keeps a real sk-ant-api… ANTHROPIC_API_KEY, no OAuth token", async () => {
    const { injected, dropped } = await resolveSpawnAuth({
      agentType: "claude",
      selection: null, // no pooled account → single-account fallback
      parentEnv: { ANTHROPIC_API_KEY: "sk-ant-api-real-key" },
    });
    expect(injected.ANTHROPIC_API_KEY).toBe("sk-ant-api-real-key");
    expect(dropped).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("misfiled OAuth token in ANTHROPIC_API_KEY (sk-ant-oat…) is STRIPPED even without a pool", async () => {
    // claude-agent-acp would try api-key auth with an OAuth token and fail
    // "Invalid API key" — buildEnv strips it so the agent uses native OAuth.
    const { injected, dropped } = await resolveSpawnAuth({
      agentType: "claude",
      selection: null,
      parentEnv: { ANTHROPIC_API_KEY: "sk-ant-oat-misfiled" },
    });
    expect(stableKeys(injected)).not.toContain("ANTHROPIC_API_KEY");
    expect(dropped).toContain("ANTHROPIC_API_KEY");
  });
});

describe("model-chooser contract: codex auth resolution", () => {
  it("subscription (per-account CODEX_HOME) — injects CODEX_HOME, DROPS OPENAI_API_KEY + OPENAI_MODEL", async () => {
    const { injected, dropped } = await resolveSpawnAuth({
      agentType: "codex",
      selection: {
        providerId: "openai-codex",
        accountId: "acc-personal",
        label: "Personal",
        source: "oauth",
        strategy: "least-used",
        // The `_codex-home` marker is what buildEnv keys off of.
        envPatch: { CODEX_HOME: "/tmp/auth/_codex-home/acc-personal" },
      },
      parentEnv: {
        OPENAI_API_KEY: "sk-openai-parent-should-drop",
        OPENAI_MODEL: "gpt-5.3-codex", // API-tier model rejected under ChatGPT auth
      },
    });
    expect(injected.CODEX_HOME).toBe("/tmp/auth/_codex-home/acc-personal");
    // Both must be dropped: the api key overrides the per-account login, the
    // API-tier model is rejected under ChatGPT-account auth.
    expect(dropped).toContain("OPENAI_API_KEY");
    expect(dropped).toContain("OPENAI_MODEL");
  });

  it("api-key (no pool) — keeps forwarded OPENAI_API_KEY, no CODEX_HOME injected", async () => {
    const { injected, dropped } = await resolveSpawnAuth({
      agentType: "codex",
      selection: null,
      parentEnv: { OPENAI_API_KEY: "sk-openai-real-key" },
    });
    expect(injected.OPENAI_API_KEY).toBe("sk-openai-real-key");
    expect(dropped).toContain("CODEX_HOME");
  });

  it("a non-per-account CODEX_HOME (no _codex-home marker) does NOT trigger the OPENAI_API_KEY drop", async () => {
    const { injected } = await resolveSpawnAuth({
      agentType: "codex",
      selection: null,
      parentEnv: {
        OPENAI_API_KEY: "sk-openai-real-key",
        // shouldForwardEnv allowlists CODEX_HOME, but without the marker the
        // subscription-drop branch must not fire.
        CODEX_HOME: "/home/user/.codex",
      },
    });
    expect(injected.OPENAI_API_KEY).toBe("sk-openai-real-key");
    expect(injected.CODEX_HOME).toBe("/home/user/.codex");
  });
});

describe("model-chooser contract: opencode auth resolution", () => {
  it("cerebras pooled (api-key) — injects CEREBRAS_API_KEY and resolves OPENCODE_MODEL=cerebras/…", async () => {
    const { injected } = await resolveSpawnAuth({
      agentType: "opencode",
      selection: {
        providerId: "cerebras-api",
        accountId: "cb-1",
        label: "Cerebras 1",
        source: "api-key",
        strategy: "least-used",
        envPatch: { CEREBRAS_API_KEY: "cb-key-pooled" },
      },
    });
    expect(injected.CEREBRAS_API_KEY).toBe("cb-key-pooled");
    // The opencode env builder resolves the cerebras provider/model from the key.
    expect(injected.OPENCODE_MODEL).toBe("cerebras/gemma-4-31b");
  });
});

describe("model-chooser contract: elizaos + pi-agent are single-auth (bridge NOT consulted)", () => {
  // These authenticate through their own backend, so the pool/credential-drop
  // machinery must be inert — no injected coding-account secrets, no drops based
  // on agent-type branches that only apply to claude/codex/opencode.
  for (const agentType of ["elizaos", "pi-agent"] as const) {
    it(`${agentType} — no pooled account selected, parent api keys pass through unmodified`, async () => {
      // Even if a bridge is installed for OTHER agent types, an elizaos/pi-agent
      // spawn must not pull a coding-account credential.
      installBridge({
        claude: {
          providerId: "anthropic-subscription",
          accountId: "acc-work",
          label: "Work",
          source: "oauth",
          strategy: "least-used",
          envPatch: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-WORK" },
        },
      });
      const { injected, dropped } = await resolveSpawnAuth({
        agentType,
        selection: undefined, // keep the bridge installed above as-is
        parentEnv: {
          ANTHROPIC_API_KEY: "sk-ant-api-real-key",
          OPENAI_API_KEY: "sk-openai-real-key",
        },
      });
      // No coding-account injection happened for this agent type.
      expect(stableKeys(injected)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(stableKeys(injected)).not.toContain("CODEX_HOME");
      // Parent keys are forwarded untouched (no agent-type drop branch applies).
      expect(injected.ANTHROPIC_API_KEY).toBe("sk-ant-api-real-key");
      expect(injected.OPENAI_API_KEY).toBe("sk-openai-real-key");
      expect(dropped).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(dropped).toContain("CODEX_HOME");
    });
  }
});

// ===========================================================================
// 3. The full resolved-tuple SNAPSHOT MATRIX — the regression guard.
//    One frozen object capturing (provider/model-or-authKeys, dropped) per
//    (agentType × authMode). Any drift in resolution fails this.
// ===========================================================================

describe("model-chooser contract: resolved-tuple snapshot matrix", () => {
  it("matches the frozen (agentType × authMode) → resolved-auth map", async () => {
    const matrix: Record<
      string,
      {
        injectedKeys: string[];
        injected: Record<string, string>;
        dropped: string[];
      }
    > = {};

    const record = async (
      label: string,
      input: Parameters<typeof resolveSpawnAuth>[0],
    ) => {
      // Reset captured instances + bridge between matrix rows for isolation.
      nativeClientMock.instances.length = 0;
      clearBridge();
      const { injected, dropped } = await resolveSpawnAuth(input);
      matrix[label] = {
        injectedKeys: stableKeys(injected),
        injected,
        dropped,
      };
    };

    await record("claude/subscription", {
      agentType: "claude",
      selection: {
        providerId: "anthropic-subscription",
        accountId: "a",
        label: "a",
        source: "oauth",
        strategy: "least-used",
        envPatch: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-A" },
      },
      parentEnv: { ANTHROPIC_API_KEY: "sk-ant-api-drop" },
    });
    await record("claude/api-key", {
      agentType: "claude",
      selection: null,
      parentEnv: { ANTHROPIC_API_KEY: "sk-ant-api-keep" },
    });
    await record("codex/subscription", {
      agentType: "codex",
      selection: {
        providerId: "openai-codex",
        accountId: "p",
        label: "p",
        source: "oauth",
        strategy: "least-used",
        envPatch: { CODEX_HOME: "/x/_codex-home/p" },
      },
      parentEnv: { OPENAI_API_KEY: "sk-drop", OPENAI_MODEL: "gpt-5.3-codex" },
    });
    await record("codex/api-key", {
      agentType: "codex",
      selection: null,
      parentEnv: { OPENAI_API_KEY: "sk-keep" },
    });
    await record("opencode/cerebras", {
      agentType: "opencode",
      selection: {
        providerId: "cerebras-api",
        accountId: "cb",
        label: "cb",
        source: "api-key",
        strategy: "least-used",
        envPatch: { CEREBRAS_API_KEY: "cb-key" },
      },
    });
    await record("elizaos/native", {
      agentType: "elizaos",
      selection: null,
      parentEnv: { ANTHROPIC_API_KEY: "sk-ant-api-keep" },
    });

    // Frozen contract: the SET of injected auth keys + dropped auth keys per row.
    // (Token VALUES are asserted individually above; here we snapshot WHICH keys
    // resolve, which is the dispersed decision this gap leaves untested.)
    expect({
      "claude/subscription": matrix["claude/subscription"]?.injectedKeys,
      "claude/api-key": matrix["claude/api-key"]?.injectedKeys,
      "codex/subscription": matrix["codex/subscription"]?.injectedKeys,
      "codex/api-key": matrix["codex/api-key"]?.injectedKeys,
      "opencode/cerebras": matrix["opencode/cerebras"]?.injectedKeys,
      "elizaos/native": matrix["elizaos/native"]?.injectedKeys,
    }).toEqual({
      "claude/subscription": ["CLAUDE_CODE_OAUTH_TOKEN"],
      "claude/api-key": ["ANTHROPIC_API_KEY"],
      "codex/subscription": ["CODEX_HOME"],
      "codex/api-key": ["OPENAI_API_KEY"],
      "opencode/cerebras": ["CEREBRAS_API_KEY", "OPENCODE_MODEL"],
      "elizaos/native": ["ANTHROPIC_API_KEY"],
    });

    // And the keys each row guarantees are NOT forwarded (the auth-safety half).
    expect(matrix["claude/subscription"]?.dropped).toContain(
      "ANTHROPIC_API_KEY",
    );
    expect(matrix["codex/subscription"]?.dropped).toEqual(
      expect.arrayContaining(["OPENAI_API_KEY", "OPENAI_MODEL"]),
    );
    // The cross-leak guard: a Cerebras opencode spawn never carries Anthropic/OpenAI keys.
    expect(matrix["opencode/cerebras"]?.dropped).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]),
    );
  });
});
