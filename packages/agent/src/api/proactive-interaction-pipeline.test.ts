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
import {
  type EventPayload,
  EventType,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROACTIVE_CHATTINESS_SETTING_KEY,
  PROACTIVE_INTERACTION_SOURCE,
  registerProactiveInteractionDecider,
} from "../services/proactive-interaction-decider.ts";
import { ProactiveInteractionGate } from "../services/proactive-interaction-gate.ts";
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

function buildHarness(judgeOutput: string) {
  const events: Record<string, Handler[]> = {};
  const frames: Frame[] = [];
  const createdMemories: unknown[] = [];

  const runtime = {
    agentId: AGENT_ID,
    events,
    registerEvent(event: string, handler: Handler) {
      (events[event] ??= []).push(handler);
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
    useModel: vi.fn(async () => judgeOutput),
    getSetting: (key: string) =>
      key === PROACTIVE_CHATTINESS_SETTING_KEY ? "subtle" : undefined,
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
});
