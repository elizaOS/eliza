/**
 * Verify-retry handoff must be observable BEFORE the successor spawn settles.
 *
 * Incident shape (color-pop): a task_complete's claimed URL probed dead (the
 * extractor had pulled trailing prose punctuation into the URL), so the router
 * dispatched a verify-retry. The retry subprocess took seconds to become
 * ready, and the ORIGINAL session's teardown `stopped` was processed inside
 * that window. The handed-off successor stamp only lands AFTER spawnSession
 * resolves, so every coordinator guard read pre-stamp state and synthesized a
 * false "<task> — stopped before completion." into the origin room — while
 * the retry went on to verify and PASS.
 *
 * These tests pin the two structural fixes plus the trigger:
 *  1. the router stamps a pending-handoff marker on the original session
 *     before awaiting the spawn, and resolves it on settlement (successor
 *     stamp on success, cleared on spawn failure);
 *  2. the coordinator treats a `stopped` carrying the pending marker as
 *     handoff plumbing (no synthesis, no dedupe-slot claim) while a genuine
 *     stop with no marker still synthesizes;
 *  3. trailing sentence punctuation is trimmed at the URL token boundary so a
 *     live app is never probed at a punctuation path and declared dead.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import {
  annotateUnverifiedUrls,
  SubAgentRouter,
} from "../services/sub-agent-router.ts";
import { SwarmCoordinatorService } from "../services/swarm-coordinator-service.js";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const HANDOFF_PENDING_META_KEY = "routerHandoffPendingAt";
const HANDED_OFF_SUCCESSOR_META_KEY = "handedOffToSuccessorSessionId";

type MetadataPatch = Record<string, unknown>;

function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeRouterHarness(spawn: {
  promise: Promise<{ sessionId: string }>;
}): {
  router: SubAgentRouter;
  internals: {
    retryIncompleteBuild(
      session: Record<string, unknown>,
      dead: Array<{ url: string; status: string }>,
    ): Promise<boolean>;
  };
  metadataPatches: Array<{ sessionId: string; patch: MetadataPatch }>;
} {
  const metadataPatches: Array<{ sessionId: string; patch: MetadataPatch }> =
    [];
  const acp = {
    onSessionEvent: () => () => {},
    getSession: vi.fn(async () => undefined),
    getSessions: vi.fn(async () => []),
    spawnSession: vi.fn(() => spawn.promise),
    updateSessionMetadata: vi.fn(
      async (sessionId: string, patch: MetadataPatch) => {
        metadataPatches.push({ sessionId, patch });
      },
    ),
  };
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    getService: (type: string) =>
      type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE"
        ? acp
        : undefined,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const router = new SubAgentRouter(runtime);
  return {
    router,
    internals: router as unknown as {
      retryIncompleteBuild(
        session: Record<string, unknown>,
        dead: Array<{ url: string; status: string }>,
      ): Promise<boolean>;
    },
    metadataPatches,
  };
}

function originSession(id: string): Record<string, unknown> {
  return {
    id,
    agentType: "codex",
    workdir: "/tmp/orchestrator-stop-race-test",
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata: {
      roomId: ROOM,
      label: "build color-pop",
      initialTask: "Build the app and give me the live url",
    },
  };
}

describe("router pre-stamps the handoff decision before the spawn settles", () => {
  it("writes the pending marker BEFORE spawnSession resolves, then supersedes it with the successor stamp", async () => {
    const spawn = makeDeferred<{ sessionId: string }>();
    const { internals, metadataPatches } = makeRouterHarness(spawn);

    const pending = internals.retryIncompleteBuild(originSession("sess-orig"), [
      { url: "https://example.com/apps/color-pop/!", status: "HTTP 404" },
    ]);
    await flushMicrotasks();

    // The incident window: spawn is still in flight. The decision must
    // already be observable on the ORIGINAL session's metadata.
    const preSpawn = metadataPatches.filter(
      (p) =>
        p.sessionId === "sess-orig" &&
        typeof p.patch[HANDOFF_PENDING_META_KEY] === "string",
    );
    expect(preSpawn.length).toBe(1);
    expect(
      metadataPatches.some(
        (p) => typeof p.patch[HANDED_OFF_SUCCESSOR_META_KEY] === "string",
      ),
    ).toBe(false);

    spawn.resolve({ sessionId: "sess-retry" });
    await expect(pending).resolves.toBe(true);

    // Settlement: one update carries the real successor id AND retires the
    // pending marker (no window where both are absent).
    const settled = metadataPatches.at(-1);
    expect(settled?.sessionId).toBe("sess-orig");
    expect(settled?.patch[HANDED_OFF_SUCCESSOR_META_KEY]).toBe("sess-retry");
    expect(settled?.patch[HANDOFF_PENDING_META_KEY]).toBeNull();
  });

  it("clears the pending marker when the retry spawn fails, so the honest failure path stays live", async () => {
    const spawn = makeDeferred<{ sessionId: string }>();
    const { internals, metadataPatches } = makeRouterHarness(spawn);

    const pending = internals.retryIncompleteBuild(originSession("sess-orig"), [
      { url: "https://example.com/apps/color-pop/", status: "HTTP 404" },
    ]);
    await flushMicrotasks();
    expect(
      metadataPatches.some(
        (p) => typeof p.patch[HANDOFF_PENDING_META_KEY] === "string",
      ),
    ).toBe(true);

    spawn.reject(new Error("spawn exploded"));
    await expect(pending).resolves.toBe(false);

    const settled = metadataPatches.at(-1);
    expect(settled?.sessionId).toBe("sess-orig");
    expect(settled?.patch[HANDOFF_PENDING_META_KEY]).toBeNull();
    expect(
      metadataPatches.some(
        (p) => typeof p.patch[HANDED_OFF_SUCCESSOR_META_KEY] === "string",
      ),
    ).toBe(false);
  });
});

describe("coordinator: teardown `stopped` during an in-flight handoff is plumbing", () => {
  function makeCoordinatorHarness(sessions: Map<string, unknown>): {
    service: SwarmCoordinatorService;
    emit: (sessionId: string, event: string, data: unknown) => void;
    completions: Array<{ status: string; sessionId: string }>;
  } {
    const handlers: Array<
      (sessionId: string, event: string, data: unknown) => void
    > = [];
    const acp = {
      onSessionEvent(
        handler: (sessionId: string, event: string, data: unknown) => void,
      ) {
        handlers.push(handler);
        return () => {};
      },
      getSession: async (sessionId: string) => sessions.get(sessionId),
    };
    const runtime = {
      getService: (type: string) =>
        type === AcpService.serviceType ? acp : null,
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const service = new SwarmCoordinatorService(runtime);
    (service as unknown as { bindToAcp: () => void }).bindToAcp();
    const completions: Array<{ status: string; sessionId: string }> = [];
    service.setSwarmCompleteCallback(async (payload) => {
      for (const task of payload.tasks) {
        completions.push({ status: task.status, sessionId: task.sessionId });
      }
    });
    return {
      service,
      emit: (sessionId, event, data) => {
        for (const h of [...handlers]) h(sessionId, event, data);
      },
      completions,
    };
  }

  function storedSession(
    id: string,
    metadata: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      id,
      agentType: "codex",
      workdir: "/tmp/orchestrator-stop-race-test",
      status: "stopped",
      metadata,
    };
  }

  it("does not synthesize a stop that carries the pending marker — and does not claim the dedupe slot", async () => {
    const sessions = new Map<string, unknown>([
      [
        "sess-orig",
        storedSession("sess-orig", {
          [HANDOFF_PENDING_META_KEY]: new Date().toISOString(),
        }),
      ],
    ]);
    const { service, emit, completions } = makeCoordinatorHarness(sessions);

    // The incident: teardown stop races ahead of the successor stamp.
    emit("sess-orig", "stopped", {});
    await flushMicrotasks();
    expect(completions).toEqual([]);

    // The skip must NOT claim the synthesis slot: the lineage's validated
    // completion (dispatched later against the same session) still posts.
    emit("sess-orig", "task_complete", { response: "verified live" });
    await flushMicrotasks();
    expect(completions).toEqual([
      { status: "completed", sessionId: "sess-orig" },
    ]);

    await service.stop();
  });

  it("still synthesizes a genuine stop with no marker (fail-open)", async () => {
    const sessions = new Map<string, unknown>([
      ["sess-plain", storedSession("sess-plain", {})],
    ]);
    const { service, emit, completions } = makeCoordinatorHarness(sessions);

    emit("sess-plain", "stopped", {});
    await flushMicrotasks();
    expect(completions).toEqual([
      { status: "stopped", sessionId: "sess-plain" },
    ]);

    await service.stop();
  });
});

describe("URL extraction trims trailing sentence punctuation (the cascade trigger)", () => {
  let savedSettle: string | undefined;
  let host: Server;
  let baseUrl: string;

  beforeEach(async () => {
    savedSettle = process.env.ELIZA_URL_VERIFY_SETTLE_MS;
    process.env.ELIZA_URL_VERIFY_SETTLE_MS = "0";
    host = createServer((req, res) => {
      if (req.url === "/apps/color-pop/") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("app");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    const { port } = host.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/apps/color-pop/`;
  });

  afterEach(async () => {
    if (savedSettle === undefined)
      delete process.env.ELIZA_URL_VERIFY_SETTLE_MS;
    else process.env.ELIZA_URL_VERIFY_SETTLE_MS = savedSettle;
    await new Promise<void>((resolve) => host.close(() => resolve()));
  });

  it("does not probe the trailing '!' as part of a live URL", async () => {
    // The sub-agent's prose ends the sentence with "!": the live app must be
    // verified at its real path, not declared dead at the punctuation path.
    const verified = await annotateUnverifiedUrls(
      `The app is deployed and live at ${baseUrl}!`,
      undefined,
      "Build the app and give me the live url",
    );
    expect(verified.dead).toEqual([]);
    expect(verified.verifiedUrls).toContain(baseUrl);
  });
});
