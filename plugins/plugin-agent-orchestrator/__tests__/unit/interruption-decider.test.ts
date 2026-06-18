import { describe, expect, it } from "vitest";
import { decideInterruption } from "../../src/services/interruption-decider.js";

const base = { agentType: "claude", agentLabel: "Ada" } as const;

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
});
