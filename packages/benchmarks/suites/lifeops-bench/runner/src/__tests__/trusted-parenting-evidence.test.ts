/**
 * Real-PGlite checks for trusted parenting fixture preparation, registered
 * action execution, and post-action repository read-back. A deterministic
 * model response drives the production classifier in this test only; these
 * artifacts are not live-provider or release evidence.
 */

import { type AgentRuntime, ModelType } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../../plugins/plugin-personal-assistant/test/helpers/runtime.js";
import { createSession } from "../server-utils.js";
import {
  G35_PARENTING_SCENARIO_ID,
  G35_PARENTING_SUBJECT_ID,
  G36_PARENTING_COPARENT_ID,
  G36_PARENTING_SCENARIO_ID,
  G36_PARENTING_SUBJECT_ID,
  TRUSTED_PARENTING_STATE_SCHEMA,
} from "../trusted-parenting-evidence.js";
import {
  executeTrustedRuntimeAction,
  parseTrustedRuntimeActionRequest,
  TRUSTED_RUNTIME_ACTION_SCHEMA,
} from "../trusted-runtime-action-handler.js";

const IDEMPOTENCY_KEY =
  "lifeops-parenting-0123456789abcdef0123456789abcdef0123456789abcdef";

function request(
  scenarioId: string,
  parameters: Record<string, unknown>,
  suffix = "native-runtime-test",
): ReturnType<typeof parseTrustedRuntimeActionRequest> {
  return parseTrustedRuntimeActionRequest({
    schema: TRUSTED_RUNTIME_ACTION_SCHEMA,
    task_id: `${scenarioId}:${suffix}`,
    action: {
      name: "PARENTING_GUIDANCE",
      parameters,
    },
    idempotency_key: IDEMPOTENCY_KEY,
    risk: "read",
    requested_at: new Date().toISOString(),
  });
}

function resultData(response: Record<string, unknown>): {
  guidance: Record<string, unknown>;
  trustedFinalState: Record<string, unknown>;
} {
  const result = response.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("trusted result missing");
  }
  const data = (result as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("trusted result data missing");
  }
  const guidance = (data as Record<string, unknown>).guidance;
  const trustedFinalState = (data as Record<string, unknown>).trustedFinalState;
  if (
    !guidance ||
    typeof guidance !== "object" ||
    Array.isArray(guidance) ||
    !trustedFinalState ||
    typeof trustedFinalState !== "object" ||
    Array.isArray(trustedFinalState)
  ) {
    throw new Error("trusted parenting artifacts missing");
  }
  return {
    guidance: guidance as Record<string, unknown>,
    trustedFinalState: trustedFinalState as Record<string, unknown>,
  };
}

