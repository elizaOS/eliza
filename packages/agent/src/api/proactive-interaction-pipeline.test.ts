/**
 * End-to-end server pipeline for proactive interaction comments (#8792).
 *
 * Wires the REAL pieces together with a faithful fake runtime + minimal
 * ServerState and drives one client-reported view switch through the whole
 * chain, deterministically and offline:
 *
 *   POST /api/views/:id/navigate (source:"user")           [views-routes]
 *     → emitEvent(VIEW_SWITCHED, { initiatedBy:"user" })   [the route]
 *       → decider subscription + small-model judge          [registerProactiveInteractionDecider]
 *         → governance gate admits                          [ProactiveInteractionGate]
 *           → routeAutonomyTextToUser(..., "proactive-interaction")  [server-helpers-swarm]
 *             → broadcastWs({ type:"proactive-message", message:{ source:"proactive-interaction" }})
 *
 * This is the one test that proves the seams actually connect — the unit tests
 * cover each box in isolation; this covers the wire between them.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import type { EventPayload, IAgentRuntime, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROACTIVE_CHATTINESS_SETTING_KEY,
  PROACTIVE_INTERACTION_SOURCE,
  registerProactiveInteractionDecider,
} from "../services/proactive-interaction-decider.ts";
import { ProactiveInteractionGate } from "../services/proactive-interaction-gate.ts";
import {
  handleInteractionsRoutes,
  type InteractionsRouteContext,
} from "./interactions-routes.ts";
import { routeAutonomyTextToUser } from "./server-helpers-swarm.ts";
import type { ServerState } from "./server-types.ts";
import { registerBuiltinViews } from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  type ViewsRouteContext,
} from "./views-routes.ts";

type Handler = (params: EventPayload) => Promise<void> | void;
type Frame = Record<string, unknown>;

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const AGENT_ID = "22222222-2222-2222-2222-222222222222" as UUID;

interface HarnessOptions {
  /** Value returned by getSetting for the chattiness control. Default "subtle". */
  chattiness?: string;
  /** Documents-store rows returned by getMemories (drives knowledge/transcript live state). */
  documents?: unknown[];
}

function buildHarness(judgeOutput: string, options: HarnessOptions = {}) {
  const events: Record<string, Handler[]> = {};
  const frames: Frame[] = [];
  const createdMemories: unknown[] = [];
  // Prompts handed to the small-model judge — asserted to prove the per-view
  // anticipatory intent and live state actually reach the model (#13587).
  const judgePrompts: string[] = [];
  const documents = options.documents ?? [];

  const runtime = {
    agentId: AGENT_ID,
    events,
    registerEvent(event: string, handler: Handler) {
      let handlers = events[event];
      if (!handlers) {
        handlers = [];
        events[event] = handlers;
      }
      handlers.push(handler);
    },
    async emitEvent(event: string, params: Frame) {
      const handlers = events[event];
      if (!handlers) return;
      const payload = {
        ...params,
        runtime: runtime as unknown as IAgentRuntime,
        source: typeof params.source === "string" ? params.source : "runtime",
      } as EventPayload;
      await Promise.all(handlers.map((h) => h(payload)));
    },
    useModel: vi.fn(async (_type: unknown, params: { prompt: string }) => {
      judgePrompts.push(params.prompt);
      return judgeOutput;
    }),
    getMemories: vi.fn(async () => documents),
    reportError: vi.fn(),
    getSetting: (key: string) =>
      key === PROACTIVE_CHATTINESS_SETTING_KEY
        ? (options.chattiness ?? "subtle")
        : undefined,
    createMemory: vi.fn(async (memory: unknown) => {
      createdMemories.push(memory);
      return memory;
    }),
  };

  const state = {
    runtime: runtime as unknown as IAgentRuntime,
    activeConversationId: "conv-1",
    conversations: new Map([
      [
        "conv-1",
        {
          id: "conv-1",
          roomId: ROOM_ID,
          updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        },
      ],
    ]),
    broadcastWs: (data: object) => {
      frames.push(data as Frame);
    },
  } as unknown as ServerState;

  const gate = new ProactiveInteractionGate();
  registerProactiveInteractionDecider(runtime as unknown as IAgentRuntime, {
    gate,
    route: (text) =>
      routeAutonomyTextToUser(state, text, PROACTIVE_INTERACTION_SOURCE),
  });

  return {
    runtime: runtime as unknown as IAgentRuntime,
    state,
    frames,
    createdMemories,
    judgePrompts,
    gate,
  };
}

