import { describe, expect, it } from "bun:test";
import {
  buildTrustExperimentAgents,
  buildTrustExperimentManifest,
} from "../trust-experiment";

describe("trust experiment matrix", () => {
  it("builds a 100-agent matrix across requested model sizes", () => {
    const agents = buildTrustExperimentAgents({
      agentCount: 100,
      archetypeCount: 30,
      modelSizes: ["0.5b", "3b", "14b", "30b"],
    });

    expect(agents.length).toBe(100);
    expect(new Set(agents.map((agent) => agent.sheet.username)).size).toBe(100);
    expect(new Set(agents.map((agent) => agent.modelProfile.id)).size).toBe(4);
  });

  it("builds a manifest with aligned breakdown counts", () => {
    const manifest = buildTrustExperimentManifest({
      agentCount: 24,
      archetypeCount: 12,
      modelSizes: ["0.5b", "1.5b", "3b"],
      npcTargetCount: 150,
    });

    const totalFromBreakdown = Object.values(manifest.modelBreakdown).reduce(
      (sum, count) => sum + count,
      0,
    );

    expect(manifest.agentTargetCount).toBe(24);
    expect(manifest.npcTargetCount).toBe(150);
    expect(totalFromBreakdown).toBe(24);
  });

  it("keeps training model metadata while routing runtime through provider models", () => {
    const [agent] = buildTrustExperimentAgents({
      agentCount: 1,
      archetypeCount: 1,
      modelSizes: ["0.5b"],
    });

    expect(agent.sheet.settings.model).toBe("Qwen/Qwen2.5-0.5B-Instruct");
    expect(agent.sheet.settings.groq.primary).toBe("llama-3.1-8b-instant");
    expect(agent.sheet.feed.datasetTags).toContain(
      "runtime_model:llama-3.1-8b-instant",
    );
  });
});
