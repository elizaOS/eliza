/**
 * Whole-turn watchdog contract (ACP_PROMPT_TURN_WEDGED): a wedged prompt turn
 * is actively CANCELLED on the underlying transport and generation-FENCED, so
 * its late events and late completion are dropped instead of corrupting the
 * session's next turn (busy flag, store status, event handler). Real
 * AcpService with an in-memory store and a scripted native client double whose
 * prompt promise the test settles on demand; fake timers drive the watchdog.
 */
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { InMemorySessionStore } from "../services/session-store.js";
import type { SessionInfo } from "../services/types.js";

type PromptDeferred = {
  resolve: (value: { stopReason: string }) => void;
  reject: (err: unknown) => void;
};

/** Scripted stand-in for NativeAcpClient: prompts hang until the test settles
 *  them; cancel notifications are recorded. */
class FakeNativeClient {
  handler: ((event: unknown) => void) | undefined;
  readonly cancelCalls: string[] = [];
  readonly promptDeferreds: PromptDeferred[] = [];

  setEventHandler(handler: ((event: unknown) => void) | undefined): void {
    this.handler = handler;
  }

  setTimeoutMs(_timeoutMs: number | undefined): void {}

  prompt(_sessionId: string, _text: string): Promise<{ stopReason: string }> {
    return new Promise<{ stopReason: string }>((resolve, reject) => {
      this.promptDeferreds.push({ resolve, reject });
    });
  }

  async cancel(sessionId: string): Promise<undefined> {
    this.cancelCalls.push(sessionId);
    return undefined;
  }
}

function makeRuntime() {
  return {
    agentId: "00000000-0000-4000-8000-0000000000fe",
    character: { name: "Tester" },
    getSetting: () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getService: () => null,
    reportError() {},
  };
}

function makeSession(id: string): SessionInfo {
  const now = new Date();
  return {
    id,
    name: id,
    agentType: "elizaos",
    workdir: "/tmp/watchdog-fence-test",
    status: "ready",
    approvalPreset: "approve-all",
    createdAt: now,
    lastActivityAt: now,
    acpxSessionId: "proto-1",
    metadata: { transportMode: "native" },
  } as SessionInfo;
}

type Harness = {
  started: boolean;
  nativeClients: Map<string, FakeNativeClient>;
  nativePromptSessionIds: Set<string>;
  sessionGenerations: Map<string, number>;
};

const SESSION_ID = "sess-wedge-1";

describe("sendPrompt whole-turn watchdog (cancel + generation fence)", () => {
  let store: InMemorySessionStore;
  let service: AcpService;
  let harness: Harness;
  let client: FakeNativeClient;
  let events: Array<{ event: string; data: unknown }>;

  beforeEach(async () => {
    vi.useFakeTimers();
    store = new InMemorySessionStore();
    service = new AcpService(makeRuntime() as never, { store });
    harness = service as unknown as Harness;
    harness.started = true;
    client = new FakeNativeClient();
    harness.nativeClients.set(SESSION_ID, client);
    await store.create(makeSession(SESSION_ID));
    events = [];
    service.onSessionEvent((sessionId, event, data) => {
      if (sessionId === SESSION_ID) events.push({ event, data });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startWedgedTurn(): Promise<Promise<unknown>> {
    const turn = service.sendPrompt(SESSION_ID, "turn 1", {
      timeoutMs: 1_000,
    });
    const settled = turn.catch((err) => err);
    // Drain microtasks so the turn reaches the hanging client.prompt.
    await vi.advanceTimersByTimeAsync(1);
    expect(client.promptDeferreds.length).toBe(1);
    // Fire the whole-turn watchdog (timeoutMs + 60s grace).
    await vi.advanceTimersByTimeAsync(61_500);
    return settled;
  }

  it("cancels the wedged turn on the transport and errors the session", async () => {
    const settled = await startWedgedTurn();
    const err = (await settled) as ElizaError;
    expect(err).toBeInstanceOf(ElizaError);
    expect(err.code).toBe("ACP_PROMPT_TURN_WEDGED");
    // The underlying turn was actively cancelled (session/cancel notification
    // addressed by the protocol session id), not just abandoned.
    expect(client.cancelCalls).toEqual(["proto-1"]);
    expect((await store.get(SESSION_ID))?.status).toBe("errored");
    // The busy claim is released so a follow-up prompt can run.
    expect(harness.nativePromptSessionIds.has(SESSION_ID)).toBe(false);
  });

  it("drops late events from the wedged turn's stale event handler", async () => {
    await startWedgedTurn();
    const before = events.length;
    // The wedged turn's closure is still attached to the client; a late
    // streamed chunk must be fenced out, not emitted as a session event.
    client.handler?.({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late chunk from wedged turn" },
        },
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(events.length).toBe(before);
  });

  it("a wedged turn's late completion does not corrupt the next turn", async () => {
    await startWedgedTurn();

    // Second turn claims the session.
    const turn2 = service.sendPrompt(SESSION_ID, "turn 2", {
      timeoutMs: 1_000,
    });
    const turn2Settled = turn2.catch((err) => err);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.promptDeferreds.length).toBe(2);
    // The store's terminal-status guard holds "errored" until a COMPLETED
    // turn writes "ready" through update(); mid-turn the wedge status stands.
    expect((await store.get(SESSION_ID))?.status).toBe("errored");

    // The wedged turn now completes LATE, while turn 2 is mid-flight. Without
    // the generation fence this wrote status "ready" (via the unguarded
    // update()), tore down turn 2's busy marker, and replaced turn 2's event
    // handler.
    const turn2Handler = client.handler;
    client.promptDeferreds[0]?.resolve({ stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(1);

    expect((await store.get(SESSION_ID))?.status).toBe("errored");
    expect(harness.nativePromptSessionIds.has(SESSION_ID)).toBe(true);
    expect(client.handler).toBe(turn2Handler);

    // Turn 2 still completes normally.
    client.promptDeferreds[1]?.resolve({ stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(1);
    const result = (await turn2Settled) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect((await store.get(SESSION_ID))?.status).toBe("ready");
  });

  it("bumps the session generation on watchdog fire and on each new prompt", async () => {
    await startWedgedTurn();
    // Turn 1 start -> 1, watchdog fire -> 2.
    expect(harness.sessionGenerations.get(SESSION_ID)).toBe(2);
    const turn2 = service.sendPrompt(SESSION_ID, "turn 2", {
      timeoutMs: 1_000,
    });
    const turn2Settled = turn2.catch((err) => err);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.sessionGenerations.get(SESSION_ID)).toBe(3);
    client.promptDeferreds[1]?.resolve({ stopReason: "end_turn" });
    await vi.advanceTimersByTimeAsync(1);
    await turn2Settled;
  });
});
