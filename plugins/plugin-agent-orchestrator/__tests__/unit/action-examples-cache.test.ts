/**
 * Verifies codingAgentExamplesProvider cache config.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { codingAgentExamplesProvider } from "../../src/providers/action-examples.js";

// #11028 audit: the provider embeds live framework state (recommendedDefault,
// configuredSubscriptionProvider) but was marked agent-stable, so a stale
// recommendation pinned for the whole session. It must recompute per turn.
describe("codingAgentExamplesProvider cache config", () => {
  it("is not agent-cached because its body carries live framework state", () => {
    expect(codingAgentExamplesProvider.cacheStable).toBe(false);
    expect(codingAgentExamplesProvider.cacheScope).toBe("turn");
  });
});