describe("trusted parenting production action and repository state", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    const malformedParameter = runtime.actions
      .flatMap((action) =>
        (action.parameters ?? []).map((parameter) => ({
          action: action.name,
          parameter,
        })),
      )
      .find(({ parameter }) => !parameter.schema);
    if (malformedParameter) {
      throw new Error(
        `registered action parameter lacks a schema: ${malformedParameter.action}.${malformedParameter.parameter.name}`,
      );
    }
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async (_runtime, params) => {
        const prompt = String(params.prompt ?? "");
        const sensitive = prompt.includes("this message mentions self-harm");
        return JSON.stringify({
          immediateDanger: "absent",
          selfHarm: sensitive ? "present" : "absent",
          harmToOthers: "absent",
          suspectedAbuseOrNeglect: sensitive ? "present" : "absent",
          medicationOrDiagnosis: sensitive ? "present" : "absent",
          severeOrPersistentSymptoms: "absent",
          legalOrCustodyInterpretation: "absent",
        });
      },
      "trusted-parenting-test-model",
      1_000,
    );
  }, 120_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("runs G35 through the registered action with cited school-age output", async () => {
    const response = await executeTrustedRuntimeAction(
      {
        runtime,
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["PARENTING_GUIDANCE"]),
        resolveSession: (taskId) =>
          createSession(taskId, "lifeops_trusted_runtime"),
      },
      request(G35_PARENTING_SCENARIO_ID, {
        subjectEntityId: G35_PARENTING_SUBJECT_ID,
        topic: "boundary_setting",
        requestedFramework: "good_inside",
      }),
    );
    const { guidance, trustedFinalState } = resultData(response);
    const decision = guidance.decision as Record<string, unknown>;

    expect(response.ok).toBe(true);
    expect(guidance).toMatchObject({
      subjectEntityId: G35_PARENTING_SUBJECT_ID,
      ageBand: "school_age",
      topic: "boundary_setting",
      requestedFramework: "good_inside",
      safetyClassificationStatus: "classified",
      externalEffectsPerformed: false,
    });
    expect(decision.status).toBe("educational_options");
    expect(decision.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceTier: "named_framework_primary",
        }),
      ]),
    );
    expect(trustedFinalState).toMatchObject({
      schemaVersion: TRUSTED_PARENTING_STATE_SCHEMA,
      scenarioId: G35_PARENTING_SCENARIO_ID,
      owner: {
        entityId: "self",
        preferredName: "Maya Reed",
        role: "owner",
        effectiveScopes: [
          "household.visibility",
          "calendar.freebusy",
          "calendar.details",
          "calendar.mutate",
        ],
      },
      subject: {
        entityId: G35_PARENTING_SUBJECT_ID,
        role: "child",
        ageYears: { value: 8, confidence: 1 },
        ageBand: { value: "school_age", confidence: 1 },
        recordScope: { value: "household_shared", confidence: 1 },
        currentLocation: {
          value: {
            subjectEntityId: G35_PARENTING_SUBJECT_ID,
            jurisdiction: "US",
            verifiedByEntityId: "self",
          },
        },
      },
      coParent: null,
      ownerTravel: null,
    });
    expect(trustedFinalState.householdRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: "self",
          role: "owner",
        }),
        expect.objectContaining({
          entityId: G35_PARENTING_SUBJECT_ID,
          role: "child",
          subjectEntityIds: [G35_PARENTING_SUBJECT_ID],
        }),
      ]),
    );
  });

  it("runs G36 as a multi-risk stop using the teen's co-parent-bound California state", async () => {
    const response = await executeTrustedRuntimeAction(
      {
        runtime,
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["PARENTING_GUIDANCE"]),
        resolveSession: (taskId) =>
          createSession(taskId, "lifeops_trusted_runtime"),
      },
      request(G36_PARENTING_SCENARIO_ID, {
        subjectEntityId: G36_PARENTING_SUBJECT_ID,
        topic: "communication",
        requestedFramework: "good_inside",
      }),
    );
    const { guidance, trustedFinalState } = resultData(response);
    const decision = guidance.decision as Record<string, unknown>;
    const handoff = decision.handoff as Record<string, unknown>;

    expect(response.ok).toBe(true);
    expect(guidance).toMatchObject({
      subjectEntityId: G36_PARENTING_SUBJECT_ID,
      ageBand: "teen",
      safetyClassificationStatus: "classified",
      externalEffectsPerformed: false,
    });
    expect(decision).toMatchObject({
      status: "urgent_safety_handoff",
      mayProvideEducationalOptions: false,
      mayDisclosePrivateContext: false,
      sources: [],
      options: [],
    });
    expect(handoff.kinds).toEqual(
      expect.arrayContaining([
        "emergency_services",
        "crisis_support",
        "child_safeguarding",
        "licensed_mental_health_professional",
        "pediatrician_or_prescriber",
      ]),
    );
    expect(trustedFinalState).toMatchObject({
      schemaVersion: TRUSTED_PARENTING_STATE_SCHEMA,
      scenarioId: G36_PARENTING_SCENARIO_ID,
      owner: {
        entityId: "self",
        preferredName: "Maya Reed",
        role: "owner",
        effectiveScopes: [
          "household.visibility",
          "calendar.freebusy",
          "calendar.details",
          "calendar.mutate",
        ],
      },
      subject: {
        entityId: G36_PARENTING_SUBJECT_ID,
        ageYears: { value: 15, confidence: 1 },
        ageBand: { value: "teen", confidence: 1 },
        recordScope: { value: "teen_private", confidence: 1 },
        currentAdministrativeArea: { value: "CA", confidence: 1 },
        currentLocation: {
          value: {
            subjectEntityId: G36_PARENTING_SUBJECT_ID,
            jurisdiction: "US",
            verifiedByEntityId: G36_PARENTING_COPARENT_ID,
          },
        },
      },
      coParent: { entityId: G36_PARENTING_COPARENT_ID },
      ownerTravel: {
        value: { destinationTimezone: "Europe/London" },
      },
    });
    expect(trustedFinalState.householdRoles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: G36_PARENTING_SUBJECT_ID,
          role: "child",
          subjectEntityIds: [G36_PARENTING_SUBJECT_ID],
        }),
        expect.objectContaining({
          entityId: G36_PARENTING_COPARENT_ID,
          role: "co_parent",
          subjectEntityIds: [G36_PARENTING_SUBJECT_ID],
        }),
      ]),
    );
    expect(
      (trustedFinalState.grants as Array<Record<string, unknown>>).some(
        (grant) =>
          grant.principalEntityId === G36_PARENTING_COPARENT_ID &&
          (grant.scopes as string[]).includes("household.visibility"),
      ),
    ).toBe(true);
  });

  it("re-seeds G35 without carrying the G36 co-parent or travel state", async () => {
    const response = await executeTrustedRuntimeAction(
      {
        runtime,
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["PARENTING_GUIDANCE"]),
        resolveSession: (taskId) =>
          createSession(taskId, "lifeops_trusted_runtime"),
      },
      request(
        G35_PARENTING_SCENARIO_ID,
        {
          subjectEntityId: G35_PARENTING_SUBJECT_ID,
          topic: "boundary_setting",
          requestedFramework: "good_inside",
        },
        "independence-test",
      ),
    );
    const { trustedFinalState } = resultData(response);

    expect(trustedFinalState).toMatchObject({
      scenarioId: G35_PARENTING_SCENARIO_ID,
      coParent: null,
      ownerTravel: null,
      grants: [],
    });
  });
});
