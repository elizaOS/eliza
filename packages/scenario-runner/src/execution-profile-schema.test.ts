/**
 * Validates the scenario execution-profile trust boundary, including the
 * backward-compatible simulated default and live-only provider qualification.
 */

import {
  DEFAULT_SCENARIO_EVIDENCE_SCOPE,
  DEFAULT_SCENARIO_EXECUTION_PROFILE,
  isScenarioEvidenceScope,
  isScenarioExecutionProfile,
  type ScenarioDefinition,
  scenario,
  scenarioEvidenceScope,
  scenarioEvidenceScopeLabel,
  scenarioExecutionProfile,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";

const base = {
  id: "fixture.execution-profile",
  title: "Execution profile fixture",
  domain: "fixture",
  turns: [],
} satisfies ScenarioDefinition;

describe("scenario execution profile", () => {
  it("keeps legacy definitions simulated and therefore non-provider-qualified", () => {
    expect(DEFAULT_SCENARIO_EXECUTION_PROFILE).toBe("simulated");
    expect(scenarioExecutionProfile(base)).toBe("simulated");
    expect(scenario(base)).toBe(base);
  });

  it("accepts the two closed profile values and exposes a reusable guard", () => {
    expect(isScenarioExecutionProfile("simulated")).toBe(true);
    expect(isScenarioExecutionProfile("provider-qualified")).toBe(true);
    expect(isScenarioExecutionProfile("live")).toBe(false);
    expect(isScenarioExecutionProfile({ profile: "provider-qualified" })).toBe(
      false,
    );
    expect(
      scenarioExecutionProfile({
        ...base,
        executionProfile: "provider-qualified",
      }),
    ).toBe("provider-qualified");
  });

  it("rejects provider qualification in deterministic lanes", () => {
    expect(() =>
      scenario({
        ...base,
        lane: "pr-deterministic",
        executionProfile: "provider-qualified",
      }),
    ).toThrow(/provider-qualified scenarios must be live-only/);
  });

  it("rejects typoed and object-shaped profile claims at runtime", () => {
    for (const executionProfile of [
      "provider",
      "provider_qualified",
      { mode: "provider-qualified" },
    ]) {
      expect(() =>
        scenario({
          ...base,
          executionProfile,
        } as unknown as ScenarioDefinition),
      ).toThrow(/invalid executionProfile/);
    }
  });
});

describe("scenario evidence scope", () => {
  it("defaults legacy definitions conservatively without claiming an integration", () => {
    expect(DEFAULT_SCENARIO_EVIDENCE_SCOPE).toBe("runner-fixture");
    expect(scenarioEvidenceScope(base)).toBe("runner-fixture");
    expect(scenarioEvidenceScopeLabel("runner-fixture")).toContain(
      "diagnostic only",
    );
  });

  it("accepts only the five closed scope values", () => {
    for (const evidenceScope of [
      "runner-fixture",
      "domain-contract",
      "model-behavior",
      "connector-contract",
      "provider-certification",
    ]) {
      expect(isScenarioEvidenceScope(evidenceScope)).toBe(true);
    }
    expect(isScenarioEvidenceScope("end-to-end")).toBe(false);
    expect(() =>
      scenario({
        ...base,
        evidenceScope: "real-provider",
      } as unknown as ScenarioDefinition),
    ).toThrow(/invalid evidenceScope/);
  });

  it("binds provider certification bidirectionally to qualified execution", () => {
    expect(() =>
      scenario({
        ...base,
        evidenceScope: "provider-certification",
      }),
    ).toThrow(/incompatible evidenceScope/);
    expect(() =>
      scenario({
        ...base,
        executionProfile: "provider-qualified",
        evidenceScope: "connector-contract",
      }),
    ).toThrow(/incompatible evidenceScope/);
    expect(
      scenarioEvidenceScope({
        ...base,
        executionProfile: "provider-qualified",
        evidenceScope: "provider-certification",
      }),
    ).toBe("provider-certification");
  });
});

describe("trusted-observation final-check schema", () => {
  it("accepts the closed observation checks and shared provenance filters", () => {
    expect(() =>
      scenario({
        ...base,
        finalChecks: [
          {
            type: "durableApprovalObserved",
            observerId: "approval-db",
            operation: "calendar.create",
            state: ["pending", "approved"],
            minCount: 1,
          },
          {
            type: "durableDraftObserved",
            provider: "imessage",
            accountId: "parent-account",
            resourceId: "draft-1",
          },
          {
            type: "providerEffectObserved",
            provider: "google-calendar",
            operation: "create",
          },
          {
            type: "providerNoEffectObserved",
            provider: "imessage",
            intervalCoversScenario: true,
          },
          {
            type: "scheduledTaskObserved",
            observerId: "scheduler",
            state: "completed",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects fields that could fall back to action-result assertions", () => {
    expect(() =>
      scenario({
        ...base,
        finalChecks: [
          {
            type: "providerEffectObserved",
            actionResultIncludes: "sent",
          },
        ],
      } as unknown as ScenarioDefinition),
    ).toThrow(/unknown field\(s\): actionResultIncludes/);
  });
});
