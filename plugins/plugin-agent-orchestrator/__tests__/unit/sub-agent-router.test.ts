import type { Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractSubResources,
  normalizeUrlsInText,
  SubAgentRouter,
} from "../../src/services/sub-agent-router.js";
import type { SessionInfo } from "../../src/services/types.js";

const ROOM = "11111111-2222-3333-4444-555555555555";
const WORLD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER = "ffffffff-1111-2222-3333-444444444444";
const PARENT_MSG = "99999999-8888-7777-6666-555555555555";
const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";

interface CapturedHandler {
  fn?: (sessionId: string, event: string, data: unknown) => void;
}

function makeAcpService(session: SessionInfo): {
  service: {
    onSessionEvent: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
  };
  emit: (sessionId: string, event: string, data: unknown) => void;
} {
  const captured: CapturedHandler = {};
  const service = {
    onSessionEvent: vi.fn((handler: typeof captured.fn) => {
      captured.fn = handler;
      return () => {
        captured.fn = undefined;
      };
    }),
    getSession: vi.fn(async (id: string) =>
      id === session.id ? session : null,
    ),
    listSessions: vi.fn(async () => [session]),
  };
  return {
    service,
    emit(sessionId: string, event: string, data: unknown) {
      captured.fn?.(sessionId, event, data);
    },
  };
}

function makeRuntime(opts: {
  acp: unknown;
  agentId?: string;
  setting?: Record<string, string | undefined>;
}) {
  const handleMessage = vi.fn<
    (runtime: unknown, memory: Memory) => Promise<unknown>
  >(async () => ({}));
  const createMemory = vi.fn(async () => undefined);
  const createEntity = vi.fn(async () => true);
  const addParticipant = vi.fn(async () => true);
  const emitEvent = vi.fn<
    (name: string, payload: { source: string }) => Promise<void>
  >(async () => undefined);
  // The router binds two independent event sources: ACP_SUBPROCESS_SERVICE
  // and PTY_SERVICE. These tests drive the ACP path, so PTY is a no-op stub
  // that still binds cleanly — both sources bound means no bind-retry timer
  // is left dangling after the test. spawnSession backs the verify-retry
  // path (router re-dispatches a sub-agent on a failed verification).
  const spawnSession = vi.fn(async (o: { workdir?: string }) => ({
    sessionId: "retry-session-id",
    id: "retry-session-id",
    name: "retry",
    agentType: "opencode",
    workdir: o.workdir ?? "/tmp/wf",
    status: "ready",
  }));
  const ptyService = {
    onSessionEvent: vi.fn(() => () => undefined),
    spawnSession,
  };
  const runtime = {
    agentId: opts.agentId ?? "00000000-0000-0000-0000-000000000001",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getService: vi.fn((name: string) =>
      name === "PTY_SERVICE" ? ptyService : (opts.acp ?? null),
    ),
    getSetting: vi.fn((k: string) => opts.setting?.[k]),
    createMemory,
    createEntity,
    addParticipant,
    emitEvent,
    messageService: { handleMessage },
  } as never;
  return {
    runtime,
    handleMessage,
    createMemory,
    createEntity,
    addParticipant,
    emitEvent,
    spawnSession,
  };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = new Date("2026-05-07T12:00:00.000Z");
  return {
    id: SESSION_ID,
    name: "demo-task",
    agentType: "codex",
    workdir: "/tmp/wf",
    status: "ready",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: {
      label: "fix-bug-42",
      roomId: ROOM,
      worldId: WORLD,
      userId: USER,
      messageId: PARENT_MSG,
      source: "telegram",
    },
    ...overrides,
  };
}

