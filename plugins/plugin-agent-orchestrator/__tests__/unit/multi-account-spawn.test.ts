/**
 * Keystone test: the coding-account selector bridge is consulted on spawn and
 * its env patch is injected into the sub-agent subprocess (per agent type),
 * with single-account fallback when the bridge is absent.
 */

import { CODING_AGENT_SELECTOR_BRIDGE_SYMBOL } from "@elizaos/core";
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
    __acpServiceNativeMock?: NativeMockState;
  };
  g.__acpServiceNativeMock ??= { instances: [] };
  return g.__acpServiceNativeMock;
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

const BRIDGE_SYMBOL = CODING_AGENT_SELECTOR_BRIDGE_SYMBOL;

interface FakeSelection {
  providerId: string;
  accountId: string;
  label: string;
  source: "oauth" | "api-key";
  strategy: string;
  envPatch: Record<string, string>;
}

function installBridge(byAgent: Record<string, FakeSelection | null>) {
  const selectMock = vi.fn(
    async (agentType: string) => byAgent[agentType] ?? null,
  );
  (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
    describe: () => ({}),
    select: selectMock,
    markRateLimited: vi.fn(async () => undefined),
    markNeedsReauth: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
  };
  return selectMock;
}

function clearBridge() {
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
}

function runtime(settings: Record<string, string | undefined> = {}) {
  const values = { ELIZA_ACP_TRANSPORT: "native", ...settings };
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn((key: string) => values[key]),
    services: new Map<string, unknown[]>(),
  } as never;
}

function firstNativeClient(): MockNativeClient {
  const client = nativeClientMock.instances[0];
  if (!client) throw new Error("expected NativeAcpClient to be constructed");
  return client;
}

beforeEach(() => {
  nativeClientMock.instances.length = 0;
  clearBridge();
});
afterEach(() => {
  clearBridge();
});

