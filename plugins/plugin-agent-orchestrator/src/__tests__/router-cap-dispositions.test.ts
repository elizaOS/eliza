/**
 * Cap-disposition regressions for SubAgentRouter (prompt-integrity invariant):
 *  - the parent-agent directive buffer REJECTS an over-16KB streaming envelope
 *    with an explicit in-session notice instead of silently slicing off the
 *    USE_SKILL marker (which made the directive vanish);
 *  - observeWorkdirDeliverable narrates the COMPLETE observed file list and
 *    EVERY route-mapped directory URL (the old slice(0,8)/slice(0,1) let the
 *    planner treat a visible subset as the whole deliverable);
 *  - the origin's best captured result is persisted to the task record as
 *    metadata.canonicalBestResult at capture time (durable twin of the
 *    volatile FIFO-bounded map).
 * Real SubAgentRouter + real fs; fake ACP service and runtime, no live model.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../services/types.ts";
import {
  observeWorkdirDeliverable,
  SubAgentRouter,
} from "../services/sub-agent-router.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

type RouterInternals = {
  handleEvent(sessionId: string, event: string, data: unknown): Promise<void>;
};

function makeFakeAcp(sessions: Map<string, Record<string, unknown>>) {
  const sendToSession = vi.fn(async () => undefined);
  const service = {
    onSessionEvent(_cb: unknown) {
      return () => undefined;
    },
    getSession: vi.fn(async (sessionId: string) => sessions.get(sessionId)),
    getSessions: vi.fn(async () => [...sessions.values()]),
    getChangedPaths: vi.fn(() => [] as string[]),
    spawnSession: vi.fn(async () => ({ sessionId: "retry-1" })),
    stopSession: vi.fn(async () => undefined),
    updateSessionMetadata: vi.fn(async () => undefined),
    sendToSession,
  };
  return { service, sendToSession };
}

function makeRuntime(
  acp: ReturnType<typeof makeFakeAcp>["service"],
  tasksService?: unknown,
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    getService: (type: string) => {
      if (type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE")
        return acp;
      if (type === "ORCHESTRATOR_TASK_SERVICE") return tasksService;
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

function sessionInfo(
  id: string,
  workdir: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    agentType: "codex",
    name: "Ada",
    workdir,
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  vi.restoreAllMocks();
});

async function startRouter(
  sessions: Map<string, Record<string, unknown>>,
  tasksService?: unknown,
): Promise<{
  router: SubAgentRouter;
  internals: RouterInternals;
  acp: ReturnType<typeof makeFakeAcp>;
  runtime: IAgentRuntime;
}> {
  const acp = makeFakeAcp(sessions);
  const runtime = makeRuntime(acp.service, tasksService);
  const router = new SubAgentRouter(runtime);
  await router.start();
  cleanups.push(() => router.stop());
  return {
    router,
    internals: router as unknown as RouterInternals,
    acp,
    runtime,
  };
}

describe("parent-agent directive buffer overflow (typed pre-dispatch REJECT)", () => {
  it("rejects a >16KB streaming envelope with an explicit in-session notice", async () => {
    const sessions = new Map<string, Record<string, unknown>>([
      ["sess-pa", sessionInfo("sess-pa", "/tmp/pa-test", { roomId: ROOM })],
    ]);
    const { internals, acp } = await startRouter(sessions);

    // Marker + opening JSON, still streaming (no closing brace), under cap.
    await internals.handleEvent("sess-pa", "message", {
      text: `USE_SKILL parent-agent {"mode":"ask","q":"${"x".repeat(10_000)}`,
    });
    expect(acp.sendToSession).not.toHaveBeenCalled();

    // Next chunk pushes the envelope over 16KB before the JSON completes:
    // typed rejection, not a silent head-slice that severs the marker.
    await internals.handleEvent("sess-pa", "message", {
      text: "y".repeat(8_000),
    });
    expect(acp.sendToSession).toHaveBeenCalledTimes(1);
    const [sessionId, notice] = acp.sendToSession.mock.calls[0] as [
      string,
      string,
    ];
    expect(sessionId).toBe("sess-pa");
    expect(notice).toContain("exceeded 16384 characters");
    expect(notice).toContain("NOT dispatched");
  });
});

describe("observeWorkdirDeliverable completeness", () => {
  it("narrates every observed file (with count + workdir) and every directory URL", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "observe-workdir-"));
    cleanups.push(() => fs.rmSync(workdir, { recursive: true, force: true }));
    const names = Array.from({ length: 10 }, (_, i) => `file-${i}.txt`);
    for (const name of names) {
      fs.writeFileSync(path.join(workdir, name), "content", "utf8");
    }
    for (const dir of ["alpha", "beta"]) {
      fs.mkdirSync(path.join(workdir, dir));
      fs.writeFileSync(path.join(workdir, dir, "index.html"), "<p>ok</p>");
    }
    const session = sessionInfo("sess-obs", workdir, {
      workdirRoute: {
        urlMappings: [
          { urlPrefix: "https://example.test/apps/demo", localPath: "" },
        ],
      },
    }) as unknown as SessionInfo;

    const lines = observeWorkdirDeliverable(session);
    const fileLine = lines[0];
    // Every observed name is present — no silent first-8 cap.
    for (const name of names) expect(fileLine).toContain(name);
    expect(fileLine).toContain("12 file(s)");
    expect(fileLine).toContain(workdir);
    // Structural marker the completion evaluator keys on stays intact.
    expect(fileLine).toContain("Files written (verified on disk)");
    // BOTH route-mapped directory URLs are narrated — no first-URL-only cap.
    expect(lines).toContain("https://example.test/apps/demo/alpha/");
    expect(lines).toContain("https://example.test/apps/demo/beta/");
  });
});

describe("canonicalBestResult durable persistence at capture time", () => {
  it("persists the captured best result onto the task record's metadata", async () => {
    const originMeta = {
      roomId: ROOM,
      taskRoomId: ROOM,
      messageId: MSG,
      originConnectorMessageId: "disc-canonical-1",
      spawnRootMessageId: MSG,
      source: "discord",
      label: "compute 12!",
      initialTask: "compute 12 factorial and report the number",
    };
    const sessions = new Map<string, Record<string, unknown>>([
      ["sess-c", sessionInfo("sess-c", "/tmp/canonical-test", originMeta)],
    ]);
    const updateTask = vi.fn(async () => ({}));
    const tasksService = {
      getTaskForSession: vi.fn(async () => ({
        id: "task-77",
        status: "running",
        metadata: { keepMe: true },
      })),
      updateTask,
    };
    const { internals, router } = await startRouter(sessions, tasksService);

    await internals.handleEvent("sess-c", "task_complete", {
      response: "479001600 (the full answer)",
      stopReason: "end_turn",
    });
    // The persistence write is fire-and-forget; let its microtasks settle.
    await vi.waitFor(() => expect(updateTask).toHaveBeenCalled());

    const [taskId, patch] = updateTask.mock.calls[0] as [
      string,
      { metadata: Record<string, unknown> },
    ];
    expect(taskId).toBe("task-77");
    // Existing metadata is preserved; the canonical record is added.
    expect(patch.metadata.keepMe).toBe(true);
    const canonical = patch.metadata.canonicalBestResult as Record<
      string,
      unknown
    >;
    expect(canonical.originKey).toBe("disc-canonical-1\0codex");
    expect(String(canonical.text)).toContain("479001600");
    expect(canonical.sessionId).toBe("sess-c");
    expect(typeof canonical.capturedAt).toBe("string");
    // The volatile fast path agrees with the durable record.
    expect(router.bestResultFor("disc-canonical-1\0codex")?.text).toContain(
      "479001600",
    );
  });
});
