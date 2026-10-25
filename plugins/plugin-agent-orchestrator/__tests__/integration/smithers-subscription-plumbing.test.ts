/**
 * Credential-plumbing integration for the Smithers task process through
 * AcpService's selected-account boundary. The ACP transport is an in-process
 * protocol peer; the separately gated live suite proves real subscription auth.
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

function nativeState(): NativeMockState {
  const global = globalThis as typeof globalThis & {
    __smithersSubscriptionNativeMock?: NativeMockState;
  };
  global.__smithersSubscriptionNativeMock ??= { instances: [] };
  return global.__smithersSubscriptionNativeMock;
}

vi.mock(
  "../../src/services/acp-native-transport.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/services/acp-native-transport.js")
      >();
    const state = nativeState();
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
      prompt = vi.fn(async (sessionId: string) => {
        this.eventHandler?.({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "subscription-backed Smithers result",
              },
            },
          },
        } as AcpJsonRpcMessage);
        return { stopReason: "end_turn" };
      });
      cancel = vi.fn(async () => undefined);
      closeSession = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);

      constructor(opts: NativeOptions) {
        this.opts = opts;
        this.eventHandler = opts.onEvent;
        nativeState().instances.push(this);
      }

      setEventHandler(handler: NativeEventHandler | undefined): void {
        this.eventHandler = handler;
        this.opts.onEvent = handler;
      }

      setTimeoutMs(timeoutMs: number | undefined): void {
        this.opts.timeoutMs = timeoutMs;
      }
    };
    return { ...actual, NativeAcpClient: state.NativeAcpClient };
  },
);

import { AcpService } from "../../src/services/acp-service.js";
import { runDurableTask } from "../../src/services/smithers-task-integration.js";

const BRIDGE_SYMBOL = CODING_AGENT_SELECTOR_BRIDGE_SYMBOL;

function runtime() {
  const values: Record<string, string> = {
    ELIZA_ACP_TRANSPORT: "native",
    ELIZA_ACP_SESSION_STORE_BACKEND: "memory",
    ELIZA_CLAUDE_ACP_COMMAND: "test-claude-acp",
  };
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn((key: string) => values[key]),
    services: new Map<string, unknown[]>(),
  } as never;
}

beforeEach(() => {
  nativeState().instances.length = 0;
  (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
    describe: () => ({}),
    select: vi.fn(async () => ({
      providerId: "anthropic-subscription",
      accountId: "account-work",
      label: "Work",
      source: "oauth" as const,
      strategy: "least-used",
      envPatch: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-selected" },
    })),
    markRateLimited: vi.fn(async () => undefined),
    markNeedsReauth: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
});

describe("Smithers subscription credential plumbing", () => {
  it("executes on the ACP session authenticated by the selected subscription", async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-must-not-override-subscription";
    const service = new AcpService(runtime());
    try {
      await service.start();
      const session = await service.spawnSession({
        name: "smithers-subscription",
        agentType: "claude",
        workdir: process.cwd(),
      });
      const client = nativeState().instances[0];
      expect(client).toBeDefined();
      expect(client?.opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
        "sk-ant-oat-selected",
      );
      expect(client?.opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(session.metadata).toMatchObject({
        account: {
          providerId: "anthropic-subscription",
          accountId: "account-work",
        },
      });
      expect(JSON.stringify(session.metadata)).not.toContain(
        "sk-ant-oat-selected",
      );

      const result = await runDurableTask(
        service,
        session,
        "prove the linked subscription reaches the Smithers turn",
        {
          tenantId: "00000000-0000-4000-8000-000000000001",
          timeoutMs: 30_000,
        },
      );

      expect(result).toMatchObject({
        status: "completed",
        lastResponse: "subscription-backed Smithers result",
        turns: 1,
      });
      expect(client?.prompt).toHaveBeenCalledWith(
        "protocol-session",
        "prove the linked subscription reaches the Smithers turn",
      );
    } finally {
      await service.stop();
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  }, 60_000);
});
