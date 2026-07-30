/**
 * Real-PGlite proof for four native parent-suite evaluators.
 *
 * Every terminal state follows a registered production Action.handler call
 * and is then read back from production graph, SQL, or calculation state.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../../plugins/plugin-personal-assistant/test/helpers/runtime.js";
import { type BenchmarkSession, createSession } from "../server-utils.js";
import {
  G15_NOTICE_KEY,
  G15_SCENARIO_ID,
  G30_CHILD_ENTITY_ID,
  G30_HOUSEHOLD_ID,
  G30_SCENARIO_ID,
  G30_THRESHOLD_RECORD_ID,
  G34_SCENARIO_ID,
  G38_ASSIGNMENT_RECORD_ID,
  G38_SCENARIO_ID,
  TRUSTED_PARENT_CONTRACT_STATE_SCHEMA,
} from "../trusted-parent-contract-evidence.js";
import {
  executeTrustedRuntimeAction,
  parseTrustedRuntimeActionRequest,
  TRUSTED_RUNTIME_ACTION_SCHEMA,
} from "../trusted-runtime-action-handler.js";

const IDEMPOTENCY_PREFIX =
  "lifeops-parent-native-0123456789abcdef0123456789abcdef";

function request(input: {
  scenarioId: string;
  runId: string;
  actionName: string;
  parameters: Record<string, unknown>;
  risk: "read" | "proposal";
  ordinal: number;
}) {
  return parseTrustedRuntimeActionRequest({
    schema: TRUSTED_RUNTIME_ACTION_SCHEMA,
    task_id: `${input.scenarioId}:${input.runId}`,
    action: {
      name: input.actionName,
      parameters: input.parameters,
    },
    idempotency_key: `${IDEMPOTENCY_PREFIX}-${input.ordinal}`,
    risk: input.risk,
    requested_at: new Date().toISOString(),
  });
}

function stateFrom(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("trusted runtime result is absent");
  }
  const data = (result as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("trusted runtime result data is absent");
  }
  const state = (data as Record<string, unknown>).trustedParentContractState;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("trusted parent-contract state is absent");
  }
  return state as Record<string, unknown>;
}

function known(annualUsd: number) {
  return {
    status: "known",
    annualUsd: { minUsd: annualUsd, maxUsd: annualUsd },
    source: {
      sourceId: `worksheet:${annualUsd}`,
      label: "Household worksheet",
      observedAt: "2026-07-26T12:00:00.000Z",
    },
  };
}

const NOT_APPLICABLE = {
  status: "not_applicable",
  reason: "This category does not apply to the option.",
};

function careOption(input: {
  optionId: string;
  grossUsd: number;
  careUsd: number;
}) {
  return {
    optionId: input.optionId,
    label: input.optionId,
    grossCashCompensation: known(input.grossUsd),
    variableCompensation: known(0),
    equityCompensation: NOT_APPLICABLE,
    taxesAndPayroll: known(Math.round(input.grossUsd * 0.22)),
    employeeBenefitsValue: known(5_000),
    employerRetirementValue: known(2_000),
    healthInsuranceCost: known(3_000),
    commuteCost: known(1_000),
    workExpense: known(500),
    householdSupportCost: known(0),
    otherHouseholdIncomeDelta: known(0),
    childcare: [
      {
        childEntityId: "Lee",
        label: "Lee",
        regularCareCost: known(input.careUsd),
        backupCareCost: known(1_500),
        uncoveredHoursPerMonth: {
          status: "known",
          range: { min: 0, max: 4 },
          source: {
            sourceId: `coverage:${input.optionId}`,
            label: "Coverage worksheet",
            observedAt: "2026-07-26T12:00:00.000Z",
          },
        },
      },
    ],
    scheduleReliability: {
      status: "known",
      range: { min: 0.8, max: 0.95 },
      source: {
        sourceId: `schedule:${input.optionId}`,
        label: "Schedule history",
        observedAt: "2026-07-26T12:00:00.000Z",
      },
    },
    reentryEffect: {
      status: "known",
      horizonYears: 5,
      futureHouseholdEarningsDeltaUsd: {
        minUsd: 5_000,
        maxUsd: 20_000,
      },
      source: {
        sourceId: `reentry:${input.optionId}`,
        label: "Career history",
        observedAt: "2026-07-26T12:00:00.000Z",
      },
      rationale: "Recent experience can affect later household earnings.",
    },
  };
}

describe("trusted parent contracts through registered production actions", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  const sessions = new Map<string, BenchmarkSession>();

  const resolveSession = (taskId: string): BenchmarkSession => {
    const existing = sessions.get(taskId);
    if (existing) return existing;
    const created = createSession(taskId, "lifeops_trusted_runtime");
    sessions.set(taskId, created);
    return created;
  };

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    for (const actionName of [
      "SCHOOL_SOURCES",
      "HOUSEHOLD_OPERATIONS",
      "OWNER_FINANCES",
    ]) {
      const action = runtime
        .getAllActions()
        .find((candidate) => candidate.name === actionName);
      expect(action, `${actionName} must be registered`).toBeDefined();
      expect(
        action?.parameters?.every((parameter) => parameter.schema),
        `${actionName} parameters must carry schemas`,
      ).toBe(true);
    }
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("G15 reconciles signed correction facts with both graph relations", async () => {
    const response = await executeTrustedRuntimeAction(
      {
        runtime,
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["SCHOOL_SOURCES"]),
        resolveSession,
      },
      request({
        scenarioId: G15_SCENARIO_ID,
        runId: "pglite-g15",
        actionName: "SCHOOL_SOURCES",
        parameters: {
          action: "reconcile_notice",
          noticeKey: G15_NOTICE_KEY,
        },
        risk: "proposal",
        ordinal: 1,
      }),
    );
    const state = stateFrom(response);

    expect(response.ok).toBe(true);
    expect(state).toMatchObject({
      schemaVersion: TRUSTED_PARENT_CONTRACT_STATE_SCHEMA,
      scenarioId: G15_SCENARIO_ID,
      canonical: {
        canonicalFactId: `school.notice:${G15_NOTICE_KEY}`,
        effectiveDate: "2026-05-21",
        authorityClass: "signed_school_correction",
      },
    });
    expect(
      (state.relationships as Array<Record<string, unknown>>).map(
        (relationship) => relationship.kind,
      ),
    ).toEqual(expect.arrayContaining(["contradicts", "supersedes"]));
    expect(state.sourceFacts).toHaveLength(2);
    expect(state.sourceArtifacts).toHaveLength(2);
  });

  it("G30 requires the registered size update before no-purchase evaluation", async () => {
    const task = {
      scenarioId: G30_SCENARIO_ID,
      runId: "pglite-g30",
      actionName: "HOUSEHOLD_OPERATIONS",
    };
    const update = await executeTrustedRuntimeAction(
      {
        runtime,
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["HOUSEHOLD_OPERATIONS"]),
        resolveSession,
      },
      request({
        ...task,
        parameters: {
          action: "record_observation",
          input: {
            householdId: G30_HOUSEHOLD_ID,
            subjectKey: `child-item:${G30_CHILD_ENTITY_ID}:raincoat`,
            subjectEntityIds: [G30_CHILD_ENTITY_ID],
            observationKind: "child_item_size",
            value: {
              kind: "child_item_size",
              childEntityId: G30_CHILD_ENTITY_ID,
              itemCategory: "raincoat",
              sizeLabel: "8",
              fitState: "fits",
              measurement: null,
            },
            provenance: {
              kind: "authenticated_user",
              sourceId: "lee-raincoat-fit",
              sourceRevision: 2,
              observedAt: new Date().toISOString(),
              evidenceRef: "owner-confirmation:lee-raincoat-size-8",
              authority: "user_confirmed",
              confidence: 1,
            },
            visibility: {
              kind: "child_scoped",
              childEntityId: G30_CHILD_ENTITY_ID,
            },
            supersedesObservationId: null,
            correctsObservationId: null,
          },
        },
        risk: "proposal",
        ordinal: 1,
      }),
    );
    const updateResult = update.result as Record<string, unknown>;
    const updateData = updateResult.data as Record<string, unknown>;
    const updateReceipts = updateResult.effectReceipts as Array<
      Record<string, unknown>
    >;
    expect(update.ok).toBe(true);
    expect(updateData.trustedParentContractState).toBeUndefined();
    expect(updateReceipts).toHaveLength(1);
    expect(updateReceipts[0]).toMatchObject({
      trustedRuntimeInvocation: {
        idempotencyKey: `${IDEMPOTENCY_PREFIX}-1`,
      },
    });

    const evaluation = await executeTrustedRuntimeAction(
      {
        runtime,
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["HOUSEHOLD_OPERATIONS"]),
        resolveSession,
      },
      request({
        ...task,
        parameters: {
          action: "evaluate_item_replacement",
          recordId: G30_THRESHOLD_RECORD_ID,
        },
        risk: "read",
        ordinal: 2,
      }),
    );
    const state = stateFrom(evaluation);
    const current = state.currentObservation as Record<string, unknown>;

    expect(evaluation.ok).toBe(true);
    expect((current.value as Record<string, unknown>).sizeLabel).toBe("8");
    expect(state).toMatchObject({
      schemaVersion: TRUSTED_PARENT_CONTRACT_STATE_SCHEMA,
      scenarioId: G30_SCENARIO_ID,
      subjectEntityId: G30_CHILD_ENTITY_ID,
      appendOnly: true,
      commerceAudit: {
        cartCount: 0,
        orderCount: 0,
        paymentArtifactCount: 0,
      },
    });
    expect(state.sizeHistory).toHaveLength(2);
    expect(state.actionHistory).toHaveLength(2);
  });

  it("G34 returns exact input revisions under one comparable formula set", async () => {
    const scenario = {
      schemaVersion: "childcare-work-scenario.v1",
      scenarioId: "trusted-g34-care-model",
      householdId: "trusted-g34-household",
      asOf: "2026-07-26T12:00:00.000Z",
      currency: "USD",
      options: [
        careOption({
          optionId: "executive-income",
          grossUsd: 240_000,
          careUsd: 42_000,
        }),
        careOption({
          optionId: "hourly-variable-shifts",
          grossUsd: 48_000,
          careUsd: 24_000,
        }),
      ],
    };
    const response = await executeTrustedRuntimeAction(
      {
        runtime,
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["OWNER_FINANCES"]),
        resolveSession,
      },
      request({
        scenarioId: G34_SCENARIO_ID,
        runId: "pglite-g34",
        actionName: "OWNER_FINANCES",
        parameters: {
          action: "childcare_work_scenario",
          scenarioJson: JSON.stringify(scenario),
        },
        risk: "read",
        ordinal: 1,
      }),
    );
    const state = stateFrom(response);
    const calculation = state.calculation as Record<string, unknown>;

    expect(response.ok).toBe(true);
    expect(calculation).toMatchObject({
      status: "complete",
      comparableFormulaSetId: "childcare-work-scenario.formula-set.v1",
    });
    expect(calculation.inputRevisionIds).toHaveLength(2);
    expect(
      (calculation.inputRevisionIds as string[]).every((revision) =>
        /^sha256:[0-9a-f]{64}$/u.test(revision),
      ),
    ).toBe(true);
  });

  it("G38 creates a review while preserving both assignment revisions", async () => {
    const response = await executeTrustedRuntimeAction(
      {
        runtime,
        bearerToken: "x".repeat(32),
        allowedActions: new Set(["HOUSEHOLD_OPERATIONS"]),
        resolveSession,
      },
      request({
        scenarioId: G38_SCENARIO_ID,
        runId: "pglite-g38",
        actionName: "HOUSEHOLD_OPERATIONS",
        parameters: {
          action: "assess_responsibility",
          recordId: G38_ASSIGNMENT_RECORD_ID,
        },
        risk: "proposal",
        ordinal: 1,
      }),
    );
    const state = stateFrom(response);

    expect(response.ok).toBe(true);
    expect(state).toMatchObject({
      schemaVersion: TRUSTED_PARENT_CONTRACT_STATE_SCHEMA,
      scenarioId: G38_SCENARIO_ID,
      assignmentRecordId: G38_ASSIGNMENT_RECORD_ID,
      historyImmutable: true,
      acceptedSuccessorAgreementCount: 0,
      unapprovedOwnerChangeCount: 0,
    });
    expect(state.revisions).toHaveLength(2);
    expect(state.priorAssignmentRevisionIds).toHaveLength(1);
    expect(state.proposalIds).toHaveLength(1);
    expect(state.signals).toHaveLength(2);
  });
});