function navigateCtx(
  runtime: IAgentRuntime,
  id: string,
  body: Frame,
): ViewsRouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body)),
  ]) as unknown as http.IncomingMessage;
  const pathname = `/api/views/${encodeURIComponent(id)}/navigate`;
  return {
    req,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}`),
    json: vi.fn(),
    error: vi.fn(),
    broadcastWs: vi.fn(),
    runtime,
  };
}

function shortcutCtx(
  runtime: IAgentRuntime,
  shortcutId: string,
): InteractionsRouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify({ shortcutId })),
  ]) as unknown as http.IncomingMessage;
  return {
    req,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/interactions/shortcut",
    json: vi.fn(),
    error: vi.fn(),
    runtime: runtime as unknown as Parameters<
      typeof handleInteractionsRoutes
    >[0]["runtime"],
  };
}

function proactiveFrames(frames: Frame[]): Frame[] {
  return frames.filter((f) => f.type === "proactive-message");
}

describe("proactive interaction pipeline — navigate → comment (#8792)", () => {
  let savedKill: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedKill = process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    savedEnv = process.env.ELIZA_PROACTIVE_INTERACTIONS;
    delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    delete process.env.ELIZA_PROACTIVE_INTERACTIONS;
    registerBuiltinViews();
    clearCurrentViewState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    clearCurrentViewState();
    if (savedKill === undefined)
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    else process.env.ELIZA_DISABLE_PROACTIVE_AGENT = savedKill;
    if (savedEnv === undefined) delete process.env.ELIZA_PROACTIVE_INTERACTIONS;
    else process.env.ELIZA_PROACTIVE_INTERACTIONS = savedEnv;
    vi.restoreAllMocks();
  });

  it("turns a user-reported view switch into a persisted, broadcast proactive-message", async () => {
    const { runtime, frames, createdMemories } = buildHarness(
      '{"comment":"Want me to pull your latest balances?"}',
    );

    await handleViewsRoutes(navigateCtx(runtime, "wallet", { source: "user" }));
    // Flush the decider debounce + judge + route chain.
    await vi.advanceTimersByTimeAsync(2_000);

    const proactive = proactiveFrames(frames);
    expect(proactive).toHaveLength(1);
    const message = proactive[0].message as Frame;
    expect(message).toEqual(
      expect.objectContaining({
        role: "assistant",
        text: "Want me to pull your latest balances?",
        source: PROACTIVE_INTERACTION_SOURCE,
      }),
    );
    // The comment is persisted to the conversation (not ephemeral).
    expect(createdMemories).toHaveLength(1);
  });

  it("governs a rapid burst — a second switch within the global cooldown is suppressed", async () => {
    const { runtime, frames } = buildHarness('{"comment":"Here is an offer."}');

    await handleViewsRoutes(navigateCtx(runtime, "wallet", { source: "user" }));
    await vi.advanceTimersByTimeAsync(2_000);
    await handleViewsRoutes(
      navigateCtx(runtime, "calendar", { source: "user" }),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    // Only the first surface comments; the second is gated by the global cooldown.
    expect(proactiveFrames(frames)).toHaveLength(1);
  });

  it("stays silent when the judge declines (no proactive-message at all)", async () => {
    const { runtime, frames } = buildHarness('{"comment":"none"}');

    await handleViewsRoutes(
      navigateCtx(runtime, "settings", { source: "user" }),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(proactiveFrames(frames)).toHaveLength(0);
  });

  it("turns a reported keyboard shortcut into a broadcast proactive-message", async () => {
    const { runtime, frames } = buildHarness(
      '{"comment":"Want a hand finding something?"}',
    );

    // POST /api/interactions/shortcut -> SHORTCUT_FIRED -> decider -> comment.
    await handleInteractionsRoutes(
      shortcutCtx(runtime, "open-command-palette"),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    const proactive = proactiveFrames(frames);
    expect(proactive).toHaveLength(1);
    expect((proactive[0].message as Frame).source).toBe(
      PROACTIVE_INTERACTION_SOURCE,
    );
  });
});

// Per-view anticipatory greeting (#13587). Each case drives the same real
// navigate → VIEW_SWITCHED → decider → gate → proactive-message chain, changing
// only the target view / initiator / chattiness — the reusable pattern a
// per-view child copies to assert its own emission or suppression.
describe("per-view anticipatory greeting (#13587)", () => {
  let savedKill: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedKill = process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    savedEnv = process.env.ELIZA_PROACTIVE_INTERACTIONS;
    delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    delete process.env.ELIZA_PROACTIVE_INTERACTIONS;
    registerBuiltinViews();
    clearCurrentViewState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    clearCurrentViewState();
    if (savedKill === undefined)
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    else process.env.ELIZA_DISABLE_PROACTIVE_AGENT = savedKill;
    if (savedEnv === undefined) delete process.env.ELIZA_PROACTIVE_INTERACTIONS;
    else process.env.ELIZA_PROACTIVE_INTERACTIONS = savedEnv;
    vi.restoreAllMocks();
  });

  it("(a) settings entry emits a greeting whose prompt carries the declared intent", async () => {
    const { runtime, frames, judgePrompts } = buildHarness(
      '{"comment":"Want to finish setting up your model provider?","confidence":0.9}',
    );

    await handleViewsRoutes(
      navigateCtx(runtime, "settings", { source: "user" }),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(proactiveFrames(frames)).toHaveLength(1);
    expect(judgePrompts[0]).toContain(
      "Declared intent: Offer to set up the model/provider",
    );
  });

  it("(b) documents entry greeting references live knowledge state in the judge prompt", async () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const { runtime, frames, judgePrompts } = buildHarness(
      '{"comment":"You have new attachments — want me to triage them?","confidence":0.9}',
      {
        documents: [
          {
            agentId: AGENT_ID,
            createdAt: now,
            metadata: {
              tags: ["attachment", "media-format:pdf"],
              addedAt: now,
            },
          },
        ],
      },
    );

    await handleViewsRoutes(
      navigateCtx(runtime, "documents", { source: "user" }),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(proactiveFrames(frames)).toHaveLength(1);
    expect(judgePrompts[0]).toContain("Live knowledge state");
    expect(judgePrompts[0]).toContain("1 ingested chat attachment");
    expect(judgePrompts[0]).toContain("pdf=1");
  });

  it("(c) a re-navigate within the global cooldown is suppressed by the gate", async () => {
    const { runtime, frames } = buildHarness(
      '{"comment":"An offer.","confidence":0.9}',
    );

    await handleViewsRoutes(
      navigateCtx(runtime, "settings", { source: "user" }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await handleViewsRoutes(
      navigateCtx(runtime, "automations", { source: "user" }),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(proactiveFrames(frames)).toHaveLength(1);
  });

  it("(d) chattiness=off suppresses the greeting (judge is never even asked)", async () => {
    const { runtime, frames, judgePrompts } = buildHarness(
      '{"comment":"An offer.","confidence":0.9}',
      { chattiness: "off" },
    );

    await handleViewsRoutes(
      navigateCtx(runtime, "settings", { source: "user" }),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(proactiveFrames(frames)).toHaveLength(0);
    expect(judgePrompts).toHaveLength(0);
  });

  it("(e) an agent-initiated switch produces no greeting (no double-talk with the ack)", async () => {
    const { runtime, frames } = buildHarness(
      '{"comment":"An offer.","confidence":0.9}',
    );

    await handleViewsRoutes(
      navigateCtx(runtime, "settings", { source: "agent" }),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(proactiveFrames(frames)).toHaveLength(0);
  });
});
