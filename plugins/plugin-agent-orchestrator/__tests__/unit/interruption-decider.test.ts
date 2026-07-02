import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  decideInterruption,
  decideInterruptionWithModel,
} from "../../src/services/interruption-decider.js";

const base = { agentType: "claude", agentLabel: "Ada" } as const;

/** Minimal runtime exposing only `useModel`, which is all the classifier uses. */
function runtimeWithModel(
  useModel: (type: unknown, params: unknown) => Promise<unknown>,
): IAgentRuntime {
  return { useModel: vi.fn(useModel) } as unknown as IAgentRuntime;
}

describe("decideInterruption", () => {
  it("ignores empty text", () => {
    expect(
      decideInterruption({ ...base, text: "   ", sessionBusy: true }).action,
    ).toBe("ignore");
  });

  it("interrupts on an explicit stop, busy or idle", () => {
    expect(
      decideInterruption({ ...base, text: "stop", sessionBusy: true }).action,
    ).toBe("interrupt");
    expect(
      decideInterruption({
        ...base,
        text: "actually cancel that",
        sessionBusy: false,
      }).action,
    ).toBe("interrupt");
  });

  it("does NOT interrupt on an unaddressed ambient stop in a multi-party room", () => {
    // Another participant's "stop" chatter must not cancel this agent's turn.
    expect(
      decideInterruption({
        ...base,
        text: "stop",
        sessionBusy: true,
        multiParty: true,
      }).action,
    ).toBe("ignore");
    // ...but an ADDRESSED stop in the same room still interrupts.
    expect(
      decideInterruption({
        ...base,
        text: "Ada, stop",
        sessionBusy: true,
        multiParty: true,
      }).action,
    ).toBe("interrupt");
    // ...and in a solo room any stop interrupts (no ambient ambiguity).
    expect(
      decideInterruption({
        ...base,
        text: "stop",
        sessionBusy: true,
        multiParty: false,
      }).action,
    ).toBe("interrupt");
  });

  it("delivers to an idle agent", () => {
    expect(
      decideInterruption({
        ...base,
        text: "add a test for the parser",
        sessionBusy: false,
      }).action,
    ).toBe("deliver");
  });

  it("queues a normal message while the agent is mid-turn", () => {
    expect(
      decideInterruption({
        ...base,
        text: "also handle the empty case",
        sessionBusy: true,
      }).action,
    ).toBe("queue");
  });

  it("interrupts on an addressed course-correction mid-turn", () => {
    expect(
      decideInterruption({
        ...base,
        text: "Ada, actually don't touch the schema",
        sessionBusy: true,
      }).action,
    ).toBe("interrupt");
  });

  it("queues (does NOT interrupt) addressed ADDITIVE instructions mid-turn", () => {
    // "actually" / "don't" appear in benign additive instructions — these must
    // augment after the turn, not cancel it.
    for (const text of [
      "Ada, actually also handle the null case",
      "Ada, don't forget tests",
      "Ada, and also add docs",
    ]) {
      expect(
        decideInterruption({ ...base, text, sessionBusy: true }).action,
      ).toBe("queue");
    }
  });

  it("ignores ambient chatter not addressed to the agent in a crowded room", () => {
    expect(
      decideInterruption({
        ...base,
        text: "lol nice",
        sessionBusy: true,
        multiParty: true,
      }).action,
    ).toBe("ignore");
    expect(
      decideInterruption({
        ...base,
        text: "what's for lunch",
        sessionBusy: false,
        multiParty: true,
      }).action,
    ).toBe("ignore");
  });

  it("threads an Eliza shouldRespond verdict through unchanged", () => {
    expect(
      decideInterruption({
        agentType: "elizaos",
        text: "hey",
        sessionBusy: true,
        shouldRespond: "STOP",
      }).action,
    ).toBe("interrupt");
    expect(
      decideInterruption({
        agentType: "elizaos",
        text: "hey",
        sessionBusy: false,
        shouldRespond: "IGNORE",
      }).action,
    ).toBe("ignore");
    expect(
      decideInterruption({
        agentType: "elizaos",
        text: "hey",
        sessionBusy: false,
        shouldRespond: "RESPOND",
      }).action,
    ).toBe("deliver");
    expect(
      decideInterruption({
        agentType: "elizaos",
        text: "hey",
        sessionBusy: true,
        shouldRespond: "RESPOND",
      }).action,
    ).toBe("queue");
  });

  it("does NOT cancel a live turn for a 'stop <code-action>' instruction", () => {
    // "stop using axios" changes the code, it is not "stop working" — it must
    // reach the agent after the turn (queue), never cancel the in-flight turn.
    expect(
      decideInterruption({
        ...base,
        text: "let's stop using axios, switch to fetch",
        sessionBusy: true,
      }).action,
    ).toBe("queue");
    expect(
      decideInterruption({
        ...base,
        text: "stop importing lodash everywhere",
        sessionBusy: true,
      }).action,
    ).toBe("queue");
    // ...but a genuine halt still interrupts.
    expect(
      decideInterruption({ ...base, text: "stop working", sessionBusy: true })
        .action,
    ).toBe("interrupt");
    expect(
      decideInterruption({ ...base, text: "stop", sessionBusy: true }).action,
    ).toBe("interrupt");
  });
});

