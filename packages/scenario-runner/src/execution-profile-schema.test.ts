/**
 * Validates the scenario execution-profile trust boundary, including the
 * backward-compatible simulated default and live-only provider qualification.
 */

import {
  DEFAULT_SCENARIO_CERTIFICATION_CLASS,
  DEFAULT_SCENARIO_EVIDENCE_CLASS,
  DEFAULT_SCENARIO_EXECUTION_PROFILE,
  isScenarioExecutionProfile,
  type ScenarioDefinition,
  scenario,
  scenarioCertificationClass,
  scenarioEvidenceClass,
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

describe("scenario evidence and certification classes", () => {
  it("keeps legacy scenarios explicitly non-certifying", () => {
    expect(DEFAULT_SCENARIO_EVIDENCE_CLASS).toBe("simulated");
    expect(DEFAULT_SCENARIO_CERTIFICATION_CLASS).toBe("none");
    expect(scenarioEvidenceClass(base)).toBe("simulated");
    expect(scenarioCertificationClass(base)).toBe("none");
  });

  it("accepts deterministic runtime-contract coverage without inflating it to provider proof", () => {
    const definition = {
      ...base,
      lane: "pr-deterministic" as const,
      evidenceClass: "runtime-observed" as const,
      certificationClass: "runtime-contract" as const,
    };
    expect(scenario(definition)).toBe(definition);
    expect(scenarioCertificationClass(definition)).toBe("runtime-contract");
  });

  it("rejects deterministic scenarios that claim external evidence", () => {
    for (const [evidenceClass, certificationClass] of [
      ["provider-observed", "provider"],
      ["native-device-observed", "native-device"],
      ["webhook-ingress-observed", "webhook-ingress"],
    ] as const) {
      expect(() =>
        scenario({
          ...base,
          lane: "pr-deterministic",
          evidenceClass,
          certificationClass,
        } as ScenarioDefinition),
      ).toThrow(/deterministic scenarios cannot claim/);
    }
  });

  it("rejects external certification labels on simulated or mismatched evidence", () => {
    expect(() =>
      scenario({
        ...base,
        evidenceClass: "provider-observed",
        certificationClass: "provider",
      }),
    ).toThrow(/evidenceClass "provider-observed" requires executionProfile/);
    expect(() =>
      scenario({
        ...base,
        evidenceClass: "runtime-observed",
        certificationClass: "webhook-ingress",
      } as ScenarioDefinition),
    ).toThrow(/requires evidenceClass "webhook-ingress-observed"/);
    expect(() =>
      scenario({
        ...base,
        evidenceClass: "native-device-observed",
        certificationClass: "native-device",
      }),
    ).toThrow(
      /evidenceClass "native-device-observed" requires executionProfile "provider-qualified"/,
    );
  });

  it("requires certification language to carry an explicit bounded class", () => {
    expect(() =>
      scenario({
        ...base,
        id: "fixture.certify-provider",
        title: "Certify provider delivery",
      }),
    ).toThrow(
      /uses certification language but does not declare certificationClass/,
    );
  });

  it("accepts an explicitly provider-qualified webhook contract", () => {
    const definition = {
      ...base,
      lane: "live-only" as const,
      executionProfile: "provider-qualified" as const,
      evidenceClass: "webhook-ingress-observed" as const,
      certificationClass: "webhook-ingress" as const,
    };
    expect(scenario(definition)).toBe(definition);
  });

  it("fails closed on unknown evidence and certification strings", () => {
    expect(() =>
      scenario({
        ...base,
        evidenceClass: "provider-ish",
      } as unknown as ScenarioDefinition),
    ).toThrow(/invalid evidenceClass/);
    expect(() =>
      scenario({
        ...base,
        certificationClass: "certified",
      } as unknown as ScenarioDefinition),
    ).toThrow(/invalid certificationClass/);
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
