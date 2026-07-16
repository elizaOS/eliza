/**
 * progress-cadence.test.ts
 *
 * Gap (K): the `emitProgress` routing ladder + cadence inside
 * `registerProgressHook` (plugins/plugin-agent-orchestrator/src/index.ts) had no
 * unit coverage. That hook is the single hot path that turns AcpService session
 * events (narration / tool calls / heartbeats / terminal) into user-facing
 * progress posts, and its behavior is driven entirely by the resolved
 * `SubAgentProgressPolicy` (mode + delayMs) plus capability probes against the
 * connector list. A regression in any of:
 *   - the `delayMs` debounce before the first compact post,
 *   - the `silent` short-circuit,
 *   - the one-ack-per-session / one-ack-per-room dedup in `ack` mode,
 *   - the "create exactly one thread per label, then post into it" branch of the
 *     `threaded` mode routing ladder,
 *   - the heartbeat's skip-empty + dedupe-identical guards,
 * would silently spam (or silence) every sub-agent room, and nothing caught it.
 *
 * `registerProgressHook` itself is module-private, so this drives it through the
 * only real exported seam: `createAgentOrchestratorPlugin().init(config, runtime)`.
 * init() defers via `setTimeout(0)`, eager-starts the four services, then calls
 * `registerProgressHook(runtime)`, which subscribes to `acp.onSessionEvent`. We
 * advance fake timers to run that macrotask, capture the registered session-event
 * handler from the mock AcpService, and fire `(sessionId, event, data)` tuples at
 * it — exactly what the live AcpService does — then assert on the calls the hook
 * made against a fully-mocked runtime (no network, no real model, no wall clock).
 *
 * Everything is deterministic: vitest fake timers for the delay/silence/heartbeat
 * windows, a stubbed `useModel` for the heartbeat summary, and per-test env that
 * selects the progress mode the hook resolves at registration time.
 */

import {
  _resetBuildVariantForTests,
  isLocalCodeExecutionAllowed,
  ModelType,
} from "@elizaos/core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { createAgentOrchestratorPlugin } from "../../src/index.js";
import { AcpService } from "../../src/services/acp-service.js";

type SessionHandler = (sessionId: string, event: string, data: unknown) => void;
type TimerApiWithAsyncDrain = typeof vi & {
  runAllTimersAsync?: () => Promise<void>;
  advanceTimersByTimeAsync?: (ms: number) => Promise<void>;
};

const ROOM = "11111111-2222-3333-4444-555555555555" as const;
const SOURCE = "discord";