describe("decideInterruptionWithModel", () => {
  it("skips the model for empty text (ignore)", async () => {
    const useModel = vi.fn(async () => "{}");
    const decision = await decideInterruptionWithModel(
      runtimeWithModel(useModel),
      { ...base, text: "   ", sessionBusy: true },
    );
    expect(decision.action).toBe("ignore");
    expect(useModel).not.toHaveBeenCalled();
  });

  it("skips the model for an idle agent in a solo room (deliver via regex)", async () => {
    const useModel = vi.fn(async () => "{}");
    const decision = await decideInterruptionWithModel(
      runtimeWithModel(useModel),
      { ...base, text: "add a dark mode toggle", sessionBusy: false },
    );
    expect(decision.action).toBe("deliver");
    expect(useModel).not.toHaveBeenCalled();
  });

  it("consults the model mid-turn and uses its verdict", async () => {
    const useModel = vi.fn(async () =>
      JSON.stringify({ action: "queue", reason: "additive test request" }),
    );
    const decision = await decideInterruptionWithModel(
      runtimeWithModel(useModel),
      {
        ...base,
        text: "also add unit tests for the parser",
        sessionBusy: true,
      },
    );
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(decision.action).toBe("queue");
    expect(decision.reason).toMatch(/^model:/);
  });

  it("lets the model interrupt for a semantic redirect the regex would only queue", async () => {
    // "let's rework this to use Postgres" has no STOP/REDIRECT regex token, so
    // the pure decider queues it; the model recognizes a direction-invalidating
    // redirect and interrupts.
    const regex = decideInterruption({
      ...base,
      text: "let's rework this to use Postgres",
      sessionBusy: true,
    });
    expect(regex.action).toBe("queue");
    const useModel = vi.fn(async () =>
      JSON.stringify({ action: "interrupt", reason: "invalidating redirect" }),
    );
    const decision = await decideInterruptionWithModel(
      runtimeWithModel(useModel),
      { ...base, text: "let's rework this to use Postgres", sessionBusy: true },
    );
    expect(decision.action).toBe("interrupt");
  });

  it("falls back to the regex decision when the model throws", async () => {
    const useModel = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const decision = await decideInterruptionWithModel(
      runtimeWithModel(useModel),
      { ...base, text: "stop", sessionBusy: true },
    );
    // Regex still interrupts on a bare "stop".
    expect(decision.action).toBe("interrupt");
  });

  it("falls back to the regex decision on an unparseable / invalid verdict", async () => {
    const useModel = vi.fn(async () =>
      JSON.stringify({ action: "banana", reason: "nonsense" }),
    );
    const decision = await decideInterruptionWithModel(
      runtimeWithModel(useModel),
      { ...base, text: "also add tests", sessionBusy: true },
    );
    // Invalid action → regex fallback (mid-turn relevant → queue).
    expect(decision.action).toBe("queue");
  });
});
