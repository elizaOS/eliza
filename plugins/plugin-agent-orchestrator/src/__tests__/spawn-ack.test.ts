/**
 * Request-level spawn-ack gate + terminal-finalized progress mute in the
 * progress hook (`registerProgressHook`).
 *
 * The live defect: a task-service respawn creates a FRESH sessionId for the
 * SAME user request — the per-session ack guards never see it and the 60s
 * room-ack window has expired, so every respawn posted another spawn ack. The
 * hook now claims the request's ack slot on the router's voice ledger (keyed
 * by requestKeyForMeta); a denied claim silences the successor. And once a
 * request's terminal is finalized (parked/failed), emitProgress — the single
 * funnel for heartbeat/narration/error/blocked posts — goes mute for its
 * sessions. Harness: the REAL hook wired to a fake runtime + fake ACP event
 * stream + a fake router ledger; both gates fail open without the router.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { registerProgressHook } from "../index.ts";
import { AcpService } from "../services/acp-service.ts";

type EventHandler = (
  sessionId: string,
  event: string,
  data: unknown,
) => Promise<void> | void;

const ROOM = "55555555-5555-4555-8555-555555555555";

class FakeAcp {
  static serviceType = AcpService.serviceType;
  readonly metadataById = new Map<string, Record<string, unknown>>();
  private handler: EventHandler | undefined;

  async getSession(id: string) {
    const metadata = this.metadataById.get(id);
    if (!metadata) return undefined;
    return { id, status: "ready", metadata, createdAt: new Date() };
  }

  async updateSessionMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const current = this.metadataById.get(id) ?? {};
    this.metadataById.set(id, { ...current, ...patch });
  }

  onSessionEvent(cb: EventHandler): () => void {
    this.handler = cb;
    return () => {
      this.handler = undefined;
    };
  }

  async emit(sessionId: string, event: string, data: unknown = {}) {
    await this.handler?.(sessionId, event, data);
  }
}

/** Minimal request-voice ledger matching the structural contract the hook
 * consumes: first ack claim per key wins; terminal finalization is a set. */
function makeRouterLedger() {
  const ackHolders = new Map<string, string>();
  const finalized = new Set<string>();
  return {
    finalized,
    requestKeyForMeta: (meta: Record<string, unknown>) =>
      typeof meta.spawnRootMessageId === "string"
        ? meta.spawnRootMessageId
        : null,
    claimRequestAck: (key: string, sessionId: string) => {
      const holder = ackHolders.get(key);
      if (holder === undefined) {
        ackHolders.set(key, sessionId);
        return { granted: true };
      }
      return { granted: holder === sessionId, superseded: false };
    },
    isRequestTerminalFinalized: (key: string) => finalized.has(key),
  };
}

interface HarnessOpts {
  mode: "ack" | "compact";
  router?: ReturnType<typeof makeRouterLedger> | undefined;
}

function harness(opts: HarnessOpts) {
  const acp = new FakeAcp();
  const router = opts.router;
  const sends: Array<{ text: string; source: string }> = [];
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000077",
    character: { name: "Acker", bio: ["test agent"] },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: (key: string) => {
      if (key === "ACPX_PROGRESS_MODE") return opts.mode;
      if (key === "ACPX_PROGRESS_DELAY_MS") return "0";
      return undefined;
    },
    useModel: vi.fn(async () => "On it!"),
    reportError: vi.fn(),
    getMessageConnectors: () => [],
    sendMessageToTarget: vi.fn(
      async (_target: unknown, content: { text: string; source: string }) => {
        sends.push({ text: content.text, source: content.source });
        return {
          id: `mem-${sends.length}`,
          metadata: { platformMessageId: `pm-${sends.length}` },
          content: {},
        };
      },
    ),
    getService: (type: string) => {
      if (type === AcpService.serviceType) return acp;
      if (type === "ACPX_SUB_AGENT_ROUTER") return router;
      return undefined;
    },
  };
  const teardown = registerProgressHook(runtime as never);
  return { acp, router, sends, runtime, teardown };
}

/** Distinct label per session, matching the live spawn path: assignAgentName
 * gives every session its own person-name, so the label-keyed main-message
 * cache (a separate, pre-existing dedupe) never masks the request-level gate
 * under test here. */
function sessionMeta(label: string, key?: string): Record<string, unknown> {
  return {
    source: "test-conn",
    roomId: ROOM,
    label,
    ...(key ? { spawnRootMessageId: key } : {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request-level spawn-ack gate", () => {
  it("a task-service respawn (same requestKey, fresh sessionId, past the 60s room window) does not re-ack; a new request still acks", async () => {
    let nowMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const { acp, sends, teardown } = harness({
      mode: "ack",
      router: makeRouterLedger(),
    });

    acp.metadataById.set("s1", sessionMeta("wkr-1", "req-1"));
    await acp.emit("s1", "ready");
    expect(sends).toHaveLength(1);

    // Respawn successor: fresh sessionId, SAME request key, long after the
    // 60s room-ack window — the per-session and per-room guards both miss it.
    nowMs += 120_000;
    acp.metadataById.set("s2", sessionMeta("wkr-2", "req-1"));
    await acp.emit("s2", "ready");
    expect(sends).toHaveLength(1);

    // A genuinely NEW request (different key) still gets its own ack.
    acp.metadataById.set("s3", sessionMeta("wkr-3", "req-2"));
    await acp.emit("s3", "ready");
    expect(sends).toHaveLength(2);

    teardown();
  });

  it("fails open: without the router the respawn re-acks exactly as today", async () => {
    let nowMs = 2_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const { acp, sends, teardown } = harness({ mode: "ack" });

    acp.metadataById.set("s1", sessionMeta("wkr-1", "req-1"));
    await acp.emit("s1", "ready");
    expect(sends).toHaveLength(1);

    nowMs += 120_000;
    acp.metadataById.set("s2", sessionMeta("wkr-2", "req-1"));
    await acp.emit("s2", "ready");
    // No ledger → today's behavior (the room window expired, so it re-acks).
    expect(sends).toHaveLength(2);

    teardown();
  });
});

describe("terminal-finalized progress mute", () => {
  it("mutes emitProgress posts once the session's request is finalized", async () => {
    const router = makeRouterLedger();
    const { acp, sends, teardown } = harness({ mode: "compact", router });

    acp.metadataById.set("s4", sessionMeta("wkr-4", "req-9"));
    await acp.emit("s4", "blocked");
    expect(sends).toHaveLength(1);

    // The request reaches its finalized terminal (parked/failed). The same
    // session grinding on must not post again — blocked/login_required/error
    // and the heartbeat all funnel through emitProgress.
    router.finalized.add("req-9");
    await acp.emit("s4", "login_required");
    expect(sends).toHaveLength(1);

    // A different, unfinalized request still posts.
    acp.metadataById.set("s5", sessionMeta("wkr-5", "req-10"));
    await acp.emit("s5", "blocked");
    expect(sends).toHaveLength(2);

    teardown();
  });
});