async function drainHookRegistrationTimers(): Promise<void> {
  const timerApi = vi as TimerApiWithAsyncDrain;
  if (typeof timerApi.runAllTimersAsync === "function") {
    await timerApi.runAllTimersAsync();
    return;
  }
  vi.runAllTimers();
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

async function advanceTimersByTime(ms: number): Promise<void> {
  const timerApi = vi as TimerApiWithAsyncDrain;
  if (typeof timerApi.advanceTimersByTimeAsync === "function") {
    await timerApi.advanceTimersByTimeAsync(ms);
    return;
  }
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// Env keys the progress policy + gating read. Saved/restored per test so modes
// don't leak between cases and the plugin always registers in code-exec mode.
const ENV_KEYS = [
  "ELIZA_BUILD_VARIANT",
  "ELIZA_PLATFORM",
  "ELIZA_AOSP_BUILD",
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "ACPX_PROGRESS_MODE",
  "ELIZA_SUB_AGENT_PROGRESS_MODE",
  "ACPX_PROGRESS_DELAY_MS",
  "ELIZA_SUB_AGENT_PROGRESS_DELAY_MS",
  "ACPX_PROGRESS_REACTIONS",
  "ELIZA_SUB_AGENT_PROGRESS_REACTIONS",
] as const;

interface MockConnector {
  source: string;
  capabilities: string[];
}

interface BuiltRuntime {
  // Dispatch a session event to EVERY handler the orchestrator subscribed —
  // init() registers two onSessionEvent listeners (the progress hook AND the
  // inbox-flush listener), so the stub fans out to all, exactly like the real
  // AcpService.
  emit: SessionHandler;
  sendMessageToTarget: Mock;
  editMessageOnTarget: Mock;
  createThreadOnTarget: Mock;
  postToThreadOnTarget: Mock;
  addReactionOnTarget: Mock;
  useModel: Mock;
  dispose: () => Promise<void>;
  // Mutable session metadata the hook reads via acp.getSession().
  sessions: Map<string, { metadata: Record<string, unknown>; status: string }>;
  sessionOutput: Map<string, string>;
  logger: { debug: Mock; warn: Mock; info: Mock; error: Mock };
}

/**
 * Build a fully-mocked runtime + a stub AcpService, run plugin.init(), and flush
 * the deferred setTimeout(0) so `registerProgressHook` runs and subscribes. The
 * captured `onSessionEvent` handler is returned so the test can drive events.
 */
async function buildHookedRuntime(
  connectors: MockConnector[],
  opts?: {
    sessionOutput?: string;
    // When provided, the mock runtime exposes `getRoom`, letting the hook's
    // resolveEmitTarget enrich the outbound target with channelId/serverId the
    // same way the swarm-synthesis completion router does. Maps roomId -> room
    // (or null for an unresolvable room).
    rooms?: Map<
      string,
      {
        id: string;
        channelId?: string;
        serverId?: string;
        source: string;
      } | null
    >;
  },
): Promise<BuiltRuntime> {
  const sessions = new Map<
    string,
    { metadata: Record<string, unknown>; status: string }
  >();
  const sessionOutput = new Map<string, string>();

  const sessionHandlers: SessionHandler[] = [];

  const sendMessageToTarget = vi.fn(async (_target, _content) => {
    // Return a Memory-like object carrying a platformMessageId so the hook
    // records ProgressState (canEdit / thread caching paths depend on it).
    return {
      metadata: {
        platformMessageId: `msg-${sendMessageToTarget.mock.calls.length}`,
      },
    };
  });
  const editMessageOnTarget = vi.fn(async () => ({ metadata: {} }));
  const createThreadOnTarget = vi.fn(async (_target, params) => ({
    threadId: `thread-${createThreadOnTarget.mock.calls.length}`,
    parentChannelId: ROOM,
    _name: params?.name,
  }));
  const postToThreadOnTarget = vi.fn(async () => ({ metadata: {} }));
  const addReactionOnTarget = vi.fn(async () => undefined);
  const useModel = vi.fn(async () => "Editing src/index.ts and running tests.");

  // Stub AcpService: only the surface the hook touches. onSessionEvent captures
  // the handler; getSession returns the per-session metadata/status; the rest
  // are no-op shims so the eager-start chain and heartbeat don't throw.
  const acpStub = {
    onSessionEvent(handler: SessionHandler): () => void {
      sessionHandlers.push(handler);
      return () => {
        const idx = sessionHandlers.indexOf(handler);
        if (idx >= 0) sessionHandlers.splice(idx, 1);
      };
    },
    async getSession(sessionId: string) {
      const s = sessions.get(sessionId);
      if (!s) return undefined;
      return {
        id: sessionId,
        status: s.status,
        createdAt: new Date(0),
        lastActivityAt: new Date(0),
        metadata: s.metadata,
      };
    },
    async getSessionOutput(sessionId: string) {
      return sessionOutput.get(sessionId) ?? opts?.sessionOutput ?? "";
    },
    async updateSessionMetadata() {
      return undefined;
    },
    async stop() {
      return undefined;
    },
    async resumeOrphanedBusySessions() {
      return undefined;
    },
  };

  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };

  const services = new Map<string, unknown>();
  services.set(AcpService.serviceType, acpStub);

  const getRoom = opts?.rooms
    ? vi.fn(async (roomId: string) => opts.rooms?.get(roomId) ?? null)
    : undefined;

  const runtime = {
    agentId: "agent-0000-0000-0000-000000000000",
    character: {
      name: "TestBot",
      bio: ["a concise, helpful test assistant"],
      style: { chat: ["casual", "terse"] },
    },
    logger,
    ...(getRoom ? { getRoom } : {}),
    getSetting: () => undefined,
    getService: (type: string) => services.get(type) ?? null,
    // init() awaits this for each of the 4 service types before registering the
    // hook. Resolve immediately for every type so the chain proceeds.
    getServiceLoadPromise: async (_type: string) => undefined,
    getMessageConnectors: () => connectors,
    registerEvent: vi.fn(),
    unregisterEvent: vi.fn(),
    useModel,
    sendMessageToTarget,
    editMessageOnTarget,
    createThreadOnTarget,
    postToThreadOnTarget,
    addReactionOnTarget,
  } as unknown as Parameters<
    NonNullable<ReturnType<typeof createAgentOrchestratorPlugin>["init"]>
  >[1];

  const plugin = createAgentOrchestratorPlugin();
  // Guard: the whole test premise is that this build registers the code-exec
  // services + the progress hook. If gating is off, init() returns early.
  expect(isLocalCodeExecutionAllowed()).toBe(true);
  expect(plugin.services?.length ?? 0).toBeGreaterThan(0);

  await plugin.init?.({}, runtime);
  // init() schedules the hook registration on a setTimeout(0) macrotask whose
  // body awaits getServiceLoadPromise; drain the timer AND the awaited
  // microtasks so the hook subscribes before we return. Bun's direct test
  // runner does not expose Vitest's runAllTimersAsync, so the helper falls back
  // to a bounded microtask drain.
  await drainHookRegistrationTimers();

  if (sessionHandlers.length === 0) {
    throw new Error(
      "registerProgressHook never subscribed via onSessionEvent — init wiring changed",
    );
  }

  return {
    emit: (sessionId, event, data) => {
      for (const h of sessionHandlers) h(sessionId, event, data);
    },
    sendMessageToTarget,
    editMessageOnTarget,
    createThreadOnTarget,
    postToThreadOnTarget,
    addReactionOnTarget,
    useModel,
    dispose: async () => {
      await plugin.dispose?.(runtime);
    },
    sessions,
    sessionOutput,
    logger,
  };
}

/** Register a session's routing metadata so the hook resolves source/room/label. */
function seedSession(
  rt: BuiltRuntime,
  sessionId: string,
  label: string,
  status = "running",
): void {
  rt.sessions.set(sessionId, {
    status,
    metadata: { source: SOURCE, roomId: ROOM, label },
  });
}

/**
 * Fire one session event and let the hook's async body settle. The hook handler
 * is fire-and-forget async with a chain of plain awaits (getSession → emitProgress
 * → sendMessageToTarget). advanceTimersByTime drains pending timers AND the
 * awaited microtasks between them; a few extra microtask turns flush the rest.
 */
async function fire(
  rt: BuiltRuntime,
  sessionId: string,
  event: string,
  data: unknown = {},
): Promise<void> {
  rt.emit(sessionId, event, data);
  await advanceTimersByTime(0);
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("emitProgress routing ladder + cadence", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    // Force a clean code-exec-enabled build for every test.
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.ELIZA_BUILD_VARIANT = "direct";
    _resetBuildVariantForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetBuildVariantForTests();
  });

  it("compact mode posts a single debounced message only after delayMs elapses", async () => {
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "15000";
    // Plain text connector: no edit/thread caps → fresh-send fallback path.
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);
    seedSession(rt, "s-compact", "build-site");

    // Narration chunks accumulate in the message buffer.
    await fire(rt, "s-compact", "message", { text: "Reading the spec " });
    await fire(rt, "s-compact", "message", { text: "and starting the build." });
    expect(rt.sendMessageToTarget).not.toHaveBeenCalled();

    // After the 1.5s silence-flush window, flushMessageBuffer calls emitProgress
    // — but the 15s delayMs debounce holds the first post back.
    await advanceTimersByTime(1_600);
    expect(rt.sendMessageToTarget).not.toHaveBeenCalled();

    // Crossing delayMs releases exactly one buffered post.
    await advanceTimersByTime(15_000);
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);

    const [, content] = rt.sendMessageToTarget.mock.calls[0];
    // compact strips the `emoji [label]` prefix; the buffered narration survives.
    expect((content as { text: string }).text).toContain("starting the build");
    expect((content as { source: string }).source).toBe("sub_agent_progress");

    await rt.dispose();
  });

  it("targets the ORIGIN room, not the minted task room, when session metadata carries originRoomId", async () => {
    // Default-on task rooms stamp meta.roomId with the minted task-room UUID,
    // which maps to no live connector channel — posting there fails silently
    // (demoted to debug after the first warn). The hook must resolve the emit
    // target through the origin ladder so acks/narration reach the user.
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    const TASK_ROOM = "99999999-8888-4777-8666-555555555555";
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);
    rt.sessions.set("s-origin", {
      status: "running",
      metadata: {
        source: SOURCE,
        roomId: TASK_ROOM,
        originRoomId: ROOM,
        label: "origin-task",
      },
    });

    await fire(rt, "s-origin", "message", { text: "Building the parser." });
    // Drain the narration silence-flush window so the buffered post fires.
    await advanceTimersByTime(2_000);

    expect(rt.sendMessageToTarget).toHaveBeenCalled();
    for (const [target] of rt.sendMessageToTarget.mock.calls) {
      expect((target as { roomId: string }).roomId).toBe(ROOM);
    }

    await rt.dispose();
  });

  it("silent mode posts nothing for any event", async () => {
    process.env.ACPX_PROGRESS_MODE = "silent";
    const rt = await buildHookedRuntime([
      {
        source: SOURCE,
        capabilities: ["edit_message", "create_thread", "post_to_thread"],
      },
    ]);
    seedSession(rt, "s-silent", "quiet-task");

    await fire(rt, "s-silent", "ready");
    await fire(rt, "s-silent", "message", { text: "doing lots of work" });
    await fire(rt, "s-silent", "tool_running", {
      toolCall: { id: "t1", kind: "edit", rawInput: { file_path: "/a/b.ts" } },
    });
    // Drain the silence-flush + any heartbeat windows.
    await advanceTimersByTime(60_000);

    expect(rt.sendMessageToTarget).not.toHaveBeenCalled();
    expect(rt.editMessageOnTarget).not.toHaveBeenCalled();
    expect(rt.postToThreadOnTarget).not.toHaveBeenCalled();
    expect(rt.createThreadOnTarget).not.toHaveBeenCalled();

    await rt.dispose();
  });

  it("ack mode posts exactly one ack per session, even across many events", async () => {
    process.env.ACPX_PROGRESS_MODE = "ack";
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);
    seedSession(rt, "s-ack", "ack-task");

    // The spawn ack is the model's own one-line acknowledgement (in-voice,
    // in-language) — not a hardcoded literal. The mocked model returns a fixed
    // line; the posted ack is that line, sanitized.
    rt.useModel.mockResolvedValueOnce("On it — starting now.");

    // First non-terminal event triggers the single spawn ACK (delayMs is forced
    // to 0 for ack mode, so it posts immediately).
    await fire(rt, "s-ack", "ready");
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);
    expect(
      (rt.sendMessageToTarget.mock.calls[0][1] as { text: string }).text,
    ).toBe("On it — starting now.");
    // The ack is generated with the small text model.
    expect(rt.useModel).toHaveBeenCalledWith(
      ModelType.TEXT_SMALL,
      expect.objectContaining({
        system: expect.stringContaining("TestBot"),
        prompt: expect.any(String),
      }),
    );

    // Subsequent events (narration, tools) must NOT add more acks.
    await fire(rt, "s-ack", "message", { text: "still working" });
    await fire(rt, "s-ack", "tool_running", {
      toolCall: { id: "t1", kind: "read", rawInput: { file_path: "/x.ts" } },
    });
    await advanceTimersByTime(5_000);
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);

    await rt.dispose();
  });

  it("ack mode feeds the task text to the model so it can match the user's language", async () => {
    process.env.ACPX_PROGRESS_MODE = "ack";
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);
    // initialTask carries the real user request — the language signal handed to
    // the model (here: French). The model itself is mocked, but we assert the
    // request reached it so the in-language behavior is wired.
    rt.sessions.set("s-fr", {
      status: "running",
      metadata: {
        source: SOURCE,
        roomId: ROOM,
        label: "build-site",
        initialTask: "construis-moi un site vitrine en français",
      },
    });
    rt.useModel.mockResolvedValueOnce("C'est parti.");

    await fire(rt, "s-fr", "ready");
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);
    expect(
      (rt.sendMessageToTarget.mock.calls[0][1] as { text: string }).text,
    ).toBe("C'est parti.");
    const [, params] = rt.useModel.mock.calls[0] as [
      unknown,
      { prompt: string },
    ];
    expect(params.prompt).toContain(
      "construis-moi un site vitrine en français",
    );

    await rt.dispose();
  });

  it("ack mode falls back to a short literal when the model call fails", async () => {
    process.env.ACPX_PROGRESS_MODE = "ack";
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);
    seedSession(rt, "s-ack-fail", "ack-task");
    rt.useModel.mockRejectedValueOnce(new Error("no model registered"));

    await fire(rt, "s-ack-fail", "ready");
    // Never silence: the ack still posts exactly once, using the fallback.
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);
    expect(
      (rt.sendMessageToTarget.mock.calls[0][1] as { text: string }).text,
    ).toBe("On it.");

    await rt.dispose();
  });

  it("ack mode suppresses a delayed model ack after a terminal event", async () => {
    process.env.ACPX_PROGRESS_MODE = "ack";
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);
    seedSession(rt, "s-late-ack", "ack-task");

    let resolveAck!: (value: string) => void;
    const pendingAck = new Promise<string>((resolve) => {
      resolveAck = resolve;
    });
    rt.useModel.mockReturnValueOnce(pendingAck);

    await fire(rt, "s-late-ack", "ready");
    expect(rt.sendMessageToTarget).not.toHaveBeenCalled();

    await fire(rt, "s-late-ack", "task_complete", { response: "done" });
    resolveAck("On it late.");
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(rt.sendMessageToTarget).not.toHaveBeenCalled();

    await rt.dispose();
  });

  it("ack mode dedupes a sibling session in the same room within the dedup window", async () => {
    process.env.ACPX_PROGRESS_MODE = "ack";
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);
    seedSession(rt, "s-ack-a", "task-a");
    seedSession(rt, "s-ack-b", "task-b");

    await fire(rt, "s-ack-a", "ready");
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);

    // A second session spawned in the SAME room/turn must be suppressed by the
    // per-room ack dedup (ACK_ROOM_DEDUP_MS), collapsing one user turn to one ack.
    await fire(rt, "s-ack-b", "ready");
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);

    await rt.dispose();
  });

  it("ack mode does NOT re-ack a verify-retry re-dispatch when the label cache is empty", async () => {
    process.env.ACPX_PROGRESS_MODE = "ack";
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);
    // Connector that returns NO platformMessageId on send (some transports —
    // SMS/stdio/X-DM — give back no addressable id). This is the case the
    // `isVerifyRetrySpawn` guard exists for: with no platformId, the spawn ack's
    // main message is never recorded in `mainMessageCacheByKey` (index.ts:1329,
    // gated on a non-empty platformId). So the per-label main-message cache —
    // which otherwise swallows a same-label re-dispatch on the !state-cachedMainId
    // branch (index.ts:1257) BEFORE any second send — stays EMPTY here. That
    // makes this assertion depend on the verify-retry guard itself, not on the
    // label cache. (Remove `!isVerifyRetrySpawn` from registerProgressHook and
    // this test goes red: the retry posts a second "working on it now.".)
    rt.sendMessageToTarget.mockImplementation(async () => ({ metadata: {} }));

    // The original user-requested session acks exactly once.
    seedSession(rt, "s-orig", "build-site");
    await fire(rt, "s-orig", "ready");
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);

    // SubAgentRouter.retryIncompleteBuild re-dispatches a failed build under a
    // FRESH sessionId minutes subsequent, tagging it `buildVerifyRetryCount > 0`. The
    // per-session ackedSessions/firstPostInFlight guards never see the new id,
    // and the per-room ack dedup window (ACK_ROOM_DEDUP_MS, 60s) has expired — so
    // the only thing standing between the retry and a second "working on it now."
    // ack is the `isVerifyRetrySpawn` gate in registerProgressHook. Advance well
    // past the room-dedup window so this asserts the guard, not the room-dedup.
    await advanceTimersByTime(120_000);
    rt.sessions.set("s-retry", {
      status: "running",
      metadata: {
        source: SOURCE,
        roomId: ROOM,
        label: "build-site",
        buildVerifyRetryCount: 1,
      },
    });
    await fire(rt, "s-retry", "ready");
    // Still exactly ONE ack for the whole user request.
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);

    await rt.dispose();
  });

  // Companion to the test above: when the connector DOES return a platformId, a
  // same-room sibling/respawn under the SAME label is already absorbed by the
  // per-label `mainMessageCacheByKey` reuse path (index.ts:1257) — even past the
  // room-dedup window and WITHOUT the verify-retry guard. This documents that
  // second, independent suppression mechanism so a future reader doesn't mistake
  // the guard for the only thing keeping the ack count at one.
  it("ack mode reuses the cached main message for a same-label respawn (label-cache path)", async () => {
    process.env.ACPX_PROGRESS_MODE = "ack";
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);

    seedSession(rt, "s-orig", "build-site");
    await fire(rt, "s-orig", "ready");
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);

    // A plain respawn (NO buildVerifyRetryCount, so the guard does not apply)
    // under the same label, past the room-dedup window. The label cache — now
    // populated because the first send returned a platformId — reuses the cached
    // main message and skips the network send entirely.
    await advanceTimersByTime(120_000);
    rt.sessions.set("s-respawn", {
      status: "running",
      metadata: { source: SOURCE, roomId: ROOM, label: "build-site" },
    });
    await fire(rt, "s-respawn", "ready");
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);

    await rt.dispose();
  });

  it("threaded mode creates exactly one thread per label and routes narration into it", async () => {
    process.env.ACPX_PROGRESS_MODE = "threaded";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    const rt = await buildHookedRuntime([
      {
        source: SOURCE,
        capabilities: ["create_thread", "post_to_thread", "edit_message"],
      },
    ]);
    seedSession(rt, "s-thread", "feature-x");

    // The first emitProgress (the first narration flush) is what posts the 🚀
    // spawn message to the main channel and creates the per-label thread off it.
    // `ready` only arms the heartbeat — it does not post in threaded mode.
    await fire(rt, "s-thread", "ready");
    expect(rt.sendMessageToTarget).not.toHaveBeenCalled();
    expect(rt.createThreadOnTarget).not.toHaveBeenCalled();

    // First narration: buffer, then flush after the silence window. That first
    // flush posts exactly one main-channel 🚀 message and creates exactly one
    // thread, and immediately posts the narration into that thread.
    await fire(rt, "s-thread", "message", {
      text: "Implementing the feature.",
    });
    await advanceTimersByTime(1_600); // silence-flush window
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);
    const spawnText = (
      rt.sendMessageToTarget.mock.calls[0][1] as { text: string }
    ).text;
    expect(spawnText).toBe("🚀 [feature-x] running");
    expect(rt.createThreadOnTarget).toHaveBeenCalledTimes(1);
    expect(rt.postToThreadOnTarget).toHaveBeenCalled();

    // More narration → routes into the SAME thread: no second main-channel send,
    // no second thread creation.
    await fire(rt, "s-thread", "message", { text: "Wiring it up." });
    await advanceTimersByTime(1_600);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(rt.createThreadOnTarget).toHaveBeenCalledTimes(1);
    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);

    await rt.dispose();
  });

  it("heartbeat skips when there is no narration and no tool history", async () => {
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    // No edit cap → slow (30s) heartbeat interval; empty session output.
    const rt = await buildHookedRuntime(
      [{ source: SOURCE, capabilities: [] }],
      { sessionOutput: "" },
    );
    seedSession(rt, "s-hb-empty", "idle-task");

    // `ready` starts the heartbeat. No message/tool events recorded → nothing
    // for the summarizer to work with.
    await fire(rt, "s-hb-empty", "ready");
    rt.sendMessageToTarget.mockClear();
    rt.useModel.mockClear();

    // Advance past two slow heartbeat ticks. With empty output AND empty tool
    // history the tick returns before calling useModel or emitting anything.
    await advanceTimersByTime(65_000);

    expect(rt.useModel).not.toHaveBeenCalled();
    expect(rt.sendMessageToTarget).not.toHaveBeenCalled();

    await rt.dispose();
  });

  it("heartbeat dedupes an identical summary across consecutive ticks", async () => {
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    // edit_message cap → fast (10s) heartbeat interval; non-empty session output
    // so the summarizer has something to summarize.
    const rt = await buildHookedRuntime(
      [{ source: SOURCE, capabilities: ["edit_message"] }],
      { sessionOutput: "Now let me build the homepage and deploy it." },
    );
    seedSession(rt, "s-hb-dupe", "deploy-task");
    // Model always returns the SAME line → after the first post, subsequent ticks
    // must dedupe and stay silent.
    rt.useModel.mockResolvedValue("Building the homepage and deploying.");

    await fire(rt, "s-hb-dupe", "ready");
    rt.sendMessageToTarget.mockClear();
    rt.editMessageOnTarget.mockClear();

    // First fast tick (~10s): the LLM summary posts once.
    await advanceTimersByTime(10_500);
    const postsAfterFirst =
      rt.sendMessageToTarget.mock.calls.length +
      rt.editMessageOnTarget.mock.calls.length;
    expect(postsAfterFirst).toBe(1);

    // Two more ticks producing the identical summary → no additional posts.
    await advanceTimersByTime(25_000);
    const postsAfterMore =
      rt.sendMessageToTarget.mock.calls.length +
      rt.editMessageOnTarget.mock.calls.length;
    expect(postsAfterMore).toBe(1);

    await rt.dispose();
  });

  // ── emitProgress room→channel resolution (issue: verify-retry successor
  //    sessions inherit a roomId whose Discord channel no longer resolves) ──

  it("threads the resolved channelId/serverId onto the outbound target when getRoom resolves the room", async () => {
    // The completion/synthesis router resolves the connector channel via
    // getRoom and sends with an explicit channelId; emitProgress must do the
    // same so the Discord connector sends directly instead of re-deriving the
    // channel from the (possibly stale) roomId and throwing.
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    const rooms = new Map<
      string,
      {
        id: string;
        channelId?: string;
        serverId?: string;
        source: string;
      } | null
    >([
      [
        ROOM,
        {
          id: ROOM,
          channelId: "9876543210", // discord snowflake
          serverId: "1234509876",
          source: SOURCE,
        },
      ],
    ]);
    const rt = await buildHookedRuntime(
      [{ source: SOURCE, capabilities: [] }],
      { rooms },
    );
    seedSession(rt, "s-resolve", "build-site");

    await fire(rt, "s-resolve", "message", { text: "Reading the spec." });
    await advanceTimersByTime(1_600);
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);
    const [target] = rt.sendMessageToTarget.mock.calls[0] as [
      { source: string; roomId: string; channelId?: string; serverId?: string },
      unknown,
    ];
    // The connector-resolvable channel + server are threaded through so the
    // Discord SendHandler uses target.channelId directly.
    expect(target.source).toBe(SOURCE);
    expect(target.roomId).toBe(ROOM);
    expect(target.channelId).toBe("9876543210");
    expect(target.serverId).toBe("1234509876");

    await rt.dispose();
  });

  it("falls back to room.id as channelId when the room has no channelId", async () => {
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    const rooms = new Map<
      string,
      {
        id: string;
        channelId?: string;
        serverId?: string;
        source: string;
      } | null
    >([[ROOM, { id: ROOM, source: SOURCE }]]);
    const rt = await buildHookedRuntime(
      [{ source: SOURCE, capabilities: [] }],
      { rooms },
    );
    seedSession(rt, "s-resolve-fallback", "build-site");

    await fire(rt, "s-resolve-fallback", "message", { text: "Working." });
    await advanceTimersByTime(1_600);
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);
    const [target] = rt.sendMessageToTarget.mock.calls[0] as [
      { channelId?: string; serverId?: string },
      unknown,
    ];
    // channelId ?? id → room id; no serverId on the room → omitted.
    expect(target.channelId).toBe(ROOM);
    expect(target.serverId).toBeUndefined();

    await rt.dispose();
  });

  it("still sends with a bare {source, roomId} target when getRoom is unavailable", async () => {
    // No getRoom on the runtime (older connectors / non-room surfaces): the
    // resolver must fall back to the bare target — no worse than before.
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);
    seedSession(rt, "s-no-getroom", "build-site");

    await fire(rt, "s-no-getroom", "message", { text: "Working." });
    await advanceTimersByTime(1_600);
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(rt.sendMessageToTarget).toHaveBeenCalledTimes(1);
    const [target] = rt.sendMessageToTarget.mock.calls[0] as [
      { source: string; roomId: string; channelId?: string },
      unknown,
    ];
    expect(target.source).toBe(SOURCE);
    expect(target.roomId).toBe(ROOM);
    expect(target.channelId).toBeUndefined();

    await rt.dispose();
  });

  it("warns at most once per session when the outbound send keeps failing, then drops to debug", async () => {
    // A truly unresolvable room makes every send throw. The hook must WARN once
    // then DEBUG on subsequent emits so a stuck session doesn't spam the log on
    // every narration tick + heartbeat.
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    const rt = await buildHookedRuntime([{ source: SOURCE, capabilities: [] }]);
    seedSession(rt, "s-failsoft", "build-site");
    // Every outbound send throws the connector's resolution error.
    rt.sendMessageToTarget.mockRejectedValue(
      new Error(`Could not resolve Discord channel ID for room ${ROOM}`),
    );

    const emitWarns = () =>
      rt.logger.warn.mock.calls.filter((c) => c[1] === "emitProgress failed")
        .length;
    const emitDebugs = () =>
      rt.logger.debug.mock.calls.filter(
        (c) => c[1] === "emitProgress failed (repeat)",
      ).length;

    // First failing emit → exactly one WARN.
    await fire(rt, "s-failsoft", "message", { text: "Attempt one." });
    await advanceTimersByTime(1_600);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(emitWarns()).toBe(1);
    expect(emitDebugs()).toBe(0);

    // Subsequent failing emits for the SAME session → DEBUG only, WARN unchanged.
    await fire(rt, "s-failsoft", "message", { text: "Attempt two." });
    await advanceTimersByTime(1_600);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await fire(rt, "s-failsoft", "message", { text: "Attempt three." });
    await advanceTimersByTime(1_600);
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(emitWarns()).toBe(1);
    expect(emitDebugs()).toBeGreaterThanOrEqual(1);

    await rt.dispose();
  });

  // ── heartbeat tool-history hygiene: junk `""` titles must not enter the
  //    summarizer prompt. The upstream `stringifyMaybe` serializer turns a
  //    missing ACP tool title (undefined/null) into the literal two-character
  //    string `""`; without sanitizing, the summarizer prompt filled up with
  //    `Tools the sub-agent has called recently (most recent last): "", ""`,
  //    burning tokens every 30s tick and feeding the small model garbage. ──

  it("heartbeat drops content-free tool titles (JSON-serialized empty string) from the prompt", async () => {
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    // edit_message cap → fast (10s) heartbeat interval so a single tick fires.
    // Non-empty session output so the tick reaches the useModel call.
    const rt = await buildHookedRuntime(
      [{ source: SOURCE, capabilities: ["edit_message"] }],
      { sessionOutput: "Working through the change set." },
    );
    seedSession(rt, "s-hb-junk", "noise-task");

    // Reproduce the live round-5 trajectory: an ACP tool_call whose title the
    // serializer rendered as the literal 2-char string `""` (missing title),
    // with NO kind and NO args — the exact junk that used to leak. Interleave a
    // real, informative call so we can assert the good one survives.
    await fire(rt, "s-hb-junk", "tool_running", {
      toolCall: { id: "j1", title: '""' },
    });
    await fire(rt, "s-hb-junk", "tool_running", {
      toolCall: { id: "j2", title: '""' },
    });
    await fire(rt, "s-hb-junk", "tool_running", {
      toolCall: {
        id: "e1",
        kind: "edit",
        rawInput: { file_path: "/repo/src/app.ts" },
      },
    });
    await fire(rt, "s-hb-junk", "tool_running", {
      toolCall: { id: "j3", title: '""' },
    });

    rt.useModel.mockClear();
    rt.useModel.mockResolvedValueOnce("Editing src/app.ts.");

    // One fast heartbeat tick.
    await advanceTimersByTime(10_500);

    expect(rt.useModel).toHaveBeenCalledTimes(1);
    const [, params] = rt.useModel.mock.calls[0] as [
      unknown,
      { prompt: string },
    ];
    // The junk `""` tool entries must NOT be in the summarizer prompt.
    expect(params.prompt).not.toContain('"", ""');
    expect(params.prompt).not.toMatch(/recently[^\n]*:\s*""/);
    // The real, informative call still made it in (path >2 segments → shortPath
    // abbreviates the leading segments to `…/`).
    expect(params.prompt).toContain("Edit(\u2026/src/app.ts)");

    await rt.dispose();
  });

  it("heartbeat skips entirely when the only tool activity is content-free junk titles", async () => {
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    // edit_message cap → fast (10s) tick. EMPTY session output so the tick's
    // skip-empty guard depends purely on whether the junk tools were recorded.
    const rt = await buildHookedRuntime(
      [{ source: SOURCE, capabilities: ["edit_message"] }],
      { sessionOutput: "" },
    );
    seedSession(rt, "s-hb-alljunk", "noise-task");

    // Only junk `""` titles arrive — nothing informative, no narration.
    await fire(rt, "s-hb-alljunk", "tool_running", {
      toolCall: { id: "j1", title: '""' },
    });
    await fire(rt, "s-hb-alljunk", "tool_running", {
      toolCall: { id: "j2", title: '""' },
    });

    rt.useModel.mockClear();
    rt.sendMessageToTarget.mockClear();
    rt.editMessageOnTarget.mockClear();

    // Advance past the tick. With empty output AND no recorded tool history
    // (the junk was rejected), the skip-empty guard short-circuits before
    // calling the model or posting anything.
    await advanceTimersByTime(10_500);

    expect(rt.useModel).not.toHaveBeenCalled();
    expect(rt.sendMessageToTarget).not.toHaveBeenCalled();
    expect(rt.editMessageOnTarget).not.toHaveBeenCalled();

    await rt.dispose();
  });

  it("heartbeat keeps a bare informative noun (arg-less Bash) so class-of-work still surfaces", async () => {
    process.env.ACPX_PROGRESS_MODE = "compact";
    process.env.ACPX_PROGRESS_DELAY_MS = "0";
    const rt = await buildHookedRuntime(
      [{ source: SOURCE, capabilities: ["edit_message"] }],
      { sessionOutput: "" },
    );
    seedSession(rt, "s-hb-bare", "bare-task");

    // An arg-less execute call: no rawInput/locations, but kind=execute yields
    // the informative bare noun "Bash". This MUST survive (documented debounce
    // fallback) so the summarizer knows shell work is happening.
    await fire(rt, "s-hb-bare", "tool_running", {
      toolCall: { id: "b1", kind: "execute" },
    });

    rt.useModel.mockClear();
    rt.useModel.mockResolvedValueOnce("Running a shell command.");

    await advanceTimersByTime(10_500);

    expect(rt.useModel).toHaveBeenCalledTimes(1);
    const [, params] = rt.useModel.mock.calls[0] as [
      unknown,
      { prompt: string },
    ];
    expect(params.prompt).toContain("Bash");

    await rt.dispose();
  });
});