describe("SubAgentRouter", () => {
  let session: SessionInfo;
  let acp: ReturnType<typeof makeAcpService>;

  beforeEach(() => {
    session = makeSession();
    acp = makeAcpService(session);
  });

  it("posts a synthetic memory back to the origin room on task_complete", async () => {
    const { runtime, handleMessage, createMemory, createEntity } = makeRuntime({
      acp: acp.service,
    });
    const router = await SubAgentRouter.start(runtime);
    expect(acp.service.onSessionEvent).toHaveBeenCalledTimes(1);

    acp.emit(SESSION_ID, "task_complete", {
      response: "PR opened: github.com/foo/bar/pull/42",
      durationMs: 1234,
    });
    await new Promise((r) => setImmediate(r));

    // The sub-agent entity is created so the memory FK resolves, and the
    // post is delivered via messageService.handleMessage — which persists
    // the memory itself, so the router must NOT also call createMemory
    // (a double-save collides on the primary key).
    expect(createEntity).toHaveBeenCalledTimes(1);
    expect(createMemory).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const posted = handleMessage.mock.calls[0]?.[1];
    if (!posted) throw new Error("expected handleMessage to receive a memory");
    expect(posted.roomId).toBe(ROOM);
    expect(posted.worldId).toBe(WORLD);
    expect(posted.content?.source).toBe("sub_agent");
    expect(posted.content?.inReplyTo).toBe(PARENT_MSG);
    const metadata = posted.content?.metadata as Record<string, unknown>;
    expect(metadata?.subAgent).toBe(true);
    expect(metadata?.subAgentSessionId).toBe(SESSION_ID);
    expect(metadata?.subAgentEvent).toBe("task_complete");
    expect(metadata?.originUserId).toBe(USER);
    expect(typeof posted.content?.text).toBe("string");
    expect(posted.content?.text).toContain("PR opened");

    await router.stop();
  });

  it("does not inject for streaming events like agent_message_chunk", async () => {
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "agent_message_chunk", { delta: "thinking…" });
    acp.emit(SESSION_ID, "tool_running", { tool: "Bash" });
    acp.emit(SESSION_ID, "ready", {});
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("dedups duplicate task_complete events with the same payload", async () => {
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "done", durationMs: 1 });
    acp.emit(SESSION_ID, "task_complete", { response: "done", durationMs: 1 });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("does NOT dedup task_complete with a different response", async () => {
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "first" });
    await new Promise((r) => setImmediate(r));
    acp.emit(SESSION_ID, "task_complete", { response: "second" });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it("skips sessions without origin metadata (no roomId)", async () => {
    session = makeSession({ metadata: { label: "no-origin" } });
    acp = makeAcpService(session);
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "ignored" });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("can be disabled via ACPX_SUB_AGENT_ROUTER_DISABLED", async () => {
    const { runtime, handleMessage } = makeRuntime({
      acp: acp.service,
      setting: { ACPX_SUB_AGENT_ROUTER_DISABLED: "1" },
    });
    await SubAgentRouter.start(runtime);

    expect(acp.service.onSessionEvent).not.toHaveBeenCalled();
    acp.emit(SESSION_ID, "task_complete", { response: "ignored" });
    await new Promise((r) => setImmediate(r));
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("handles error events with a useful narration", async () => {
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "error", {
      message: "acpx exited with code 137 (oom)",
    });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).toHaveBeenCalledTimes(1);
    const posted = handleMessage.mock.calls[0]?.[1];
    if (!posted) throw new Error("expected handleMessage to receive a memory");
    expect(posted.content?.text).toContain("acpx exited with code 137");
    expect(
      (posted.content?.metadata as Record<string, unknown>)?.subAgentEvent,
    ).toBe("error");
  });

  it("falls back to MESSAGE_RECEIVED emit if messageService is missing", async () => {
    const { runtime, emitEvent } = makeRuntime({ acp: acp.service });
    delete (runtime as { messageService?: unknown }).messageService;
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "fallback" });
    await new Promise((r) => setImmediate(r));

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const call = emitEvent.mock.calls[0];
    if (!call) throw new Error("expected emitEvent to receive a call");
    expect(call[0]).toBe("MESSAGE_RECEIVED");
    expect((call[1] as { source: string }).source).toBe("sub_agent");
  });

  it("unsubscribes on stop()", async () => {
    const { runtime, handleMessage } = makeRuntime({ acp: acp.service });
    const router = await SubAgentRouter.start(runtime);
    await router.stop();

    acp.emit(SESSION_ID, "task_complete", { response: "after-stop" });
    await new Promise((r) => setImmediate(r));

    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("caps round-trips at ACPX_SUB_AGENT_ROUND_TRIP_CAP and force-stops", async () => {
    const stopSession = vi.fn(async () => undefined);
    const acpWithStop = {
      ...acp.service,
      stopSession,
    } as Parameters<typeof makeRuntime>[0]["acp"];
    const { runtime, handleMessage } = makeRuntime({
      acp: acpWithStop,
      setting: { ACPX_SUB_AGENT_ROUND_TRIP_CAP: "3" },
    });
    await SubAgentRouter.start(runtime);

    // 4 distinct task_complete payloads — first 3 deliver, 4th is the cap.
    for (let i = 0; i < 4; i++) {
      acp.emit(SESSION_ID, "task_complete", { response: `iter-${i}` });
      await new Promise((r) => setImmediate(r));
    }

    expect(handleMessage).toHaveBeenCalledTimes(4);
    expect(stopSession).toHaveBeenCalledWith(SESSION_ID);
    const last = handleMessage.mock.calls[3]?.[1];
    if (!last) throw new Error("expected 4th memory");
    const meta = last.content?.metadata as Record<string, unknown>;
    expect(meta?.subAgentCapExceeded).toBe(true);
    expect(meta?.subAgentEvent).toBe("round_trip_cap_exceeded");
    expect(meta?.subAgentRoundTrip).toBe(4);
    expect(meta?.subAgentRoundTripCap).toBe(3);
    expect(last.content?.text).toContain("round-trip cap exceeded");
  });

  it("does not re-fire cap notice if more events arrive after cap exceeded", async () => {
    const stopSession = vi.fn(async () => undefined);
    const acpWithStop = {
      ...acp.service,
      stopSession,
    } as Parameters<typeof makeRuntime>[0]["acp"];
    const { runtime, handleMessage } = makeRuntime({
      acp: acpWithStop,
      setting: { ACPX_SUB_AGENT_ROUND_TRIP_CAP: "1" },
    });
    await SubAgentRouter.start(runtime);

    acp.emit(SESSION_ID, "task_complete", { response: "first" });
    await new Promise((r) => setImmediate(r));
    acp.emit(SESSION_ID, "task_complete", { response: "second" });
    await new Promise((r) => setImmediate(r));
    acp.emit(SESSION_ID, "task_complete", { response: "third" });
    await new Promise((r) => setImmediate(r));

    // first delivers, second triggers cap-exceeded notice (and stop), third is suppressed.
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledTimes(1);
  });

  describe("verify-retry on incomplete builds", () => {
    const origMax = process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES;
    const origSettle = process.env.ELIZA_URL_VERIFY_SETTLE_MS;

    beforeEach(() => {
      // Disable the settle-retry so the dead-URL probe is a single fast
      // connection-refused rather than a 2.5s wait.
      process.env.ELIZA_URL_VERIFY_SETTLE_MS = "0";
      delete process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES;
    });
    afterEach(() => {
      if (origMax === undefined)
        delete process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES;
      else process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES = origMax;
      if (origSettle === undefined)
        delete process.env.ELIZA_URL_VERIFY_SETTLE_MS;
      else process.env.ELIZA_URL_VERIFY_SETTLE_MS = origSettle;
      vi.unstubAllGlobals();
    });

    // A localhost port that reliably refuses — fast, no external network.
    const DEAD_URL = "http://127.0.0.1:1/apps/x/";

    function sessionWithTask(
      initialTask: string,
      retryCount?: number,
      extraMetadata: Record<string, unknown> = {},
    ): SessionInfo {
      return makeSession({
        metadata: {
          label: "build-app",
          roomId: ROOM,
          worldId: WORLD,
          userId: USER,
          messageId: PARENT_MSG,
          source: "telegram",
          initialTask,
          ...(retryCount !== undefined
            ? { buildVerifyRetryCount: retryCount }
            : {}),
          ...extraMetadata,
        },
      });
    }

    it("re-dispatches a sub-agent when a claimed URL is unreachable", async () => {
      session = sessionWithTask(`build a calculator at ${DEAD_URL}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — the app is live at ${DEAD_URL}`,
      });
      await new Promise((r) => setTimeout(r, 1000));

      expect(spawnSession).toHaveBeenCalledTimes(1);
      const arg = spawnSession.mock.calls[0]?.[0] as {
        initialTask?: string;
        metadata?: Record<string, unknown>;
      };
      expect(arg?.initialTask).toContain("VERIFICATION FEEDBACK");
      expect(arg?.initialTask).toContain("build a calculator");
      expect(arg?.metadata?.buildVerifyRetryCount).toBe(1);
      // A retry was spawned → the failure is NOT posted to the parent yet;
      // the retry's own task_complete will report the outcome.
      expect(handleMessage).not.toHaveBeenCalled();
    });

    it("stops retrying once the budget is exhausted and posts honestly", async () => {
      // Already at the default max (2) → no further retry.
      session = sessionWithTask(`build it at ${DEAD_URL}`, 2);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — live at ${DEAD_URL}`,
      });
      await new Promise((r) => setTimeout(r, 1000));

      expect(spawnSession).not.toHaveBeenCalled();
      // Budget exhausted → the honest "build incomplete" report IS posted.
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).toContain("NOT reachable");
    });

    it("treats a 405 (reachable, GET-not-allowed) URL as not dead — no retry", async () => {
      // Sub-agents dump raw HTTP headers into their narration; incidental
      // URLs there (CDN telemetry / NEL `report-to`, POST-only APIs) 405 a
      // GET. 405 means the server responded — the URL exists — so it must
      // not be flagged dead and must not trigger a retry of a build that
      // actually succeeded.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 405 })),
      );
      session = sessionWithTask("build it at https://example.test/apps/x/");
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: "Done — live at https://example.test/apps/x/",
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).not.toContain("[verification:");
    });

    it("ignores route-template URL stems when a concrete app URL verifies", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://nubilio.org/apps/") {
          return new Response("not found", { status: 404 });
        }
        if (url === "https://nubilio.org/apps/counter/") {
          return new Response('<script src="app.js"></script>', {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (url === "https://nubilio.org/apps/counter/app.js") {
          return new Response("let count = 0;", {
            status: 200,
            headers: { "content-type": "application/javascript" },
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      session = sessionWithTask("build a counter");
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response:
          "Route note: verify https://nubilio.org/apps/<slug>/. Built and verified https://nubilio.org/apps/counter/",
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(fetchMock).not.toHaveBeenCalledWith(
        "https://nubilio.org/apps/",
        expect.anything(),
      );
      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).not.toContain("[verification:");
    });

    it("ignores model-introduced same-path external URL aliases when the requested target verifies", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://127.0.0.1:6900/apps/asset-check/") {
          return new Response("<html><body>ok</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (url === "https://nubilio.org/apps/asset-check/") {
          return new Response("<html><body>ok</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      session = sessionWithTask(
        "build and verify https://nubilio.org/apps/asset-check/",
      );
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response:
          "Done — local: http://127.0.0.1:6900/apps/asset-check/, mirror: https://nubidio.org/apps/asset-check/, public: https://nubilio.org/apps/asset-check/",
      });
      await new Promise((r) => setTimeout(r, 200));

      const fetched = fetchMock.mock.calls.map(([url]) => String(url));
      expect(fetched).toContain("http://127.0.0.1:6900/apps/asset-check/");
      expect(fetched).toContain("https://nubilio.org/apps/asset-check/");
      expect(fetched).not.toContain("https://nubidio.org/apps/asset-check/");
      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).not.toContain("[verification:");
    });

    it("marks cached 404s so retries can switch to fresh asset filenames", async () => {
      const assetUrl = "https://example.test/apps/counter/style.css";
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(`${assetUrl}?__eliza_verify=`)) {
          return new Response("body { color: red; }", {
            status: 200,
            headers: { "content-type": "text/css" },
          });
        }
        if (url === assetUrl) {
          return new Response("not found", {
            status: 404,
            headers: {
              age: "42",
              "cf-cache-status": "HIT",
              "cache-control": "max-age=14400",
            },
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      session = sessionWithTask(`build a counter at ${assetUrl}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — live at ${assetUrl}`,
      });
      await new Promise((r) => setTimeout(r, 200));

      expect(spawnSession).toHaveBeenCalledTimes(1);
      const fetched = fetchMock.mock.calls.map(([url]) => String(url));
      expect(fetched.some((url) => url.startsWith(`${assetUrl}?`))).toBe(true);
      const retryTask = String(spawnSession.mock.calls[0]?.[0]?.initialTask);
      expect(retryTask).toContain("cached stale miss");
      expect(retryTask).toContain("rename that asset to a fresh filename");
      const retryMetadata = spawnSession.mock.calls[0]?.[0]?.metadata as
        | Record<string, unknown>
        | undefined;
      expect(retryMetadata?.cachedStaleMissUrls).toEqual([assetUrl]);
      expect(handleMessage).not.toHaveBeenCalled();
    });

    it("does not re-check stale cached URLs after a retry switches to fresh filenames", async () => {
      const staleUrl = "https://example.test/apps/counter/style.css";
      const freshUrl = "https://example.test/apps/counter/style-v2.css";
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === freshUrl) {
          return new Response("body { color: green; }", {
            status: 200,
            headers: { "content-type": "text/css" },
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      session = sessionWithTask(`build a counter at ${staleUrl}`, 1, {
        cachedStaleMissUrls: [staleUrl],
      });
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `The cached URL ${staleUrl} is stale; the app now uses ${freshUrl}`,
      });
      await new Promise((r) => setTimeout(r, 200));

      const fetched = fetchMock.mock.calls.map(([url]) => String(url));
      expect(fetched).toEqual([freshUrl]);
      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const posted = handleMessage.mock.calls[0]?.[1];
      expect(posted?.content?.text).not.toContain("[verification:");
    });

    it("does not retry when ELIZA_BUILD_VERIFY_MAX_RETRIES=0", async () => {
      process.env.ELIZA_BUILD_VERIFY_MAX_RETRIES = "0";
      session = sessionWithTask(`build it at ${DEAD_URL}`);
      acp = makeAcpService(session);
      const { runtime, handleMessage, spawnSession } = makeRuntime({
        acp: acp.service,
      });
      await SubAgentRouter.start(runtime);

      acp.emit(SESSION_ID, "task_complete", {
        response: `Done — live at ${DEAD_URL}`,
      });
      await new Promise((r) => setTimeout(r, 1000));

      expect(spawnSession).not.toHaveBeenCalled();
      expect(handleMessage).toHaveBeenCalledTimes(1);
    });
  });
});

describe("extractSubResources", () => {
  const PAGE = "https://nubilio.org/apps/bmi/index.html";

  it("extracts <link href> and <script src>, resolved absolute", () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="style.css" />
      </head><body><script src="app.js"></script></body></html>`;
    expect(extractSubResources(html, PAGE).sort()).toEqual([
      "https://nubilio.org/apps/bmi/app.js",
      "https://nubilio.org/apps/bmi/style.css",
    ]);
  });

  it("resolves absolute and root-relative refs", () => {
    const html = `<link href="/global.css"><script src="https://cdn.example.com/lib.js"></script>`;
    expect(extractSubResources(html, PAGE).sort()).toEqual([
      "https://cdn.example.com/lib.js",
      "https://nubilio.org/global.css",
    ]);
  });

  it("skips in-page anchors and data:/mailto: refs", () => {
    const html = `<link href="#top"><script src="data:text/javascript,1"></script><a href="mailto:x@y.z">m</a>`;
    expect(extractSubResources(html, PAGE)).toEqual([]);
  });

  it("returns [] for HTML with no sub-resources", () => {
    expect(extractSubResources("<html><body>hi</body></html>", PAGE)).toEqual(
      [],
    );
  });

  it("caps the result so a pathological page can't fan out unbounded", () => {
    const many = Array.from(
      { length: 50 },
      (_, i) => `<script src="s${i}.js"></script>`,
    ).join("");
    expect(extractSubResources(many, PAGE).length).toBe(10);
  });
});

describe("normalizeUrlsInText", () => {
  it("replaces a Unicode non-breaking hyphen inside a URL with ASCII hyphen", () => {
    // gpt-oss-class models emit U+2011 where they meant "-", so the link
    // 404s even though the directory exists under the ASCII-hyphen name.
    const text = "app is live at https://nubilio.org/apps/bmi‑calc‑1/";
    expect(normalizeUrlsInText(text)).toBe(
      "app is live at https://nubilio.org/apps/bmi-calc-1/",
    );
  });

  it("normalizes en dash and em dash inside URLs", () => {
    const text = "see http://localhost:6900/apps/my–app—1/index.html";
    expect(normalizeUrlsInText(text)).toBe(
      "see http://localhost:6900/apps/my-app-1/index.html",
    );
  });

  it("leaves dashes in surrounding prose untouched — only URLs are normalized", () => {
    const text = "the build finished — see https://x.org/a‑b/";
    expect(normalizeUrlsInText(text)).toBe(
      "the build finished — see https://x.org/a-b/",
    );
  });

  it("normalizes every URL when several are present", () => {
    const text = "http://127.0.0.1/a‑b/ and https://nubilio.org/c‑d/";
    expect(normalizeUrlsInText(text)).toBe(
      "http://127.0.0.1/a-b/ and https://nubilio.org/c-d/",
    );
  });

  it("returns text unchanged when it contains no URLs", () => {
    expect(normalizeUrlsInText("just some prose — no links")).toBe(
      "just some prose — no links",
    );
  });
});
