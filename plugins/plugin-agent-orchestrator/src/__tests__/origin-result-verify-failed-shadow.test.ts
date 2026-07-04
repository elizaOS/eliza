/**
 * Verify-FAILED completions must not become the origin's relayable best result.
 *
 * 35a9e8163a (#11514) added captureOriginResultForCompletion on the router's
 * task_complete early returns so a finished deliverable survives to the spawn
 * cap. But the verify-retry handoff records a completion the router itself has
 * just judged a FAILED build (deadUrls > 0): the narration carries the
 * dead-URL verification annotation, which systematically makes it LONGER than
 * a clean success text, so recordOriginResult's longest-wins keeps the failure
 * and the successful retry's shorter completion can never displace it. At the
 * per-origin spawn cap, tasks.ts then relays that failed text — the dead-URL
 * claim plus the planner-only "[verification: … do NOT tell the user the app
 * is live …]" directive — verbatim to the user as the final answer.
 * Longest-wins is not correctness-wins: a known-failed result is not a
 * deliverable.
 *
 * These tests drive the REAL handleEvent (fake ACP service) through the exact
 * two-attempt lineage and pin:
 *  1. the verify-retry handoff does NOT record the verify-failed completion;
 *  2. after the successful retry completes, bestResultFor is the retry's
 *     clean result, never the shadowing failure;
 *  3. the TASKS spawn-cap branch never relays the verification-failure text.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tasksAction } from "../actions/tasks.ts";
import {
  SubAgentRouter,
  sanitizeSuccessorMetadata,
} from "../services/sub-agent-router.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

/** A REAL local app host whose deploy state the test controls: 404 until the
 *  build "lands" (attempt 1's dead URL), 200 HTML afterwards (attempt 2's
 *  verified live URL) — the exact liveness transition of a failed build
 *  followed by a successful verify-retry. */
