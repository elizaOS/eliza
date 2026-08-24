import { describe, expect, it } from "vitest";
import {
  HUMAN_ONLY_ORCHESTRATOR_CAPABILITY_IDS,
  isHumanOnlyOrchestratorCapability,
} from "./orchestrator-capability-authority.ts";

describe("isHumanOnlyOrchestratorCapability", () => {
  it("accepts all human-only capability ids", () => {
    for (const id of HUMAN_ONLY_ORCHESTRATOR_CAPABILITY_IDS) {
      expect(isHumanOnlyOrchestratorCapability(id)).toBe(true);
    }
  });

  it("rejects agent-callable capabilities", () => {
    expect(isHumanOnlyOrchestratorCapability("orchestrator-create-task")).toBe(
      false,
    );
    expect(isHumanOnlyOrchestratorCapability("")).toBe(false);
    expect(isHumanOnlyOrchestratorCapability("anything")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(isHumanOnlyOrchestratorCapability("Orchestrator-Pause-Task")).toBe(
      false,
    );
  });
});
