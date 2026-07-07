/**
 * Deliverable loss on the router's task_complete early-return paths.
 *
 * SubAgentRouter.handleEvent records a completed task's result for its origin
 * (recordOriginResult) so the per-origin spawn cap in tasks.ts can RELAY the
 * best captured result instead of re-spawning (#8875). But three paths return
 * BEFORE that record call — verify-retry handoff, stale-continuation
 * suppression, and the cross-session lineage dedupe. A completion absorbed by
 * any of them was silently dropped: bestResultFor() stayed undefined (or
 * stale), and when the spawn cap later fired the user got a generic fallback
 * instead of the finished deliverable.
 *
 * These tests drive the REAL handleEvent (private, invoked directly) with a
 * fake ACP service, plus the REAL TASKS action cap branch, and pin:
 *  1. verify-retry handoff does NOT capture the verify-FAILED completion —
 *     the router just judged that build incomplete, so recording its (dead-URL
 *     annotated, systematically longer) narration would let longest-wins
 *     shadow the successful retry's shorter clean answer and relay the failure
 *     at the spawn cap (see origin-result-verify-failed-shadow.test.ts);
 *  2. lineage dedupe still lets a LONGER late completion win (longest-wins);
 *  3. the spawn-cap fallback is an honest "attempted N times" message, not
 *     the misleading "still working" that conflates capped-and-failed with
 *     in-flight — and relays the captured deliverable when one exists.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tasksAction } from "../actions/tasks.ts";
import { SubAgentRouter } from "../services/sub-agent-router.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

type RouterInternals = {
  handleEvent(sessionId: string, event: string, data: unknown): Promise<void>;
};

function makeFakeAcp(sessions: Map<string, Record<string, unknown>>) {
  let handler: EventHandler | undefined;
  const spawnSession = vi.fn(async () => ({ sessionId: "retry-1" }));
  const service = {
    onSessionEvent(cb: EventHandler) {
      handler = cb;
      return () => {
        handler = undefined;
      };
    },
    getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId)),
    getSessions: vi.fn(async () => [...sessions.values()]),
    getChangedPaths: vi.fn(() => [] as string[]),
    spawnSession,
    stopSession: vi.fn(async () => undefined),
    updateSessionMetadata: vi.fn(async () => undefined),
  };
  return { service, spawnSession, emit: handler };
}

type FakeAcp = ReturnType<typeof makeFakeAcp>;

function makeRuntime(
  acp: ReturnType<typeof makeFakeAcp>["service"],
  router?: SubAgentRouter,
  settings: Record<string, string> = {},
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: (key: string) => settings[key],
    getService: (type: string) => {
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE")
        return acp;
      if (type === "ACPX_SUB_AGENT_ROUTER") return router;
      return undefined;
    },
    createEntity: vi.fn(async () => true),
    addParticipant: vi.fn(async () => true),
    getEntitiesForRoom: vi.fn(async () => []),
    deleteParticipants: vi.fn(async () => true),
    reportError: vi.fn(),
    createMemory: vi.fn(async () => MSG),
    emitEvent: vi.fn(async () => undefined),
    useModel: vi.fn(async () => "{}"),
  } as unknown as IAgentRuntime;
}

function mockCallCount(fn: unknown): number {
  return (fn as { mock: { calls: unknown[] } }).mock.calls.length;
}

function sessionInfo(
  id: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    agentType: "codex",
    name: "Ada",
    workdir: "/tmp/orchestrator-early-return-test",
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata,
  };
}

async function startRouter(
  sessions: Map<string, Record<string, unknown>>,
  settings: Record<string, string> = {},
): Promise<{
  router: SubAgentRouter;
  internals: RouterInternals;
  acp: FakeAcp;
  runtime: IAgentRuntime;
}> {
  const acp = makeFakeAcp(sessions);
  const runtime = makeRuntime(acp.service, undefined, settings);
  const router = new SubAgentRouter(runtime);
  await router.start(); // binds the fake ACP synchronously via getService
  return {
    router,
    internals: router as unknown as RouterInternals,
    acp,
    runtime,
  };
}

describe("origin-result capture on task_complete early returns", () => {
  it("verify-retry handoff does NOT record the verify-FAILED completion", async () => {
    // A completion that claims a DEAD loopback URL (nothing listens on the
    // discard port) with explicit deploy/live intent in the task → the
    // verifier flags it dead → retryIncompleteBuild spawns a retry → the
    // handler takes the verify-retry early return. That suppressed completion
    // is a build the router itself judged INCOMPLETE: it must not become the
    // origin's relayable best result, or its (dead-URL annotated,
    // systematically longer) narration shadows the successful retry's shorter
    // clean answer under longest-wins and gets relayed — planner-only
    // verification directive included — verbatim to the user at the spawn cap
    // (35a9e8163a / #11514 regression). With nothing clean captured, the cap
    // falls back to the honest "attempted N times" message instead.
    const deadUrl = "http://127.0.0.1:9/apps/game/index.html";
    const sessions = new Map<string, Record<string, unknown>>([
      [
        "sess-verify",
        sessionInfo("sess-verify", {
          roomId: ROOM,
          taskRoomId: ROOM,
          messageId: MSG,
          originConnectorMessageId: "disc-verify-1",
          spawnRootMessageId: MSG,
          source: "discord",
          label: "build game",
          initialTask: `Deploy the game and give me the live url ${deadUrl}`,
        }),
      ],
    ]);
    const { router, internals, acp, runtime } = await startRouter(sessions, {
      ELIZA_URL_VERIFY_SETTLE_MS: "0",
    });

    await internals.handleEvent("sess-verify", "task_complete", {
      response: `The game is built and live at ${deadUrl}`,
      stopReason: "end_turn",
    });

    // Prove the verify-retry EARLY RETURN was the path taken: a retry was
    // spawned and the suppressed completion never reached the delivery loop.
    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    expect(runtime.emitEvent).not.toHaveBeenCalled();

    // …and the verify-FAILED completion was NOT captured for the origin.
    expect(router.bestResultFor("disc-verify-1\0codex")).toBeUndefined();
    await router.stop();
  });

  it("lineage dedupe still lets a longer late completion win (longest-wins capture)", async () => {
    // Two sessions for the SAME origin lineage. The first completion claims
    // the lineage slot and posts; the second (a retry that finished with the
    // FULL answer) is dedupe-suppressed. Before the fix the suppression
    // dropped its deliverable, so the spawn cap could only ever relay the
    // truncated first answer.
    const originMeta = {
      roomId: ROOM,
      taskRoomId: ROOM,
      messageId: MSG,
      originConnectorMessageId: "disc-dedupe-1",
      spawnRootMessageId: MSG,
      source: "discord",
      label: "compute 12!",
      initialTask: "compute 12 factorial and report the number",
    };
    const sessions = new Map<string, Record<string, unknown>>([
      ["sess-a", sessionInfo("sess-a", { ...originMeta })],
      ["sess-b", sessionInfo("sess-b", { ...originMeta })],
    ]);
    const { router, internals, runtime } = await startRouter(sessions);

    await internals.handleEvent("sess-a", "task_complete", {
      response: "479",
      stopReason: "end_turn",
    });
    const deliveriesAfterFirst = mockCallCount(runtime.emitEvent);
    expect(deliveriesAfterFirst).toBeGreaterThan(0);
    const afterFirst = router.bestResultFor("disc-dedupe-1\0codex");
    expect(afterFirst?.text).toContain("479");

    // Second, longer completion for the same lineage → dedupe early return
    // (no additional delivery), but its fuller answer must still be captured.
    await internals.handleEvent("sess-b", "task_complete", {
      response: "479001600 (the full answer)",
      stopReason: "end_turn",
    });
    expect(mockCallCount(runtime.emitEvent)).toBe(deliveriesAfterFirst);
    const best = router.bestResultFor("disc-dedupe-1\0codex");
    expect(best?.text).toContain("479001600");
    await router.stop();
  });
});

describe("spawn-cap fallback message (TASKS spawn_agent)", () => {
  let savedCap: string | undefined;
  beforeEach(() => {
    savedCap = process.env.ELIZA_MAX_SPAWNS_PER_ORIGIN;
    delete process.env.ELIZA_MAX_SPAWNS_PER_ORIGIN;
  });
  afterEach(() => {
    if (savedCap === undefined) delete process.env.ELIZA_MAX_SPAWNS_PER_ORIGIN;
    else process.env.ELIZA_MAX_SPAWNS_PER_ORIGIN = savedCap;
  });

  function capMessage(msgId: string): Memory {
    return {
      id: msgId,
      roomId: ROOM,
      entityId: "22222222-2222-4222-8222-222222222222",
      content: { text: "build me a website", metadata: {} },
    } as unknown as Memory;
  }

  async function runCappedSpawn(
    router: SubAgentRouter,
    msgId: string,
  ): Promise<{ replyText: string; result: Record<string, unknown> }> {
    const sessions = new Map<string, Record<string, unknown>>();
    const { service } = makeFakeAcp(sessions);
    const runtime = makeRuntime(service, router, {
      // Hermetic: ignore any ambient adapter pin + skip task-room minting.
      ELIZA_AGENT_SELECTION_STRATEGY: "dynamic",
      ELIZA_ORCHESTRATOR_TASK_ROOMS: "0",
    });
    let replyText = "";
    const result = (await tasksAction.handler(
      runtime,
      capMessage(msgId),
      undefined as unknown as State,
      {
        parameters: {
          action: "spawn_agent",
          agentType: "codex",
          task: "build me a website",
        },
      },
      async (content) => {
        if (typeof content.text === "string") replyText = content.text;
        return [];
      },
    )) as Record<string, unknown>;
    return { replyText, result };
  }

  it("is HONEST about the attempt cap when no result was ever captured", async () => {
    const runtime = makeRuntime(makeFakeAcp(new Map()).service);
    const router = new SubAgentRouter(runtime);
    const msgId = "33333333-3333-4333-8333-333333333333";
    const key = `${msgId}\0codex`;
    router.noteSpawnForOrigin(key);
    router.noteSpawnForOrigin(key);
    router.noteSpawnForOrigin(key); // default cap = 3 → next spawn is capped

    const { replyText, result } = await runCappedSpawn(router, msgId);
    expect((result.data as Record<string, unknown>)?.spawnCapped).toBe(true);
    // The dishonest message implied the task was still in flight.
    expect(replyText).not.toMatch(/still working/i);
    expect(replyText).toBe(
      "I attempted this task 3 times but couldn't complete it. Try giving me more specific instructions, or breaking it into smaller steps.",
    );
  });

  it("relays the captured deliverable at the cap when one exists", async () => {
    const runtime = makeRuntime(makeFakeAcp(new Map()).service);
    const router = new SubAgentRouter(runtime);
    const msgId = "44444444-4444-4444-8444-444444444444";
    const key = `${msgId}\0codex`;
    router.noteSpawnForOrigin(key);
    router.noteSpawnForOrigin(key);
    router.noteSpawnForOrigin(key);
    router.recordOriginResult(key, {
      text: "the answer",
      deliverable: "479001600",
    });

    const { replyText } = await runCappedSpawn(router, msgId);
    expect(replyText).toBe("479001600");
  });
});
