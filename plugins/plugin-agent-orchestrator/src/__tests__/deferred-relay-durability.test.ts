/**
 * Deferred completion relays survive a router restart and never fabricate a
 * verification pass. A deferral is stamped durably on the task record at
 * capture time and cleared only after the released relay posts; a new router
 * instance reconstructs pending stamps at start() (release, drop, or re-arm
 * from the task's durable state); and the fallback timeout releases with an
 * explicit `unverified` disclosure in the relay body — never verdict
 * "passed". Drives the REAL SubAgentRouter with a fake ACP service and a fake
 * in-memory task record; deterministic (fake timers for the timeout leg).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFERRED_RELAY_FALLBACK_MS,
  PENDING_COMPLETION_RELAYS_META_KEY,
  SubAgentRouter,
  UNVERIFIED_RELAY_DISCLOSURE,
} from "../services/sub-agent-router.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "task-defer-1";
const SESSION_ID = "sess-defer-1";

type RouterInternals = {
  handleEvent(sessionId: string, event: string, data: unknown): Promise<void>;
  deferredCompletionRelays: Map<string, { sessionId: string }>;
};

interface FakeTaskRecord {
  id: string;
  status: string;
  acceptanceCriteria: string[];
  metadata: Record<string, unknown>;
}

function makeTaskService(record: FakeTaskRecord) {
  return {
    getTaskForSession: vi.fn(async () => record),
    getTask: vi.fn(async (taskId: string) =>
      taskId === record.id ? record : null,
    ),
    listTasks: vi.fn(async () => [{ id: record.id, status: record.status }]),
    updateTask: vi.fn(
      async (taskId: string, patch: { metadata?: Record<string, unknown> }) => {
        if (taskId !== record.id) return null;
        if (patch.metadata) record.metadata = patch.metadata;
        return record;
      },
    ),
  };
}

function makeSession(): Record<string, unknown> {
  return {
    id: SESSION_ID,
    agentType: "codex",
    name: "Defer",
    workdir: "/tmp/deferred-relay-durability-test",
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata: {
      roomId: ROOM,
      taskRoomId: ROOM,
      messageId: MSG,
      source: "discord",
      label: "quotes-page",
      initialTask: "Build the quotes page",
    },
  };
}

function makeAcp(sessions: Map<string, Record<string, unknown>>) {
  return {
    onSessionEvent: vi.fn(() => () => {}),
    getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId)),
    getSessions: vi.fn(async () => [...sessions.values()]),
    getChangedPaths: vi.fn(() => [] as string[]),
    spawnSession: vi.fn(async () => ({ sessionId: "retry-1" })),
    stopSession: vi.fn(async () => undefined),
    updateSessionMetadata: vi.fn(async () => undefined),
  };
}

function makeRuntime(
  acp: ReturnType<typeof makeAcp>,
  tasks: ReturnType<typeof makeTaskService>,
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
      if (type === "ORCHESTRATOR_TASK_SERVICE") return tasks;
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

function relayTexts(created: Array<Record<string, unknown>>): string[] {
  return created
    .map((m) => (m.content as { text?: string } | undefined)?.text ?? "")
    .filter((text) => text.includes("[sub-agent"));
}

function stamps(record: FakeTaskRecord): Record<string, unknown> {
  const raw = record.metadata[PENDING_COMPLETION_RELAYS_META_KEY];
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

interface Harness {
  router: SubAgentRouter;
  internals: RouterInternals;
  created: Array<Record<string, unknown>>;
  record: FakeTaskRecord;
  tasks: ReturnType<typeof makeTaskService>;
}

async function makeHarness(record: FakeTaskRecord): Promise<Harness> {
  const sessions = new Map([[SESSION_ID, makeSession()]]);
  const acp = makeAcp(sessions);
  const tasks = makeTaskService(record);
  const created: Array<Record<string, unknown>> = [];
  const runtime = makeRuntime(acp, tasks, created);
  const router = new SubAgentRouter(runtime);
  await router.start();
  return {
    router,
    internals: router as unknown as RouterInternals,
    created,
    record,
    tasks,
  };
}

function activeRecord(
  metadata: Record<string, unknown> = {},
  status = "active",
): FakeTaskRecord {
  return {
    id: TASK_ID,
    status,
    acceptanceCriteria: ["the page renders"],
    metadata,
  };
}

function stampFor(deferredAt: string): Record<string, unknown> {
  return {
    [PENDING_COMPLETION_RELAYS_META_KEY]: {
      [SESSION_ID]: {
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        deferredAt,
        data: {
          response: "The quotes page is ready.",
          stopReason: "end_turn",
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("deferral stamps the pending relay durably", () => {
  it("defer writes the task stamp; a passed release posts and clears it", async () => {
    const h = await makeHarness(activeRecord());
    await h.internals.handleEvent(SESSION_ID, "task_complete", {
      response: "The quotes page is ready.",
      stopReason: "end_turn",
    });
    // Held, not relayed — and durably stamped for restart recovery.
    expect(relayTexts(h.created)).toHaveLength(0);
    const stamp = stamps(h.record)[SESSION_ID] as Record<string, unknown>;
    expect(stamp).toBeDefined();
    expect(stamp.taskId).toBe(TASK_ID);
    expect(stamp.sessionId).toBe(SESSION_ID);
    expect(typeof stamp.deferredAt).toBe("string");
    expect(stamp.data).toMatchObject({
      response: "The quotes page is ready.",
    });

    h.router.releaseDeferredCompletionRelay(TASK_ID, "passed", SESSION_ID);
    await waitFor(() => relayTexts(h.created).length > 0);
    const texts = relayTexts(h.created);
    expect(texts.join("\n")).toContain("quotes page");
    // A verdict-released relay carries no unverified disclosure.
    expect(texts.join("\n")).not.toContain(UNVERIFIED_RELAY_DISCLOSURE);
    // The durable stamp is cleared only after the relay posted.
    await waitFor(() => stamps(h.record)[SESSION_ID] === undefined);
    await h.router.stop();
  });

  it("a failed verdict drops the relay and clears the stamp", async () => {
    const h = await makeHarness(activeRecord());
    await h.internals.handleEvent(SESSION_ID, "task_complete", {
      response: "The quotes page is ready.",
      stopReason: "end_turn",
    });
    expect(stamps(h.record)[SESSION_ID]).toBeDefined();

    h.router.releaseDeferredCompletionRelay(TASK_ID, "failed", SESSION_ID);
    await waitFor(() => stamps(h.record)[SESSION_ID] === undefined);
    expect(relayTexts(h.created)).toHaveLength(0);
    await h.router.stop();
  });
});

describe("the fallback timeout never fabricates a pass", () => {
  it("releases with verdict unverified and disclosure in the relay body", async () => {
    vi.useFakeTimers();
    const h = await makeHarness(activeRecord());
    await h.internals.handleEvent(SESSION_ID, "task_complete", {
      response: "The quotes page is ready.",
      stopReason: "end_turn",
    });
    expect(relayTexts(h.created)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEFERRED_RELAY_FALLBACK_MS);
    // The release chain is promise-based; drain it under fake timers.
    await vi.advanceTimersByTimeAsync(1000);
    const texts = relayTexts(h.created);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.join("\n")).toContain(UNVERIFIED_RELAY_DISCLOSURE);
    expect(texts.join("\n")).toContain(
      "verification did not complete — result delivered unverified",
    );
    await h.router.stop();
  });
});

describe("restart reconstructs pending relays from durable stamps", () => {
  it("a stamp past its fallback window releases unverified on start()", async () => {
    const past = new Date(
      Date.now() - DEFERRED_RELAY_FALLBACK_MS - 60_000,
    ).toISOString();
    // Fresh router instance: nothing in memory, only the durable stamp.
    const h = await makeHarness(activeRecord(stampFor(past), "validating"));
    await waitFor(() => relayTexts(h.created).length > 0);
    const texts = relayTexts(h.created);
    expect(texts.join("\n")).toContain("quotes page");
    expect(texts.join("\n")).toContain(UNVERIFIED_RELAY_DISCLOSURE);
    await waitFor(() => stamps(h.record)[SESSION_ID] === undefined);
    await h.router.stop();
  });

  it("a stamp on a done task releases as passed (durable verdict, no disclosure)", async () => {
    const past = new Date(
      Date.now() - DEFERRED_RELAY_FALLBACK_MS - 60_000,
    ).toISOString();
    const h = await makeHarness(activeRecord(stampFor(past), "done"));
    await waitFor(() => relayTexts(h.created).length > 0);
    expect(relayTexts(h.created).join("\n")).not.toContain(
      UNVERIFIED_RELAY_DISCLOSURE,
    );
    await waitFor(() => stamps(h.record)[SESSION_ID] === undefined);
    await h.router.stop();
  });

  it("a stamp on a parked task is dropped, never relayed", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const h = await makeHarness(activeRecord(stampFor(past), "parked"));
    await waitFor(() => stamps(h.record)[SESSION_ID] === undefined);
    expect(relayTexts(h.created)).toHaveLength(0);
    await h.router.stop();
  });

  it("a stamp still inside its window re-arms instead of posting", async () => {
    const fresh = new Date(Date.now() - 1000).toISOString();
    const h = await makeHarness(activeRecord(stampFor(fresh), "validating"));
    const deferKey = `${TASK_ID}\u0000${SESSION_ID}`;
    await waitFor(() => h.internals.deferredCompletionRelays.has(deferKey));
    // Held (no relay), stamp intact — the verdict can still release it.
    expect(relayTexts(h.created)).toHaveLength(0);
    expect(stamps(h.record)[SESSION_ID]).toBeDefined();

    h.router.releaseDeferredCompletionRelay(TASK_ID, "passed", SESSION_ID);
    await waitFor(() => relayTexts(h.created).length > 0);
    expect(relayTexts(h.created).join("\n")).not.toContain(
      UNVERIFIED_RELAY_DISCLOSURE,
    );
    await h.router.stop();
  });
});
