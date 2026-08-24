/**
 * Restart recovery for user-facing completion relays.
 *
 * A restart in the task_complete → origin-post window used to swallow the
 * completion: the deferred-relay map and delivered-dedup set are process
 * memory (live 2026-08-21: the Daily Hue APP build finished and deployed
 * during a restart and the origin room never heard). These tests drive the
 * REAL SubAgentRouter against a fabricated durable ledger:
 *
 *  - the start sweep re-emits a terminal-complete task's undelivered relay
 *    with the honest "finished while restarting" note and stamps delivered
 *    only AFTER the post;
 *  - the request-key dedupe clears (never re-posts) an already-delivered
 *    relay;
 *  - terminal-failed tasks clear silently (park/failure messaging owns them);
 *  - a validating task whose lane is still live is left alone;
 *  - the live emit path stamps pending BEFORE posting and delivered AFTER.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  completionRelayDedupeKey,
  type PendingCompletionRelay,
  readDeliveredCompletionRelayKeys,
  readPendingCompletionRelays,
  withDeliveredCompletionRelay,
  withoutPendingCompletionRelay,
  withPendingCompletionRelay,
} from "../services/completion-relay-ledger.ts";
import { SubAgentRouter } from "../services/sub-agent-router.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

type RouterInternals = {
  handleEvent(
    sessionId: string,
    event: string,
    data: unknown,
    sessionSnapshot?: unknown,
    turnId?: string,
  ): Promise<void>;
};

function makeFakeAcp(sessions: Map<string, Record<string, unknown>>) {
  const service = {
    onSessionEvent(_cb: unknown) {
      return () => undefined;
    },
    getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId)),
    getSessions: vi.fn(async () => [...sessions.values()]),
    getChangedPaths: vi.fn(() => [] as string[]),
    stopSession: vi.fn(async () => undefined),
    updateSessionMetadata: vi.fn(async () => undefined),
  };
  return service;
}

type FakeLedger = {
  calls: string[];
  listUndeliveredCompletionRelays: ReturnType<typeof vi.fn>;
  stampPendingCompletionRelay: ReturnType<typeof vi.fn>;
  stampCompletionRelayDelivered: ReturnType<typeof vi.fn>;
  clearPendingCompletionRelay: ReturnType<typeof vi.fn>;
  getTaskForSession: ReturnType<typeof vi.fn>;
};

function makeFakeLedger(
  undelivered: Array<Record<string, unknown>>,
  taskForSession: Record<string, unknown> | null = {
    id: "task-1",
    status: "done",
  },
): FakeLedger {
  const calls: string[] = [];
  return {
    calls,
    listUndeliveredCompletionRelays: vi.fn(async () => undelivered),
    stampPendingCompletionRelay: vi.fn(async () => {
      calls.push("pending");
    }),
    stampCompletionRelayDelivered: vi.fn(async () => {
      calls.push("delivered");
    }),
    clearPendingCompletionRelay: vi.fn(async () => {
      calls.push("clear");
    }),
    getTaskForSession: vi.fn(async () => taskForSession),
  };
}

function makeRuntime(
  acp: ReturnType<typeof makeFakeAcp>,
  ledger: FakeLedger,
  created: Array<Record<string, unknown>>,
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    getService: (type: string) => {
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE")
        return acp;
      if (type === "ORCHESTRATOR_TASK_SERVICE") return ledger;
      return undefined;
    },
    createEntity: vi.fn(async () => true),
    addParticipant: vi.fn(async () => true),
    getEntitiesForRoom: vi.fn(async () => []),
    deleteParticipants: vi.fn(async () => true),
    reportError: vi.fn(),
    createMemory: vi.fn(async (memory: Record<string, unknown>) => {
      created.push(memory);
      return MSG;
    }),
    emitEvent: vi.fn(async () => undefined),
    useModel: vi.fn(async () => "{}"),
  } as unknown as IAgentRuntime;
}

function pendingEntry(
  overrides: Partial<PendingCompletionRelay> = {},
): PendingCompletionRelay {
  return {
    sessionId: "sess-r1",
    requestKey: MSG,
    stampedAt: Date.now(),
    data: { response: "Daily Hue is built and deployed. All checks passed." },
    session: {
      id: "sess-r1",
      agentType: "elizaos",
      workdir: "/tmp/relay-recovery-test-does-not-exist",
      status: "completed",
      approvalPreset: "auto",
      createdAt: new Date(0).toISOString(),
      lastActivityAt: new Date(0).toISOString(),
      metadata: {
        roomId: ROOM,
        taskRoomId: ROOM,
        messageId: MSG,
        spawnRootMessageId: MSG,
        source: "discord",
        label: "daily-hue",
        initialTask: "Build the Daily Hue color page",
      },
    },
    ...overrides,
  };
}

function relayTexts(created: Array<Record<string, unknown>>): string[] {
  return created
    .map((m) => (m.content as { text?: string } | undefined)?.text ?? "")
    .filter((text) => text.includes("[sub-agent"));
}

async function startedRouter(runtime: IAgentRuntime): Promise<SubAgentRouter> {
  const router = new SubAgentRouter(runtime);
  await router.start();
  return router;
}

describe("completion-relay restart recovery sweep", () => {
  it("re-emits a done task's undelivered relay with the honest restart note, then stamps delivered", async () => {
    const entry = pendingEntry();
    const ledger = makeFakeLedger([
      { taskId: "task-1", status: "done", pending: [entry], deliveredKeys: [] },
    ]);
    // The ACP session did NOT survive the restart: the durable snapshot must
    // be enough to rebuild the relay.
    const acp = makeFakeAcp(new Map());
    const created: Array<Record<string, unknown>> = [];
    const runtime = makeRuntime(acp, ledger, created);
    const router = await startedRouter(runtime);

    const result = await router.sweepUndeliveredCompletionRelays();

    expect(result.reEmitted).toBe(1);
    const texts = relayTexts(created);
    expect(texts.length).toBeGreaterThan(0);
    // The COMPLETE child result relays — never a summary of it.
    expect(texts[0]).toContain(
      "Daily Hue is built and deployed. All checks passed.",
    );
    // Honest provenance: the user is told it finished during the restart.
    expect(texts[0]).toContain(
      "finished while the orchestrator was restarting",
    );
    // Delivered stamped AFTER the emit, keyed by the stable request key.
    expect(ledger.stampCompletionRelayDelivered).toHaveBeenCalledWith(
      "task-1",
      "sess-r1",
      MSG,
    );
    const deliveredAt = ledger.calls.indexOf("delivered");
    expect(deliveredAt).toBeGreaterThanOrEqual(0);
    await router.stop();
  });

  it("never re-posts a relay whose request key is already in the delivered ledger", async () => {
    const entry = pendingEntry();
    const ledger = makeFakeLedger([
      {
        taskId: "task-1",
        status: "done",
        pending: [entry],
        deliveredKeys: [completionRelayDedupeKey(entry.requestKey, "sess-r1")],
      },
    ]);
    const acp = makeFakeAcp(new Map());
    const created: Array<Record<string, unknown>> = [];
    const router = await startedRouter(makeRuntime(acp, ledger, created));

    const result = await router.sweepUndeliveredCompletionRelays();

    expect(result.reEmitted).toBe(0);
    expect(result.cleared).toBe(1);
    expect(relayTexts(created)).toEqual([]);
    expect(ledger.clearPendingCompletionRelay).toHaveBeenCalledWith(
      "task-1",
      "sess-r1",
      expect.stringContaining("dedupe"),
    );
    await router.stop();
  });

  it("clears (without posting) a terminal-failed task's pending relay", async () => {
    const ledger = makeFakeLedger([
      {
        taskId: "task-1",
        status: "failed",
        pending: [pendingEntry()],
        deliveredKeys: [],
      },
    ]);
    const created: Array<Record<string, unknown>> = [];
    const router = await startedRouter(
      makeRuntime(makeFakeAcp(new Map()), ledger, created),
    );

    const result = await router.sweepUndeliveredCompletionRelays();

    expect(result).toMatchObject({ reEmitted: 0, cleared: 1 });
    expect(relayTexts(created)).toEqual([]);
    await router.stop();
  });

  it("leaves a validating task alone while its lane is still live", async () => {
    const ledger = makeFakeLedger([
      {
        taskId: "task-1",
        status: "validating",
        pending: [pendingEntry()],
        deliveredKeys: [],
      },
    ]);
    const acp = makeFakeAcp(
      new Map([
        [
          "sess-r1",
          {
            id: "sess-r1",
            agentType: "elizaos",
            workdir: "/tmp/x",
            status: "busy",
            createdAt: new Date(),
            lastActivityAt: new Date(),
            metadata: { roomId: ROOM },
          },
        ],
      ]),
    );
    const created: Array<Record<string, unknown>> = [];
    const router = await startedRouter(makeRuntime(acp, ledger, created));

    const result = await router.sweepUndeliveredCompletionRelays();

    expect(result).toMatchObject({ reEmitted: 0, cleared: 0, skipped: 1 });
    expect(relayTexts(created)).toEqual([]);
    expect(ledger.clearPendingCompletionRelay).not.toHaveBeenCalled();
    await router.stop();
  });

  it("re-emits a validating task's relay when the lane died with the process (never-silent)", async () => {
    const ledger = makeFakeLedger([
      {
        taskId: "task-1",
        status: "validating",
        pending: [pendingEntry()],
        deliveredKeys: [],
      },
    ]);
    const created: Array<Record<string, unknown>> = [];
    const router = await startedRouter(
      makeRuntime(makeFakeAcp(new Map()), ledger, created),
    );

    const result = await router.sweepUndeliveredCompletionRelays();

    expect(result.reEmitted).toBe(1);
    expect(relayTexts(created).length).toBeGreaterThan(0);
    await router.stop();
  });
});

describe("live emit path stamping", () => {
  it("stamps pending BEFORE the post and delivered AFTER it", async () => {
    const sessionMeta = {
      roomId: ROOM,
      taskRoomId: ROOM,
      messageId: MSG,
      spawnRootMessageId: MSG,
      source: "discord",
      label: "daily-hue",
      initialTask: "Build the Daily Hue color page",
    };
    const sessions = new Map<string, Record<string, unknown>>([
      [
        "sess-live",
        {
          id: "sess-live",
          agentType: "elizaos",
          workdir: "/tmp/relay-live-test-does-not-exist",
          status: "ready",
          approvalPreset: "auto",
          createdAt: new Date(0),
          lastActivityAt: new Date(0),
          metadata: sessionMeta,
        },
      ],
    ]);
    // Task exists but has no acceptance criteria → the relay is NOT deferred
    // (immediate path), which is the leg under test.
    const ledger = makeFakeLedger([], {
      id: "task-9",
      status: "active",
      acceptanceCriteria: [],
    });
    const acp = makeFakeAcp(sessions);
    const created: Array<Record<string, unknown>> = [];
    const runtime = makeRuntime(acp, ledger, created);
    // Record post ordering relative to the ledger stamps.
    (runtime.createMemory as ReturnType<typeof vi.fn>).mockImplementation(
      async (memory: Record<string, unknown>) => {
        created.push(memory);
        ledger.calls.push("post");
        return MSG;
      },
    );
    const router = await startedRouter(runtime);

    await (router as unknown as RouterInternals).handleEvent(
      "sess-live",
      "task_complete",
      { response: "done — the page is up." },
    );

    expect(ledger.stampPendingCompletionRelay).toHaveBeenCalledTimes(1);
    expect(ledger.stampCompletionRelayDelivered).toHaveBeenCalledWith(
      "task-9",
      "sess-live",
      MSG,
    );
    const pendingAt = ledger.calls.indexOf("pending");
    const postAt = ledger.calls.indexOf("post");
    const deliveredAt = ledger.calls.indexOf("delivered");
    expect(pendingAt).toBeGreaterThanOrEqual(0);
    expect(postAt).toBeGreaterThan(pendingAt);
    expect(deliveredAt).toBeGreaterThan(postAt);
    // No restart note on a live relay.
    expect(relayTexts(created)[0]).not.toContain(
      "finished while the orchestrator was restarting",
    );
    await router.stop();
  });

  it("stamps the durable pending twin when the relay is deferred for verification", async () => {
    const sessions = new Map<string, Record<string, unknown>>([
      [
        "sess-defer",
        {
          id: "sess-defer",
          agentType: "elizaos",
          workdir: "/tmp/relay-defer-test-does-not-exist",
          status: "ready",
          approvalPreset: "auto",
          createdAt: new Date(0),
          lastActivityAt: new Date(0),
          metadata: {
            roomId: ROOM,
            taskRoomId: ROOM,
            messageId: MSG,
            source: "discord",
            label: "daily-hue",
          },
        },
      ],
    ]);
    // Criteria present + non-terminal status → the relay defers, and the
    // durable pending stamp must land even though nothing posts yet.
    const ledger = makeFakeLedger([], {
      id: "task-9",
      status: "active",
      acceptanceCriteria: ["page loads"],
    });
    const created: Array<Record<string, unknown>> = [];
    const router = await startedRouter(
      makeRuntime(makeFakeAcp(sessions), ledger, created),
    );

    await (router as unknown as RouterInternals).handleEvent(
      "sess-defer",
      "task_complete",
      { response: "done." },
    );

    expect(ledger.stampPendingCompletionRelay).toHaveBeenCalledTimes(1);
    expect(ledger.stampPendingCompletionRelay.mock.calls[0][0]).toBe("task-9");
    expect(relayTexts(created)).toEqual([]);
    expect(ledger.stampCompletionRelayDelivered).not.toHaveBeenCalled();
    await router.stop();
  });
});

describe("completion-relay ledger helpers", () => {
  it("round-trips pending and delivered stamps through the metadata bag", () => {
    const entry = pendingEntry();
    const stamped = withPendingCompletionRelay({ keep: "me" }, entry);
    expect(readPendingCompletionRelays(stamped)["sess-r1"]?.requestKey).toBe(
      MSG,
    );
    expect(stamped.keep).toBe("me");

    const delivered = withDeliveredCompletionRelay(
      stamped,
      "sess-r1",
      completionRelayDedupeKey(entry.requestKey, "sess-r1"),
    );
    expect(readPendingCompletionRelays(delivered)).toEqual({});
    expect(readDeliveredCompletionRelayKeys(delivered)).toEqual([MSG]);
    // Idempotent on the key.
    const again = withDeliveredCompletionRelay(delivered, "sess-r1", MSG);
    expect(readDeliveredCompletionRelayKeys(again)).toEqual([MSG]);

    const cleared = withoutPendingCompletionRelay(stamped, "sess-r1");
    expect(readPendingCompletionRelays(cleared)).toEqual({});
  });

  it("falls back to a session-scoped dedupe key when no request key exists", () => {
    expect(completionRelayDedupeKey(null, "sess-9")).toBe("session:sess-9");
    expect(completionRelayDedupeKey("req-1", "sess-9")).toBe("req-1");
  });

  it("drops malformed pending entries structurally", () => {
    const bag = {
      pendingCompletionRelays: {
        good: pendingEntry({ sessionId: "good" }),
        bad: { sessionId: "bad" },
        worse: "nope",
      },
    } as unknown as Record<string, unknown>;
    expect(Object.keys(readPendingCompletionRelays(bag))).toEqual(["good"]);
  });
});
