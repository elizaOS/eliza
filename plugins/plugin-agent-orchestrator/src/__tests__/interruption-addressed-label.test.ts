import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  decideInterruption,
  decideInterruptionWithModel,
} from "../services/interruption-decider.js";

const room = { agentType: "codex", multiParty: true } as const;

describe("interruption decider addressing", () => {
  it("treats a non-ASCII agent label as addressed in a crowded room", () => {
    for (const [agentLabel, text] of [
      ["민수", "민수, README도 고쳐줘"],
      ["민수", "민수야 README도 고쳐줘"],
      ["Zoë", "Zoë, please also update the README"],
      ["Zoë", "zoë can you check the tests"],
    ] as const) {
      expect(
        decideInterruption({ ...room, text, agentLabel, sessionBusy: false }),
        text,
      ).toEqual({ action: "deliver", reason: "agent idle" });
    }
    expect(
      decideInterruption({
        ...room,
        text: "Zoë, stop",
        agentLabel: "Zoë",
        sessionBusy: true,
      }),
    ).toEqual({ action: "interrupt", reason: "explicit stop/cancel" });
  });

  it("still ignores a message that names someone else", () => {
    expect(
      decideInterruption({
        ...room,
        text: "지호, README도 고쳐줘",
        agentLabel: "민수",
        sessionBusy: false,
      }),
    ).toEqual({ action: "ignore", reason: "ambient chatter, agent idle" });
  });

  it("keeps whole-word matching for ASCII labels", () => {
    expect(
      decideInterruption({
        ...room,
        text: "Adam, stop",
        agentLabel: "Ada",
        sessionBusy: true,
      }).action,
    ).not.toBe("interrupt");
    expect(
      decideInterruption({
        ...room,
        text: "Ada, stop",
        agentLabel: "Ada",
        sessionBusy: true,
      }).action,
    ).toBe("interrupt");
  });

  it("falls back to the same addressing when the model is unavailable", async () => {
    const runtime = {
      useModel: async () => {
        throw new Error("model unavailable");
      },
    } as unknown as IAgentRuntime;
    await expect(
      decideInterruptionWithModel(runtime, {
        ...room,
        text: "민수, README도 고쳐줘",
        agentLabel: "민수",
        sessionBusy: false,
      }),
    ).resolves.toEqual({ action: "deliver", reason: "agent idle" });
  });
});
