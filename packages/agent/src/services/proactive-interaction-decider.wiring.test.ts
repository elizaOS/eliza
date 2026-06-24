/**
 * Wiring test for `registerProactiveInteractionDecider` (#8792).
 *
 * The pure policy (`decideProactiveComment`) and the governance gate are unit
 * tested next door. THIS file exercises the runtime wiring that connects them:
 * the event-bus subscription, the small-model judge, the debounce timer, the
 * kill-switch short-circuit, and the per-event-type routing — using a faithful
 * fake runtime whose `registerEvent`/`emitEvent` mirror AgentRuntime's dispatch
 * (handlers stored per event name, all awaited on emit).
 */
import type { EventPayload, IAgentRuntime } from "@elizaos/core";
import { EventType, ModelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROACTIVE_CHATTINESS_SETTING_KEY,
  registerProactiveInteractionDecider,
} from "./proactive-interaction-decider.ts";
import { ProactiveInteractionGate } from "./proactive-interaction-gate.ts";

type Handler = (params: EventPayload) => Promise<void> | void;

interface FakeRuntimeOptions {
  /** Value returned for the chattiness setting (off/subtle/chatty), or undefined. */
  chattiness?: string;
  /** Raw judge model output, or a thrower to simulate a model failure. */
  useModel?: () => unknown | Promise<unknown>;
}

interface FakeRuntime {
  events: Record<string, Handler[]>;
  registerEvent: (event: string, handler: Handler) => void;
  emitEvent: (event: string, params: Record<string, unknown>) => Promise<void>;
  useModel: ReturnType<typeof vi.fn>;
  getSetting: (key: string) => string | undefined;
  /** Test-only: mutate the live chattiness setting mid-session. */
  setChattiness: (next: string | undefined) => void;
}

function makeRuntime(opts: FakeRuntimeOptions = {}): FakeRuntime {
  const events: Record<string, Handler[]> = {};
  let chattiness = opts.chattiness;
  const rt: FakeRuntime = {
    events,
    registerEvent(event, handler) {
      let handlers = events[event];
      if (!handlers) {
        handlers = [];
        events[event] = handlers;
      }
      handlers.push(handler);
    },
    async emitEvent(event, params) {
      const handlers = events[event];
      if (!handlers) return;
      // Mirror AgentRuntime.emitEvent: inject runtime + source, await all.
      const payload = {
        ...params,
        runtime: rt as unknown as IAgentRuntime,
        source: typeof params.source === "string" ? params.source : "test",
      } as EventPayload;
      await Promise.all(handlers.map((h) => h(payload)));
    },
    useModel: vi.fn(async () => {
      const fn = opts.useModel ?? (() => '{"comment":"Want your balances?"}');
      return await fn();
    }),
    getSetting(key) {
      if (key === PROACTIVE_CHATTINESS_SETTING_KEY) return chattiness;
      return undefined;
    },
    setChattiness(next) {
      chattiness = next;
    },
  };
  return rt;
}

/** Emit an interaction then flush the decider's debounce timer + judge chain. */
async function emitAndSettle(
  rt: FakeRuntime,
  event: EventType,
  params: Record<string, unknown>,
): Promise<void> {
  await rt.emitEvent(event, params);
  // Advance past the largest configured debounce (chatty=1000, subtle=1500) and
  // flush the fire-and-forget async run chain (judge + gate + route).
  await vi.advanceTimersByTimeAsync(2_000);
}

