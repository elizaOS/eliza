/**
 * Account-failure propagation (#9960 error-handling audit): a spawned account's
 * auth / rate-limit failure must feed back to the pool (markNeedsReauth /
 * markRateLimited) so the selector stops handing out the dud account, instead
 * of the failure being swallowed and the same account re-selected. Covers the
 * conservative classifier and the router wiring that drives the pool bridge.
 */

// biome-ignore assist/source/organizeImports: comment-only pass preserves import token order.
import { CODING_AGENT_SELECTOR_BRIDGE_SYMBOL } from "@elizaos/core";
import type { Content, HandlerCallback, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyAccountFailure,
  RATE_LIMIT_COOLOFF_MS,
} from "../../src/services/coding-account-selection.js";
import { SubAgentRouter } from "../../src/services/sub-agent-router.js";
import type { SessionInfo } from "../../src/services/types.js";

describe("classifyAccountFailure", () => {
  it("flags unambiguous rate-limit signals", () => {
    expect(classifyAccountFailure("HTTP 429 Too Many Requests")).toBe(
      "rate-limited",
    );
    expect(classifyAccountFailure("rate limit exceeded for this account")).toBe(
      "rate-limited",
    );
    expect(classifyAccountFailure("quota exhausted")).toBe("rate-limited");
  });

  it("flags OpenAI's classic quota envelope (inverted word order, no 429 literal)", () => {
    expect(
      classifyAccountFailure(
        "You exceeded your current quota, please check your plan and billing details. " +
          "For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
      ),
    ).toBe("rate-limited");
    // Truncated variants: either envelope half alone still classifies.
    expect(classifyAccountFailure("You exceeded your current quota")).toBe(
      "rate-limited",
    );
    expect(
      classifyAccountFailure("please check your plan and billing details"),
    ).toBe("rate-limited");
    // The machine-readable error code from the JSON envelope body.
    expect(
      classifyAccountFailure(
        '{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}',
      ),
    ).toBe("rate-limited");
  });

  it("does NOT flag prose that merely talks about quotas / billing", () => {
    expect(
      classifyAccountFailure(
        "the user asked how quotas work and whether billing resets monthly",
      ),
    ).toBeNull();
    expect(
      classifyAccountFailure(
        "your quota looks fine; billing details are unchanged",
      ),
    ).toBeNull();
  });

  it("flags unambiguous auth signals", () => {
    expect(classifyAccountFailure("401 Unauthorized")).toBe("needs-reauth");
    expect(classifyAccountFailure("invalid_grant")).toBe("needs-reauth");
    expect(classifyAccountFailure("authentication failed")).toBe(
      "needs-reauth",
    );
    expect(
      classifyAccountFailure("token expired, please re-authenticate"),
    ).toBe("needs-reauth");
  });

  it("does NOT flag ordinary build output (no healthy-account eviction)", () => {
    expect(classifyAccountFailure(undefined)).toBeNull();
    expect(classifyAccountFailure("")).toBeNull();
    expect(
      classifyAccountFailure("wrote OPENAI_API_KEY to .env and logged in"),
    ).toBeNull();
    expect(
      classifyAccountFailure("TypeError: undefined is not a function"),
    ).toBeNull();
    expect(
      classifyAccountFailure("build failed: missing login form"),
    ).toBeNull();
  });
});

const BRIDGE_SYMBOL = CODING_AGENT_SELECTOR_BRIDGE_SYMBOL;
const ROOM = "11111111-2222-3333-4444-555555555555";
const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";

function makeSession(account?: Record<string, unknown>): SessionInfo {
  const now = new Date("2026-06-29T12:00:00.000Z");
  return {
    id: SESSION_ID,
    name: "demo",
    agentType: "claude",
    workdir: "/tmp/wf",
    status: "errored",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: {
      label: "fix-bug",
      roomId: ROOM,
      source: "telegram",
      messageId: "99999999-8888-7777-6666-555555555555",
      ...(account ? { account } : {}),
    },
  };
}

