/**
 * Covers the proactive-interaction decider: how view-switch/shortcut/slash-command
 * events are turned into (or suppressed from) a proactive agent comment, judge
 * output parsing, prompt construction, per-event surface policy, and delivery
 * routing (chat vs notify) through `registerProactiveInteractionDecider`.
 * Deterministic — the LLM judge is an inline stub and the runtime is
 * `createMockRuntime`; no live model, real timers only where faked explicitly.
 */
import type {
  IAgentRuntime,
  ShortcutFiredPayload,
  SlashCommandInvokedPayload,
  ViewSwitchedPayload,
} from "@elizaos/core";
import { EventType } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProactiveJudgePrompt,
  decideProactiveComment,
  interactionSurface,
  parseProactiveJudgeDecisionOutput,
  parseProactiveJudgeOutput,
  registerProactiveInteractionDecider,
} from "./proactive-interaction-decider.ts";
import {
  configForChattiness,
  ProactiveInteractionGate,
} from "./proactive-interaction-gate.ts";

function payload(over: Partial<ViewSwitchedPayload> = {}): ViewSwitchedPayload {
  return {
    runtime: {} as IAgentRuntime,
    viewId: "wallet",
    viewLabel: "Wallet",
    initiatedBy: "user",
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("decideProactiveComment (#8792)", () => {
  it("returns the judge offer when user-initiated, settled, and admitted", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const res = await decideProactiveComment({
      payload: payload(),
      gate,
      judge: async () => "Want me to pull your latest balances?",
      now: 0,
    });
    expect(res.text).toBe("Want me to pull your latest balances?");
    expect(res.delivery).toBe("chat");
  });

  it("preserves notify delivery for low-urgency admitted offers", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const res = await decideProactiveComment({
      payload: payload(),
      gate,
      judge: async () => ({
        text: "I can summarize this view later.",
        delivery: "notify",
        title: "View suggestion",
      }),
      now: 0,
    });
    expect(res).toMatchObject({
      text: "I can summarize this view later.",
      delivery: "notify",
      title: "View suggestion",
    });
  });

  it("stays silent on agent-initiated switches (no double-talk with the ack)", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const res = await decideProactiveComment({
      payload: payload({ initiatedBy: "agent" }),
      gate,
      judge: async () => "Want me to pull your latest balances?",
      now: 0,
    });
    expect(res.text).toBeNull();
    expect(res.reason).toContain("agent-initiated");
  });

  it("stays silent when the judge has nothing to offer", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const res = await decideProactiveComment({
      payload: payload(),
      gate,
      judge: async () => null,
      now: 0,
    });
    expect(res.text).toBeNull();
    expect(res.reason).toContain("nothing helpful");
  });

  it("suppresses when the governance gate rejects (e.g. cooldown)", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const judge = async () => "offer A";
    // First user switch is admitted.
    expect(
      (
        await decideProactiveComment({
          payload: payload(),
          gate,
          judge,
          now: 0,
        })
      ).text,
    ).toBe("offer A");
    // A second switch to a different surface within the global cooldown is gated.
    const res = await decideProactiveComment({
      payload: payload({ viewId: "calendar", viewLabel: "Calendar" }),
      gate,
      judge: async () => "offer B",
      now: 30_000,
    });
    expect(res.text).toBeNull();
    expect(res.reason).toContain("cooldown");
  });

  it("debounces a burst: an immediate re-switch is not yet settled", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const judge = async () => "offer";
    // Pre-note a recent switch so the surface isn't settled at now=100.
    gate.noteSwitch("wallet", 0);
    const res = await decideProactiveComment({
      payload: payload(),
      gate,
      judge,
      now: 100,
    });
    expect(res.text).toBeNull();
    expect(res.reason).toContain("debounce");
  });
});

describe("parseProactiveJudgeOutput", () => {
  it("extracts a comment from JSON (string or object)", () => {
    expect(parseProactiveJudgeOutput('{"comment":"pull balances?"}')).toBe(
      "pull balances?",
    );
    expect(parseProactiveJudgeOutput({ comment: "do the thing" })).toBe(
      "do the thing",
    );
    expect(parseProactiveJudgeOutput('```json\n{"comment":"x"}\n```')).toBe(
      "x",
    );
  });

  it("treats none/null/empty/garbage as no offer", () => {
    expect(parseProactiveJudgeOutput('{"comment":"none"}')).toBeNull();
    expect(parseProactiveJudgeOutput('{"comment":null}')).toBeNull();
    expect(parseProactiveJudgeOutput('{"comment":"  "}')).toBeNull();
    expect(parseProactiveJudgeOutput("not json")).toBeNull();
    expect(parseProactiveJudgeOutput({})).toBeNull();
  });
});

describe("parseProactiveJudgeDecisionOutput", () => {
  it("extracts chat delivery by default", () => {
    expect(
      parseProactiveJudgeDecisionOutput('{"comment":"pull balances?"}'),
    ).toEqual({
      text: "pull balances?",
      delivery: "chat",
      title: undefined,
      deepLink: undefined,
      groupKey: undefined,
    });
  });

  it("extracts notify delivery metadata", () => {
    expect(
      parseProactiveJudgeDecisionOutput(
        '{"comment":"I can summarize this later.","delivery":"notify","title":"Suggestion","deepLink":"/tasks","groupKey":"view:tasks"}',
      ),
    ).toEqual({
      text: "I can summarize this later.",
      delivery: "notify",
      title: "Suggestion",
      deepLink: "/tasks",
      groupKey: "view:tasks",
    });
  });

  it("treats low-confidence judge output as silence", () => {
    expect(
      parseProactiveJudgeDecisionOutput(
        '{"comment":"Want help here?","confidence":0.42}',
      ),
    ).toBeNull();
  });

  it("routes low-urgency judge output to notifications", () => {
    expect(
      parseProactiveJudgeDecisionOutput(
        '{"comment":"I can summarize this later.","delivery":"chat","urgency":"low"}',
      ),
    ).toEqual({
      text: "I can summarize this later.",
      delivery: "notify",
      title: undefined,
      deepLink: undefined,
      groupKey: undefined,
    });
  });
});