describe("registerProactiveInteractionDecider — runtime wiring (#8792)", () => {
  let savedKill: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    // The gate resolver consults process.env; isolate the test from the host's
    // kill-switch / chattiness env so getSetting is the only knob in play.
    savedKill = process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    savedEnv = process.env.ELIZA_PROACTIVE_INTERACTIONS;
    delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    delete process.env.ELIZA_PROACTIVE_INTERACTIONS;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedKill === undefined)
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    else process.env.ELIZA_DISABLE_PROACTIVE_AGENT = savedKill;
    if (savedEnv === undefined) delete process.env.ELIZA_PROACTIVE_INTERACTIONS;
    else process.env.ELIZA_PROACTIVE_INTERACTIONS = savedEnv;
    vi.restoreAllMocks();
  });

  function wire(rt: FakeRuntime): {
    routed: string[];
    gate: ProactiveInteractionGate;
  } {
    const routed: string[] = [];
    const gate = new ProactiveInteractionGate();
    registerProactiveInteractionDecider(rt as unknown as IAgentRuntime, {
      gate,
      route: async (text) => {
        routed.push(text);
      },
    });
    return { routed, gate };
  }

  it("routes a model-judged comment for a user-initiated view switch", async () => {
    const rt = makeRuntime({ chattiness: "subtle" });
    const { routed } = wire(rt);

    await emitAndSettle(rt, EventType.VIEW_SWITCHED, {
      viewId: "wallet",
      viewLabel: "Wallet",
      initiatedBy: "user",
    });

    expect(routed).toEqual(["Want your balances?"]);
    expect(rt.useModel).toHaveBeenCalledWith(
      ModelType.TEXT_SMALL,
      expect.objectContaining({ prompt: expect.stringContaining("Wallet") }),
    );
  });

  it("stays silent on an agent-initiated switch (no double-talk with the ack)", async () => {
    const rt = makeRuntime({ chattiness: "subtle" });
    const { routed } = wire(rt);

    await emitAndSettle(rt, EventType.VIEW_SWITCHED, {
      viewId: "wallet",
      viewLabel: "Wallet",
      initiatedBy: "agent",
    });

    expect(routed).toEqual([]);
  });

  it("routes a comment for a user-initiated shortcut", async () => {
    const rt = makeRuntime({ chattiness: "subtle" });
    const { routed } = wire(rt);

    await emitAndSettle(rt, EventType.SHORTCUT_FIRED, {
      shortcutId: "open-wallet",
      initiatedBy: "user",
    });

    expect(routed).toEqual(["Want your balances?"]);
  });

  it("never judges or comments on a control/dismiss shortcut (deny-list)", async () => {
    const rt = makeRuntime({ chattiness: "chatty" });
    const { routed } = wire(rt);

    await emitAndSettle(rt, EventType.SHORTCUT_FIRED, {
      shortcutId: "restart-agent",
      initiatedBy: "user",
    });

    expect(routed).toEqual([]);
    // Denied before the judge — no TEXT_SMALL spend on a control gesture.
    expect(rt.useModel).not.toHaveBeenCalled();
  });

  it("never comments on a slash command even when subscribed (policy-silent)", async () => {
    const rt = makeRuntime({ chattiness: "chatty" });
    const { routed } = wire(rt);

    await emitAndSettle(rt, EventType.SLASH_COMMAND_INVOKED, {
      command: "wallet",
      targetKind: "navigate",
      initiatedBy: "user",
    });

    expect(routed).toEqual([]);
    // The judge is never even consulted for a policy-silent surface.
    expect(rt.useModel).not.toHaveBeenCalled();
  });

  it("never routes when chattiness is off (subscribed, but gated live)", async () => {
    const rt = makeRuntime({ chattiness: "off" });
    const { routed } = wire(rt);

    // It still subscribes — the setting is re-resolved per interaction so it can
    // flip on live — but an "off" config short-circuits before the judge runs.
    expect(rt.events[EventType.VIEW_SWITCHED]).toBeDefined();
    await emitAndSettle(rt, EventType.VIEW_SWITCHED, {
      viewId: "wallet",
      viewLabel: "Wallet",
      initiatedBy: "user",
    });
    expect(routed).toEqual([]);
    expect(rt.useModel).not.toHaveBeenCalled();
  });

  it("honors the env kill-switch (ELIZA_DISABLE_PROACTIVE_AGENT) over the setting", async () => {
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
    const rt = makeRuntime({ chattiness: "chatty" });
    const { routed } = wire(rt);

    await emitAndSettle(rt, EventType.VIEW_SWITCHED, {
      viewId: "wallet",
      viewLabel: "Wallet",
      initiatedBy: "user",
    });
    expect(routed).toEqual([]);
  });

  it("applies a live off → subtle setting change without re-wiring (per-interaction re-resolve)", async () => {
    const rt = makeRuntime({ chattiness: "off" });
    const { routed } = wire(rt);

    await emitAndSettle(rt, EventType.VIEW_SWITCHED, {
      viewId: "wallet",
      viewLabel: "Wallet",
      initiatedBy: "user",
    });
    expect(routed).toEqual([]);

    // The user turns suggestions on; the very next interaction comments.
    rt.setChattiness("subtle");
    await emitAndSettle(rt, EventType.VIEW_SWITCHED, {
      viewId: "calendar",
      viewLabel: "Calendar",
      initiatedBy: "user",
    });
    expect(routed).toEqual(["Want your balances?"]);
  });

  it("enforces the global cooldown across a burst of distinct surfaces", async () => {
    const rt = makeRuntime({ chattiness: "subtle" });
    const { routed } = wire(rt);

    await emitAndSettle(rt, EventType.VIEW_SWITCHED, {
      viewId: "wallet",
      viewLabel: "Wallet",
      initiatedBy: "user",
    });
    // A second, different surface seconds later is gated by the global cooldown.
    await emitAndSettle(rt, EventType.VIEW_SWITCHED, {
      viewId: "calendar",
      viewLabel: "Calendar",
      initiatedBy: "user",
    });

    expect(routed).toEqual(["Want your balances?"]);
  });

  it("degrades silently when the judge model throws (a failure never breaks the interaction)", async () => {
    const rt = makeRuntime({
      chattiness: "subtle",
      useModel: () => {
        throw new Error("model offline");
      },
    });
    const { routed } = wire(rt);

    await expect(
      emitAndSettle(rt, EventType.VIEW_SWITCHED, {
        viewId: "wallet",
        viewLabel: "Wallet",
        initiatedBy: "user",
      }),
    ).resolves.toBeUndefined();
    expect(routed).toEqual([]);
  });

  it("stays silent when the judge declines (comment: none)", async () => {
    const rt = makeRuntime({
      chattiness: "subtle",
      useModel: () => '{"comment":"none"}',
    });
    const { routed } = wire(rt);

    await emitAndSettle(rt, EventType.VIEW_SWITCHED, {
      viewId: "settings",
      viewLabel: "Settings",
      initiatedBy: "user",
    });

    expect(routed).toEqual([]);
  });
});