function makeAcp(session: SessionInfo) {
  let handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | undefined;
  return {
    service: {
      onSessionEvent: vi.fn((fn: typeof handler) => {
        handler = fn;
        return () => {
          handler = undefined;
        };
      }),
      getSession: vi.fn(async (id: string) =>
        id === session.id ? session : null,
      ),
      listSessions: vi.fn(async () => [session]),
      stopSession: vi.fn(async () => {}),
      updateSessionMetadata: vi.fn(async () => undefined),
      getChangedPaths: vi.fn(() => [] as string[]),
      sendToSession: vi.fn(async () => ({})),
    },
    emit(id: string, event: string, data: unknown) {
      handler?.(id, event, data);
    },
  };
}

function makeRuntime(acp: unknown) {
  const handleMessage = vi.fn<
    (rt: unknown, m: Memory, cb?: HandlerCallback) => Promise<unknown>
  >(async () => ({}));
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getService: vi.fn(() => acp),
    getSetting: vi.fn(() => undefined),
    createMemory: vi.fn(async () => undefined),
    createEntity: vi.fn(async () => true),
    addParticipant: vi.fn(async () => true),
    emitEvent: vi.fn(async () => undefined),
    sendMessageToTarget: vi.fn(async (_t: unknown, content: Content) => ({
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      content,
    })),
    messageService: { handleMessage },
  } as never;
  return runtime;
}

describe("router → pool account-failure propagation", () => {
  const bridge = {
    markRateLimited: vi.fn(async () => undefined),
    markNeedsReauth: vi.fn(async () => undefined),
    describe: vi.fn(() => ({})),
    select: vi.fn(async () => null),
    recordUsage: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    bridge.markRateLimited.mockClear();
    bridge.markNeedsReauth.mockClear();
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = bridge;
  });
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
    vi.clearAllMocks();
  });

  const account = {
    providerId: "anthropic-subscription",
    accountId: "acct-1",
    label: "Work",
    source: "oauth",
    strategy: "least-used",
  };

  it("marks the account needs-reauth on a 401 error", async () => {
    const acp = makeAcp(makeSession(account));
    const router = await SubAgentRouter.start(makeRuntime(acp.service));
    acp.emit(SESSION_ID, "error", { message: "401 Unauthorized" });
    await new Promise((r) => setImmediate(r));
    expect(bridge.markNeedsReauth).toHaveBeenCalledWith(
      "anthropic-subscription",
      "acct-1",
      expect.any(String),
    );
    expect(bridge.markRateLimited).not.toHaveBeenCalled();
    await router.stop();
  });

  it("marks the account rate-limited (with a cool-off) on a 429 error", async () => {
    const acp = makeAcp(makeSession(account));
    const router = await SubAgentRouter.start(makeRuntime(acp.service));
    acp.emit(SESSION_ID, "error", { message: "429 rate limit exceeded" });
    await new Promise((r) => setImmediate(r));
    expect(bridge.markRateLimited).toHaveBeenCalledTimes(1);
    const [providerId, accountId, untilMs] =
      bridge.markRateLimited.mock.calls[0] ?? [];
    expect(providerId).toBe("anthropic-subscription");
    expect(accountId).toBe("acct-1");
    expect(typeof untilMs).toBe("number");
    expect(untilMs as number).toBeGreaterThanOrEqual(Date.now());
    expect((untilMs as number) - Date.now()).toBeLessThanOrEqual(
      RATE_LIMIT_COOLOFF_MS + 1000,
    );
    await router.stop();
  });

  it("does NOT touch the pool on an ordinary task error", async () => {
    const acp = makeAcp(makeSession(account));
    const router = await SubAgentRouter.start(makeRuntime(acp.service));
    acp.emit(SESSION_ID, "error", {
      message: "TypeError: cannot read property 'x' of undefined",
    });
    await new Promise((r) => setImmediate(r));
    expect(bridge.markNeedsReauth).not.toHaveBeenCalled();
    expect(bridge.markRateLimited).not.toHaveBeenCalled();
    await router.stop();
  });

  it("does NOT touch the pool when the session has no selected account", async () => {
    const acp = makeAcp(makeSession()); // no account meta
    const router = await SubAgentRouter.start(makeRuntime(acp.service));
    acp.emit(SESSION_ID, "error", { message: "401 Unauthorized" });
    await new Promise((r) => setImmediate(r));
    expect(bridge.markNeedsReauth).not.toHaveBeenCalled();
    await router.stop();
  });
});
