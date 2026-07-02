/**
 * Model-gateway mode for spawned coding sub-agents (#11536 E2).
 *
 * Env contract under test:
 * - ON (both ELIZA_MODEL_GATEWAY_URL + ELIZA_MODEL_GATEWAY_TOKEN non-empty):
 *   child env gets OPENAI_BASE_URL + ANTHROPIC_BASE_URL = gateway URL and the
 *   gateway token as OPENAI_API_KEY + ANTHROPIC_API_KEY; every raw provider
 *   credential buildEnv can carry (MODEL_GATEWAY_EXCLUDED_PROVIDER_KEYS) is
 *   actively excluded (deleted, not shadowed) — no raw provider key value
 *   survives anywhere in the spawned env.
 * - OFF (either var unset): the spawned env is byte-identical to pre-gateway
 *   behavior — raw keys forward as before, no *_BASE_URL is injected.
 * - The gateway token never appears in log output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AcpJsonRpcMessage,
  ApprovalPreset,
} from "../../src/services/types.js";

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
    __gatewayNativeMock?: NativeMockState;
  };
  g.__gatewayNativeMock ??= { instances: [] };
  return g.__gatewayNativeMock;
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
  applyModelGatewayEnv,
  MODEL_GATEWAY_EXCLUDED_PROVIDER_KEYS,
  resolveModelGatewayConfig,
} from "../../src/services/model-gateway.js";

const GATEWAY_URL = "https://gateway.test.invalid/v1";
const GATEWAY_TOKEN = "gw-lease-token-abc123";
const RAW_OPENAI_KEY = "sk-raw-openai-DO-NOT-LEAK";
const RAW_ANTHROPIC_KEY = "sk-ant-api-raw-DO-NOT-LEAK";
const RAW_CODEX_KEY = "sk-raw-codex-DO-NOT-LEAK";
const RAW_CEREBRAS_KEY = "csk-raw-cerebras-DO-NOT-LEAK";
const RAW_OPENCODE_KEY = "csk-raw-opencode-DO-NOT-LEAK";
const RAW_CLAUDE_OAUTH = "sk-ant-oat01-raw-oauth-DO-NOT-LEAK";

// Every env var the tests touch, saved/restored around each test. The bogus
// ELIZA_CONFIG_PATH makes readConfigEnvKey skip any real on-disk config so
// process.env is the sole config source (hermetic).
const MANAGED_ENV_KEYS = [
  "ELIZA_MODEL_GATEWAY_URL",
  "ELIZA_MODEL_GATEWAY_TOKEN",
  "ELIZA_CONFIG_PATH",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "CEREBRAS_API_KEY",
  "ELIZA_OPENCODE_API_KEY",
  "ELIZA_E2E_CEREBRAS_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
] as const;

let savedEnv: Record<string, string | undefined>;

type MockLogger = {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function runtime(settings: Record<string, string | undefined> = {}): {
  runtime: never;
  logger: MockLogger;
} {
  const values = { ELIZA_ACP_TRANSPORT: "native", ...settings };
  const logger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    runtime: {
      logger,
      getSetting: vi.fn((key: string) => values[key]),
      services: new Map<string, unknown[]>(),
    } as never,
    logger,
  };
}

function firstNativeClient(): MockNativeClient {
  const client = nativeClientMock.instances[0];
  if (!client) throw new Error("expected NativeAcpClient to be constructed");
  return client;
}

function allLoggedText(logger: MockLogger): string {
  const calls = [
    ...logger.debug.mock.calls,
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
  ];
  return JSON.stringify(calls);
}

async function spawnAndCaptureEnv(
  agentType: "claude" | "codex",
): Promise<{ env: NodeJS.ProcessEnv; logger: MockLogger }> {
  const { runtime: rt, logger } = runtime();
  const service = new AcpService(rt);
  await service.start();
  await service.spawnSession({
    name: `${agentType}-gw`,
    agentType,
    workdir: "/tmp/acp-test",
  });
  const env = firstNativeClient().opts.env ?? {};
  await service.stop();
  return { env, logger };
}

function setRawProviderKeys(): void {
  process.env.OPENAI_API_KEY = RAW_OPENAI_KEY;
  process.env.ANTHROPIC_API_KEY = RAW_ANTHROPIC_KEY;
  process.env.CODEX_API_KEY = RAW_CODEX_KEY;
  // Forwarded to children via the explicit allowlist:
  process.env.CEREBRAS_API_KEY = RAW_CEREBRAS_KEY;
  // Forwarded to children via the broad ELIZA_ prefix rule:
  process.env.ELIZA_OPENCODE_API_KEY = RAW_OPENCODE_KEY;
}

function expectNoRawKeyInDump(env: NodeJS.ProcessEnv): void {
  const dump = JSON.stringify(env);
  expect(dump).not.toContain(RAW_OPENAI_KEY);
  expect(dump).not.toContain(RAW_ANTHROPIC_KEY);
  expect(dump).not.toContain(RAW_CODEX_KEY);
  expect(dump).not.toContain(RAW_CEREBRAS_KEY);
  expect(dump).not.toContain(RAW_OPENCODE_KEY);
  expect(dump).not.toContain(RAW_CLAUDE_OAUTH);
}

function enableGateway(): void {
  process.env.ELIZA_MODEL_GATEWAY_URL = GATEWAY_URL;
  process.env.ELIZA_MODEL_GATEWAY_TOKEN = GATEWAY_TOKEN;
}

beforeEach(() => {
  nativeClientMock.instances.length = 0;
  savedEnv = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ELIZA_CONFIG_PATH = "/nonexistent/model-gateway-test/eliza.json";
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveModelGatewayConfig (mode gate)", () => {
  it("is ON only when both URL and TOKEN are set and non-empty", () => {
    enableGateway();
    expect(resolveModelGatewayConfig()).toEqual({
      url: GATEWAY_URL,
      token: GATEWAY_TOKEN,
    });
  });

  it("is OFF when neither var is set", () => {
    expect(resolveModelGatewayConfig()).toBeUndefined();
  });

  it("is OFF when only the URL is set", () => {
    process.env.ELIZA_MODEL_GATEWAY_URL = GATEWAY_URL;
    expect(resolveModelGatewayConfig()).toBeUndefined();
  });

  it("is OFF when only the TOKEN is set", () => {
    process.env.ELIZA_MODEL_GATEWAY_TOKEN = GATEWAY_TOKEN;
    expect(resolveModelGatewayConfig()).toBeUndefined();
  });

  it("is OFF when a var is whitespace-only", () => {
    process.env.ELIZA_MODEL_GATEWAY_URL = "   ";
    process.env.ELIZA_MODEL_GATEWAY_TOKEN = GATEWAY_TOKEN;
    expect(resolveModelGatewayConfig()).toBeUndefined();
  });
});

describe("applyModelGatewayEnv (pure env rewrite)", () => {
  it("deletes raw provider keys, then injects gateway base URLs + token", () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: RAW_OPENAI_KEY,
      ANTHROPIC_API_KEY: RAW_ANTHROPIC_KEY,
      CODEX_API_KEY: RAW_CODEX_KEY,
      CEREBRAS_API_KEY: RAW_CEREBRAS_KEY,
      ELIZA_OPENCODE_API_KEY: RAW_OPENCODE_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: RAW_CLAUDE_OAUTH,
      PATH: "/usr/bin",
    };
    applyModelGatewayEnv(env, { url: GATEWAY_URL, token: GATEWAY_TOKEN });
    expect(env.OPENAI_BASE_URL).toBe(GATEWAY_URL);
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY_URL);
    expect(env.OPENAI_API_KEY).toBe(GATEWAY_TOKEN);
    expect(env.ANTHROPIC_API_KEY).toBe(GATEWAY_TOKEN);
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(env.ELIZA_OPENCODE_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    // Actively excluded, not shadowed: no raw value survives anywhere.
    expectNoRawKeyInDump(env);
  });

  it("covers every provider credential buildEnv can carry (frozen contract)", () => {
    expect([...MODEL_GATEWAY_EXCLUDED_PROVIDER_KEYS]).toEqual([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CODEX_API_KEY",
      "CEREBRAS_API_KEY",
      "ELIZA_OPENCODE_API_KEY",
      "ELIZA_E2E_CEREBRAS_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });
});

describe("gateway mode ON — spawned sub-agent env", () => {
  it("claude spawn: gateway base URLs + token injected, raw keys excluded", async () => {
    setRawProviderKeys();
    enableGateway();
    const { env } = await spawnAndCaptureEnv("claude");

    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY_URL);
    expect(env.OPENAI_BASE_URL).toBe(GATEWAY_URL);
    expect(env.ANTHROPIC_API_KEY).toBe(GATEWAY_TOKEN);
    expect(env.OPENAI_API_KEY).toBe(GATEWAY_TOKEN);
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(env.ELIZA_OPENCODE_API_KEY).toBeUndefined();

    // Fail-closed: an env dump of the child contains no raw provider key.
    expectNoRawKeyInDump(env);
  });

  it("codex spawn: gateway base URLs + token injected, raw keys excluded", async () => {
    setRawProviderKeys();
    enableGateway();
    const { env } = await spawnAndCaptureEnv("codex");

    expect(env.OPENAI_BASE_URL).toBe(GATEWAY_URL);
    expect(env.OPENAI_API_KEY).toBe(GATEWAY_TOKEN);
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY_URL);
    expect(env.ANTHROPIC_API_KEY).toBe(GATEWAY_TOKEN);
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CEREBRAS_API_KEY).toBeUndefined();
    expect(env.ELIZA_OPENCODE_API_KEY).toBeUndefined();

    expectNoRawKeyInDump(env);
  });

  it("excludes raw keys even when a spawn caller re-injects them via customCredentials", async () => {
    setRawProviderKeys();
    enableGateway();
    const { runtime: rt } = runtime();
    const service = new AcpService(rt);
    await service.start();
    await service.spawnSession({
      name: "claude-gw-cc",
      agentType: "claude",
      workdir: "/tmp/acp-test",
      customCredentials: {
        OPENAI_API_KEY: RAW_OPENAI_KEY,
        ANTHROPIC_API_KEY: RAW_ANTHROPIC_KEY,
        // The same merge path multi-account selection uses for its envPatch
        // (a linked Claude subscription injects CLAUDE_CODE_OAUTH_TOKEN).
        CLAUDE_CODE_OAUTH_TOKEN: RAW_CLAUDE_OAUTH,
      },
    });
    const env = firstNativeClient().opts.env ?? {};
    await service.stop();

    expect(env.OPENAI_API_KEY).toBe(GATEWAY_TOKEN);
    expect(env.ANTHROPIC_API_KEY).toBe(GATEWAY_TOKEN);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expectNoRawKeyInDump(env);
  });

  it("logs a structured engagement line without the token", async () => {
    setRawProviderKeys();
    enableGateway();
    const { logger } = await spawnAndCaptureEnv("claude");

    const engaged = logger.info.mock.calls.find(([message]) =>
      String(message).includes("model-gateway mode engaged"),
    );
    expect(engaged).toBeDefined();
    expect(String(engaged?.[0])).toContain("[AcpService]");
    expect(engaged?.[1]).toMatchObject({
      gatewayUrl: GATEWAY_URL,
      agentType: "claude",
    });

    // The token must not appear in ANY log output at any level.
    expect(allLoggedText(logger)).not.toContain(GATEWAY_TOKEN);
  });
});

describe("gateway mode OFF — byte-identical legacy env", () => {
  // The env keys the gateway feature touches. Off-mode snapshots pin every
  // one of them to today's behavior so any accidental off-path drift fails.
  function snapshotRelevantKeys(env: NodeJS.ProcessEnv) {
    return {
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      CODEX_API_KEY: env.CODEX_API_KEY,
      CEREBRAS_API_KEY: env.CEREBRAS_API_KEY,
      ELIZA_OPENCODE_API_KEY: env.ELIZA_OPENCODE_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
      OPENAI_BASE_URL: env.OPENAI_BASE_URL,
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
      ELIZA_MODEL_GATEWAY_URL: env.ELIZA_MODEL_GATEWAY_URL,
      ELIZA_MODEL_GATEWAY_TOKEN: env.ELIZA_MODEL_GATEWAY_TOKEN,
    };
  }

  it("both vars unset: raw keys forward exactly as before, no base URLs injected", async () => {
    setRawProviderKeys();
    const { env, logger } = await spawnAndCaptureEnv("claude");

    expect(snapshotRelevantKeys(env)).toEqual({
      // Raw keys forward via the existing allowlist/prefix rules, untouched.
      OPENAI_API_KEY: RAW_OPENAI_KEY,
      ANTHROPIC_API_KEY: RAW_ANTHROPIC_KEY,
      CEREBRAS_API_KEY: RAW_CEREBRAS_KEY,
      ELIZA_OPENCODE_API_KEY: RAW_OPENCODE_KEY,
      // CODEX_API_KEY was never allowlisted for forwarding; stays absent.
      CODEX_API_KEY: undefined,
      // Only account selection injects the OAuth token, never host-env forwarding.
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      // No gateway wiring appears anywhere.
      OPENAI_BASE_URL: undefined,
      ANTHROPIC_BASE_URL: undefined,
      ELIZA_MODEL_GATEWAY_URL: undefined,
      ELIZA_MODEL_GATEWAY_TOKEN: undefined,
    });
    const dump = JSON.stringify(env);
    expect(dump).not.toContain(GATEWAY_URL);
    expect(dump).not.toContain(GATEWAY_TOKEN);
    expect(allLoggedText(logger)).not.toContain("model-gateway mode engaged");
  });

  it("both vars unset: customCredentials (account-selection path) pass through raw", async () => {
    const { runtime: rt } = runtime();
    const service = new AcpService(rt);
    await service.start();
    await service.spawnSession({
      name: "claude-off-cc",
      agentType: "claude",
      workdir: "/tmp/acp-test",
      customCredentials: { CLAUDE_CODE_OAUTH_TOKEN: RAW_CLAUDE_OAUTH },
    });
    const env = firstNativeClient().opts.env ?? {};
    await service.stop();

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(RAW_CLAUDE_OAUTH);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("only ELIZA_MODEL_GATEWAY_URL set: mode stays off", async () => {
    setRawProviderKeys();
    process.env.ELIZA_MODEL_GATEWAY_URL = GATEWAY_URL;
    const { env, logger } = await spawnAndCaptureEnv("claude");

    expect(env.OPENAI_API_KEY).toBe(RAW_OPENAI_KEY);
    expect(env.ANTHROPIC_API_KEY).toBe(RAW_ANTHROPIC_KEY);
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(allLoggedText(logger)).not.toContain("model-gateway mode engaged");
  });

  it("only ELIZA_MODEL_GATEWAY_TOKEN set: mode stays off", async () => {
    setRawProviderKeys();
    process.env.ELIZA_MODEL_GATEWAY_TOKEN = GATEWAY_TOKEN;
    const { env, logger } = await spawnAndCaptureEnv("claude");

    expect(env.OPENAI_API_KEY).toBe(RAW_OPENAI_KEY);
    expect(env.ANTHROPIC_API_KEY).toBe(RAW_ANTHROPIC_KEY);
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(allLoggedText(logger)).not.toContain(GATEWAY_TOKEN);
    expect(allLoggedText(logger)).not.toContain("model-gateway mode engaged");
  });
});
