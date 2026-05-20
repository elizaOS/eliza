import { describe, expect, test } from "bun:test";
import { feedPlugin } from "../index";

describe("feedPlugin social context wiring", () => {
  test("exports the shared chat context providers and evaluator", () => {
    const providerNames =
      feedPlugin.providers?.map((provider) => provider.name) ?? [];
    const evaluatorNames =
      feedPlugin.evaluators?.map((evaluator) => evaluator.name) ?? [];

    expect(providerNames).toContain("SHARED_CHAT_FACTS");
    expect(providerNames).toContain("RECENT_RELEVANT_GROUP_CONTEXT");
    expect(providerNames).toContain("LIVE_PLAYER_ROSTER");
    expect(evaluatorNames).toContain("SHARED_CHAT_CONTEXT_EVALUATOR");
  });
});
