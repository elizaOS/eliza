import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  renderGroundedActionReply: vi.fn(async () => "rewritten reply"),
}));

vi.mock("@elizaos/agent", () => ({
  renderGroundedActionReply: mocks.renderGroundedActionReply,
}));

import { messageText, renderLifeOpsActionReply } from "./grounded-reply";

const baseArgs = {
  runtime: {},
  message: { content: { text: "show my screen time" } },
  state: undefined,
  intent: "show my screen time",
  scenario: "screen_time_summary",
  fallback: "Here is your screen time summary.",
};

describe("renderLifeOpsActionReply", () => {
  it("passes all args through with the lifeops domain and character voice defaults", async () => {
    await renderLifeOpsActionReply({
      ...baseArgs,
      context: { totalSeconds: 3600 },
      additionalRules: ["keep it short"],
    });
    expect(mocks.renderGroundedActionReply).toHaveBeenCalledWith({
      runtime: baseArgs.runtime,
      message: baseArgs.message,
      state: baseArgs.state,
      intent: baseArgs.intent,
      domain: "lifeops",
      scenario: baseArgs.scenario,
      fallback: baseArgs.fallback,
      context: { totalSeconds: 3600 },
      additionalRules: ["keep it short"],
      preferCharacterVoice: true,
    });
  });

  it("defaults context and additionalRules to undefined when omitted", async () => {
    await renderLifeOpsActionReply(baseArgs);
    expect(mocks.renderGroundedActionReply).toHaveBeenCalledWith({
      runtime: baseArgs.runtime,
      message: baseArgs.message,
      state: baseArgs.state,
      intent: baseArgs.intent,
      domain: "lifeops",
      scenario: baseArgs.scenario,
      fallback: baseArgs.fallback,
      context: undefined,
      additionalRules: undefined,
      preferCharacterVoice: true,
    });
  });

  it("returns whatever the underlying rewriter produces", async () => {
    await expect(renderLifeOpsActionReply(baseArgs)).resolves.toBe(
      "rewritten reply",
    );
  });
});

describe("messageText", () => {
  it("returns the text verbatim for string content", () => {
    expect(messageText({ content: { text: "hello" } })).toBe("hello");
  });

  it("returns an empty string when content text is missing", () => {
    expect(messageText({ content: {} })).toBe("");
  });

  it("returns an empty string when content text is not a string", () => {
    expect(messageText({ content: { text: 42 } })).toBe("");
  });
});