describe("buildProactiveJudgePrompt", () => {
  it("names the switched view in the prompt", () => {
    const p = buildProactiveJudgePrompt(payload({ viewLabel: "Calendar" }));
    expect(p).toContain("Calendar");
    expect(p).toContain('{"comment":');
  });
  it("names the shortcut in the prompt", () => {
    const shortcut: ShortcutFiredPayload = {
      runtime: {} as IAgentRuntime,
      shortcutId: "open-wallet",
      initiatedBy: "user",
    };
    expect(buildProactiveJudgePrompt(shortcut)).toContain("open-wallet");
  });
});

describe("interactionSurface — per-event policy (#8792)", () => {
  it("keys a view switch on its view id", () => {
    expect(interactionSurface(payload({ viewId: "wallet" }))).toBe("wallet");
  });
  it("keys a shortcut on its id", () => {
    const shortcut: ShortcutFiredPayload = {
      runtime: {} as IAgentRuntime,
      shortcutId: "open-wallet",
      initiatedBy: "user",
    };
    expect(interactionSurface(shortcut)).toBe("shortcut:open-wallet");
  });
  it("stays silent on explicitly-typed slash commands (no double-talk)", () => {
    const slash: SlashCommandInvokedPayload = {
      runtime: {} as IAgentRuntime,
      command: "status",
      targetKind: "agent",
      initiatedBy: "user",
    };
    expect(interactionSurface(slash)).toBeNull();
  });
  it("denies control/dismiss/help shortcuts before the judge (no surface)", () => {
    for (const id of [
      "close-modal",
      "send-message",
      "focus-composer",
      "pause-resume-agent",
      "restart-agent",
      "toggle-terminal",
      "show-keyboard-shortcuts",
    ]) {
      const shortcut: ShortcutFiredPayload = {
        runtime: {} as IAgentRuntime,
        shortcutId: id,
        initiatedBy: "user",
      };
      expect(interactionSurface(shortcut)).toBeNull();
    }
  });
});

describe("decideProactiveComment — new interaction types", () => {
  it("judges a user-initiated shortcut and admits the offer", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const shortcut: ShortcutFiredPayload = {
      runtime: {} as IAgentRuntime,
      shortcutId: "open-wallet",
      initiatedBy: "user",
    };
    const res = await decideProactiveComment({
      payload: shortcut,
      gate,
      judge: async () => "Want your balances?",
      now: 0,
    });
    expect(res.text).toBe("Want your balances?");
  });

  it("never comments on a slash command (policy-silent), even with a judge offer", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("chatty"));
    const slash: SlashCommandInvokedPayload = {
      runtime: {} as IAgentRuntime,
      command: "status",
      targetKind: "agent",
      initiatedBy: "user",
    };
    const res = await decideProactiveComment({
      payload: slash,
      gate,
      judge: async () => "I could do X",
      now: 0,
    });
    expect(res.text).toBeNull();
    expect(res.reason).toContain("policy-silent");
  });
});

describe("registerProactiveInteractionDecider delivery routing", () => {
  it("suppresses comments while a foreground chat turn is active", async () => {
    const handlers = new Map<EventType, (payload: unknown) => Promise<void>>();
    const runtime = createMockRuntime({
      getSetting: () => "chatty",
      registerEvent: vi.fn((event: EventType, handler) => {
        handlers.set(event, handler as (payload: unknown) => Promise<void>);
      }),
      useModel: vi.fn().mockResolvedValue(
        JSON.stringify({
          comment: "Want help with this view?",
          delivery: "chat",
        }),
      ),
    });
    const route = vi.fn();

    registerProactiveInteractionDecider(runtime, {
      gate: new ProactiveInteractionGate(configForChattiness("chatty")),
      route,
      shouldSuppress: () => true,
    });

    await handlers.get(EventType.VIEW_SWITCHED)?.(payload());

    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it("routes notify delivery to notifications instead of chat", async () => {
    vi.useFakeTimers();
    let now = 0;
    const handlers = new Map<EventType, (payload: unknown) => Promise<void>>();
    const runtime = createMockRuntime({
      getSetting: () => "chatty",
      registerEvent: vi.fn((event: EventType, handler) => {
        handlers.set(event, handler as (payload: unknown) => Promise<void>);
      }),
      useModel: vi.fn().mockResolvedValue(
        JSON.stringify({
          comment: "I can summarize this view later.",
          delivery: "notify",
          title: "View suggestion",
        }),
      ),
    });
    const route = vi.fn();
    const notify = vi.fn();

    registerProactiveInteractionDecider(runtime, {
      gate: new ProactiveInteractionGate(configForChattiness("chatty")),
      route,
      notify,
      now: () => now,
    });

    await handlers.get(EventType.VIEW_SWITCHED)?.(payload());
    now = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(route).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I can summarize this view later.",
        delivery: "notify",
        title: "View suggestion",
      }),
    );
  });
});