async function startAppHost(): Promise<{
  url: string;
  markBuilt: () => void;
  close: () => Promise<void>;
}> {
  let built = false;
  const server: Server = createServer((_req, res) => {
    if (!built) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>game</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/apps/game/index.html`,
    markBuilt: () => {
      built = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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
    workdir: "/tmp/orchestrator-verify-shadow-test",
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata,
  };
}

/** Origin metadata as TASKS op=spawn_agent stamps it (connector id optional —
 *  dashboard/web spawns only carry the spawn-root message id). */
function originMeta(
  msgId: string,
  appUrl: string,
  connectorId?: string,
): Record<string, unknown> {
  return {
    roomId: ROOM,
    taskRoomId: ROOM,
    messageId: msgId,
    ...(connectorId ? { originConnectorMessageId: connectorId } : {}),
    spawnRootMessageId: msgId,
    source: "discord",
    label: "build game",
    initialTask: `Deploy the game and give me the live url ${appUrl}`,
  };
}

async function startRouter(
  sessions: Map<string, Record<string, unknown>>,
  settings: Record<string, string> = {},
): Promise<{
  router: SubAgentRouter;
  internals: RouterInternals;
  acp: ReturnType<typeof makeFakeAcp>;
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

/** Drive the REAL two-attempt lineage against a REAL local app host:
 *  attempt 1 completes while the claimed URL 404s → verify-retry handoff;
 *  the retry "deploys" (host flips to 200) and attempt 2 (the successor,
 *  real metadata shape from retryIncompleteBuild) completes verified. */
async function runFailedThenCleanLineage(
  msgId: string,
  connectorId?: string,
): Promise<{
  router: SubAgentRouter;
  runtime: IAgentRuntime;
  acp: ReturnType<typeof makeFakeAcp>;
  betweenAttempts: { text: string; deliverable?: string } | undefined;
  originKey: string;
}> {
  const host = await startAppHost();
  try {
    const meta = originMeta(msgId, host.url, connectorId);
    const sessions = new Map<string, Record<string, unknown>>([
      ["sess-fail", sessionInfo("sess-fail", { ...meta })],
    ]);
    const { router, internals, acp, runtime } = await startRouter(sessions, {
      ELIZA_URL_VERIFY_SETTLE_MS: "0",
    });

    // Attempt 1: a VERBOSE completion claiming the still-404 URL. The
    // verifier flags it (annotation appended → even longer),
    // retryIncompleteBuild spawns the retry, and the handler takes the
    // verify-retry handoff early return.
    await internals.handleEvent("sess-fail", "task_complete", {
      response: `The game is fully built and deployed. I created index.html, style.css and game.js, wired up the scoreboard and the restart button, and the app is now live at ${host.url} — open it in your browser to play.`,
      stopReason: "end_turn",
    });
    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    expect(runtime.emitEvent).not.toHaveBeenCalled();

    const originKey = `${connectorId ?? msgId}\0codex`;
    const betweenAttempts = router.bestResultFor(originKey);

    // The retry actually deploys the files: the claimed URL goes live.
    host.markBuilt();

    // Attempt 2: the retry successor completes; the verifier re-probes the
    // task URL, gets a real 200, and the completion flows through the normal
    // claim → record → delivery path.
    sessions.set(
      "retry-1",
      sessionInfo("retry-1", {
        ...sanitizeSuccessorMetadata(meta),
        buildVerifyRetryCount: 1,
        keepAliveAfterComplete: false,
        retryOfSessionId: "sess-fail",
      }),
    );
    await internals.handleEvent("retry-1", "task_complete", {
      response: `Recreated the missing files; the game is live at ${host.url}`,
      stopReason: "end_turn",
    });
    expect(mockCallCount(runtime.emitEvent)).toBeGreaterThan(0);

    return { router, runtime, acp, betweenAttempts, originKey };
  } finally {
    await host.close();
  }
}

describe("verify-failed completion must not shadow the successful retry", () => {
  it("does not record the verify-failed completion as the origin best result", async () => {
    const { router, betweenAttempts, originKey } =
      await runFailedThenCleanLineage(MSG, "disc-shadow-1");
    // The router itself judged attempt 1 a failed build (dead URL) — it must
    // not have become the origin's relayable best result.
    expect(betweenAttempts).toBeUndefined();
    // And the retained result after the retry is the retry's CLEAN completion:
    // no dead-URL verification annotation, no planner-only directive.
    const best = router.bestResultFor(originKey);
    expect(best).toBeDefined();
    expect(best?.text).not.toContain("NOT reachable");
    expect(best?.text).not.toContain("[verification:");
    await router.stop();
  });
});

describe("spawn-cap relay after a verify-failed attempt (TASKS spawn_agent)", () => {
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
      content: { text: "build me a game", metadata: {} },
    } as unknown as Memory;
  }

  async function runCappedSpawn(
    router: SubAgentRouter,
    msgId: string,
  ): Promise<string> {
    const { service } = makeFakeAcp(new Map());
    const runtime = makeRuntime(service, router, {
      // Hermetic: ignore any ambient adapter pin + skip task-room minting.
      ELIZA_AGENT_SELECTION_STRATEGY: "dynamic",
      ELIZA_ORCHESTRATOR_TASK_ROOMS: "0",
    });
    let replyText = "";
    await tasksAction.handler(
      runtime,
      capMessage(msgId),
      undefined as unknown as State,
      {
        parameters: {
          action: "spawn_agent",
          agentType: "codex",
          task: "build me a game",
        },
      },
      async (content) => {
        if (typeof content.text === "string") replyText = content.text;
        return [];
      },
    );
    return replyText;
  }

  it("never relays the verification-failure text as the final answer", async () => {
    // Connector-less origin: the cap key and the router's origin-result key
    // both collapse to the user message id (#8875).
    const msgId = "55555555-5555-4555-8555-555555555555";
    const { router, originKey } = await runFailedThenCleanLineage(msgId);

    router.noteSpawnForOrigin(originKey);
    router.noteSpawnForOrigin(originKey);
    router.noteSpawnForOrigin(originKey); // default cap = 3 → next spawn capped

    const replyText = await runCappedSpawn(router, msgId);
    // The user must never receive the dead-URL completion the router judged a
    // failed build (nor its planner-only verification directive).
    expect(replyText).not.toContain("NOT reachable");
    expect(replyText).not.toContain("[verification:");
    expect(replyText.length).toBeGreaterThan(0);
    await router.stop();
  });
});