describe("multi-account coding-agent spawn", () => {
  it("injects the selected Claude subscription token and drops ANTHROPIC_API_KEY", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-should-be-dropped";
    const select = installBridge({
      claude: {
        providerId: "anthropic-subscription",
        accountId: "acc-work",
        label: "Work",
        source: "oauth",
        strategy: "least-used",
        envPatch: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-WORK" },
      },
    });
    try {
      const service = new AcpService(runtime());
      await service.start();
      const result = await service.spawnSession({
        name: "claude-mt",
        agentType: "claude",
        workdir: "/tmp/acp-test",
      });

      const env = firstNativeClient().opts.env ?? {};
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-WORK");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(select).toHaveBeenCalledWith(
        "claude",
        expect.objectContaining({ sessionKey: result.sessionId }),
      );
      const account = (result.metadata as Record<string, unknown>)?.account as
        | Record<string, unknown>
        | undefined;
      expect(account?.providerId).toBe("anthropic-subscription");
      expect(account?.accountId).toBe("acc-work");
      // Secrets are never persisted onto the session metadata.
      expect(JSON.stringify(account)).not.toContain("sk-ant-oat-WORK");
      await service.stop();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("injects a per-account CODEX_HOME for Codex and drops forwarded OPENAI_API_KEY + OPENAI_MODEL", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    const prevModel = process.env.OPENAI_MODEL;
    process.env.OPENAI_API_KEY = "sk-openai-should-be-dropped";
    // An API-tier model that Codex rejects under ChatGPT-account auth.
    process.env.OPENAI_MODEL = "gpt-5.3-codex";
    // Path carries the per-account `_codex-home` marker buildEnv keys off of.
    installBridge({
      codex: {
        providerId: "openai-codex",
        accountId: "acc-personal",
        label: "Personal",
        source: "oauth",
        strategy: "least-used",
        envPatch: { CODEX_HOME: "/tmp/auth/_codex-home/acc-personal" },
      },
    });
    try {
      const service = new AcpService(runtime());
      await service.start();
      const result = await service.spawnSession({
        name: "codex-mt",
        agentType: "codex",
        workdir: "/tmp/acp-test",
      });
      const env = firstNativeClient().opts.env ?? {};
      expect(env.CODEX_HOME).toBe("/tmp/auth/_codex-home/acc-personal");
      // A forwarded api key would override the per-account ChatGPT auth.json;
      // an API-tier model is rejected by Codex under ChatGPT-account auth.
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENAI_MODEL).toBeUndefined();
      const account = (result.metadata as Record<string, unknown>)?.account as
        | Record<string, unknown>
        | undefined;
      expect(account?.providerId).toBe("openai-codex");
      await service.stop();
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      if (prevModel === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = prevModel;
    }
  });

  it("injects the pooled CEREBRAS_API_KEY for an opencode spawn", async () => {
    // opencode pool-rotates across cerebras-api accounts; the bridge injects
    // CEREBRAS_API_KEY which buildOpencodeSpawnConfig reads to target Cerebras.
    const select = installBridge({
      opencode: {
        providerId: "cerebras-api",
        accountId: "cb-1",
        label: "Cerebras 1",
        source: "api-key",
        strategy: "least-used",
        envPatch: { CEREBRAS_API_KEY: "cb-key-pooled" },
      },
    });
    const service = new AcpService(runtime());
    await service.start();
    const result = await service.spawnSession({
      name: "opencode-mt",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    const env = firstNativeClient().opts.env ?? {};
    expect(env.CEREBRAS_API_KEY).toBe("cb-key-pooled");
    expect(select).toHaveBeenCalledWith(
      "opencode",
      expect.objectContaining({ sessionKey: result.sessionId }),
    );
    const account = (result.metadata as Record<string, unknown>)?.account as
      | Record<string, unknown>
      | undefined;
    expect(account?.providerId).toBe("cerebras-api");
    expect(account?.accountId).toBe("cb-1");
    expect(JSON.stringify(account)).not.toContain("cb-key-pooled");
    await service.stop();
  });

  it("falls back to single-account behavior when no bridge is installed", async () => {
    const service = new AcpService(runtime());
    await service.start();
    const result = await service.spawnSession({
      name: "claude-noacct",
      agentType: "claude",
      workdir: "/tmp/acp-test",
    });
    const env = firstNativeClient().opts.env ?? {};
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(
      (result.metadata as Record<string, unknown>)?.account,
    ).toBeUndefined();
    await service.stop();
  });

  it("does not consult the bridge for non-multi-account agent types", async () => {
    const select = installBridge({
      claude: {
        providerId: "anthropic-subscription",
        accountId: "acc-work",
        label: "Work",
        source: "oauth",
        strategy: "least-used",
        envPatch: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-WORK" },
      },
    });
    const service = new AcpService(runtime());
    await service.start();
    await service.spawnSession({
      name: "elizaos-mt",
      agentType: "elizaos",
      workdir: "/tmp/acp-test",
    });
    expect(select).not.toHaveBeenCalled();
    await service.stop();
  });

  it("rotates consecutive spawns across distinct accounts (least-used)", async () => {
    // A rotating bridge that hands out a different account per call — the shape
    // the real pool produces under least-used burst-spread. Proves two fresh
    // spawns land on DISTINCT accounts at the actual spawn layer (not just the
    // bridge unit), with each account stamped on its own session.
    const accounts = ["acc-a", "acc-b"];
    let call = 0;
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
      describe: () => ({}),
      select: vi.fn(async () => {
        const accountId = accounts[call % accounts.length] ?? "acc-a";
        call += 1;
        return {
          providerId: "anthropic-subscription",
          accountId,
          label: accountId,
          source: "oauth" as const,
          strategy: "least-used",
          envPatch: { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat-${accountId}` },
        };
      }),
      markRateLimited: vi.fn(async () => undefined),
      markNeedsReauth: vi.fn(async () => undefined),
      recordUsage: vi.fn(async () => undefined),
    };
    const service = new AcpService(runtime());
    await service.start();
    const first = await service.spawnSession({
      name: "claude-1",
      agentType: "claude",
      workdir: "/tmp/acp-test",
    });
    const second = await service.spawnSession({
      name: "claude-2",
      agentType: "claude",
      workdir: "/tmp/acp-test",
    });
    const acc = (r: typeof first) =>
      (
        (r.metadata as Record<string, unknown>)?.account as
          | Record<string, unknown>
          | undefined
      )?.accountId;
    expect(acc(first)).toBe("acc-a");
    expect(acc(second)).toBe("acc-b");
    expect(acc(first)).not.toBe(acc(second));
    // The injected token follows the selected account, per session.
    expect(
      nativeClientMock.instances[0]?.opts.env?.CLAUDE_CODE_OAUTH_TOKEN,
    ).toBe("sk-ant-oat-acc-a");
    expect(
      nativeClientMock.instances[1]?.opts.env?.CLAUDE_CODE_OAUTH_TOKEN,
    ).toBe("sk-ant-oat-acc-b");
    await service.stop();
  });
});
