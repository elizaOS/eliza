/**
 * Internal types for the scenario runner. Scenario definitions themselves are
 * imported from `@elizaos/scenario-runner/schema`; this file only models the runner's
 * execution & report state.
 */

import type { VoiceAudioArtifact } from "@elizaos/plugin-local-inference/voice-workbench";
import type {
  ApprovalRequestState,
  CapturedAction,
  CapturedApprovalRequest,
  CapturedArtifact,
  CapturedConnectorDispatch,
  CapturedMemoryWrite,
  CapturedStateTransition,
  ScenarioContext,
  ScenarioExecutionProfile,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import type { LedgerEntry } from "@elizaos/synthetic-world";
import type { BackgroundRuntimeResetReceipt } from "./background-runtime.ts";

/** A tuple used where empty evidence would make a qualification claim unsound. */
export type NonEmptyEvidenceList<T> = readonly [T, ...T[]];

/**
 * Trusted observation boundaries. Deliberately absent: action results, model
 * prose, inferred dispatches, and test fixtures. Those may explain a run but
 * cannot establish provider qualification.
 */
export type ScenarioEvidenceObserverKind =
  | "provider-api"
  | "provider-webhook"
  | "durable-database"
  | "scheduler-runner";

/** Identity and deployment provenance for the adapter that read external state. */
export interface ScenarioEvidenceObserverProvenance {
  observerId: string;
  kind: ScenarioEvidenceObserverKind;
  implementation: string;
  version: string;
  environment: string;
  configurationSha256: string;
}

/** Content hash and recorder provenance for an immutable trajectory artifact. */
export interface ScenarioEvidenceTrajectoryHash {
  trajectoryId: string;
  relativePath: string;
  sha256: string;
  recorder: {
    implementation: string;
    version: string;
    environment: string;
  };
}

/** Links one external observation to the exact trajectory stage that caused it. */
export interface ScenarioEvidenceTrajectoryReference {
  trajectoryId: string;
  stageId: string;
  sha256: string;
}

/**
 * Origin record read by an observer. Raw account and provider record IDs are
 * represented only by hashes so evidence remains correlatable without leaking
 * credentials or user identifiers.
 */
export interface ScenarioEvidenceSourceProvenance {
  kind: ScenarioEvidenceObserverKind;
  system: string;
  environment: string;
  recordIdSha256: string;
  accountRefSha256?: string;
}

export type ScenarioEvidenceObservationBase<
  Kind extends string,
  SourceKind extends ScenarioEvidenceObserverKind,
> = {
  observationId: string;
  kind: Kind;
  observedAtIso: string;
  observerId: string;
  source: ScenarioEvidenceSourceProvenance & { kind: SourceKind };
  payloadSha256: string;
  trajectoryRefs: NonEmptyEvidenceList<ScenarioEvidenceTrajectoryReference>;
};

/** A durable approval-queue row observed from the backing database. */
export type DurableApprovalObservation = ScenarioEvidenceObservationBase<
  "durable-approval",
  "durable-database"
> & {
  approvalIdSha256: string;
  actionName: string;
  state: ApprovalRequestState;
  requestPayloadSha256: string;
  decisionPayloadSha256?: string;
};

/** A persisted draft observed independently of an action's return payload. */
export type DurableDraftObservation = ScenarioEvidenceObservationBase<
  "durable-draft",
  "durable-database"
> & {
  draftIdSha256: string;
  channel: string;
  state: "draft" | "queued" | "approved" | "discarded";
  recipientSetSha256: string;
  contentSha256: string;
};

/** A provider-side mutation receipt and optional provider readback. */
export type ProviderEffectObservation = ScenarioEvidenceObservationBase<
  "provider-effect",
  "provider-api" | "provider-webhook"
> & {
  provider: string;
  operation: string;
  accountRefSha256: string;
  requestSha256: string;
  responseSha256: string;
  providerReceiptIdSha256: string;
  readbackSha256?: string;
};

/**
 * Provider-side proof that a scoped external state did not change during a
 * bounded observation interval. Equal snapshot hashes are enforced by the
 * reporter's runtime validator.
 */
export type ProviderNoEffectObservation = ScenarioEvidenceObservationBase<
  "provider-no-effect",
  "provider-api"
> & {
  provider: string;
  accountRefSha256: string;
  effectKinds: NonEmptyEvidenceList<string>;
  scopeSha256: string;
  beforeSnapshotSha256: string;
  afterSnapshotSha256: string;
  observationStartedAtIso: string;
  observationEndedAtIso: string;
};

/** Durable scheduled-task persistence or execution observed at its owner boundary. */
export type ScheduledTaskObservation = ScenarioEvidenceObservationBase<
  "scheduled-task",
  "durable-database" | "scheduler-runner"
> & {
  taskIdSha256: string;
  scheduleSha256: string;
  state:
    | "persisted"
    | "claimed"
    | "executing"
    | "completed"
    | "failed"
    | "canceled";
  scheduledForIso: string;
  executionIdSha256?: string;
  resultSha256?: string;
  providerReceiptIdSha256?: string;
};

export type ScenarioEvidenceObservation =
  | DurableApprovalObservation
  | DurableDraftObservation
  | ProviderEffectObservation
  | ProviderNoEffectObservation
  | ScheduledTaskObservation;

export type ScenarioEvidenceObservationKind =
  ScenarioEvidenceObservation["kind"];

export type ScenarioEvidenceQualification =
  | {
      status: "ineligible";
      publishable: false;
      reasons: NonEmptyEvidenceList<string>;
    }
  | {
      status: "unqualified";
      publishable: false;
      reasons: NonEmptyEvidenceList<string>;
    }
  | {
      status: "qualified";
      publishable: true;
      reasons: readonly [];
    };

/**
 * Simulated evidence can retain trajectory hashes for diagnostics but cannot
 * carry trusted external observations or become publishable.
 */
export type SimulatedScenarioEvidenceReport = {
  schemaVersion: 1;
  executionProfile: "simulated";
  qualification: Extract<
    ScenarioEvidenceQualification,
    { status: "ineligible" }
  >;
  trajectoryHashes?: readonly ScenarioEvidenceTrajectoryHash[];
  observerProvenance?: never;
  observations?: never;
};

export type ProviderQualifiedScenarioEvidenceReport =
  | {
      schemaVersion: 1;
      executionProfile: "provider-qualified";
      qualification: Extract<
        ScenarioEvidenceQualification,
        { status: "unqualified" }
      >;
      observerProvenance: readonly ScenarioEvidenceObserverProvenance[];
      trajectoryHashes: readonly ScenarioEvidenceTrajectoryHash[];
      observations: readonly ScenarioEvidenceObservation[];
    }
  | {
      schemaVersion: 1;
      executionProfile: "provider-qualified";
      qualification: Extract<
        ScenarioEvidenceQualification,
        { status: "qualified" }
      >;
      observerProvenance: NonEmptyEvidenceList<ScenarioEvidenceObserverProvenance>;
      trajectoryHashes: NonEmptyEvidenceList<ScenarioEvidenceTrajectoryHash>;
      observations: NonEmptyEvidenceList<ScenarioEvidenceObservation>;
    };

/**
 * Provider qualification is represented by this closed discriminated union.
 * A report cannot model simulated evidence as publishable, and a qualified
 * provider report cannot be empty.
 */
export type ScenarioEvidenceReport =
  | SimulatedScenarioEvidenceReport
  | ProviderQualifiedScenarioEvidenceReport;

/**
 * `skipped` means the check's runtime dependency was missing (e.g. no
 * approval-queue service registered). A skipped check FAILS the scenario in
 * the `pr-deterministic` lane — that lane must never silently lose coverage —
 * and is loudly counted in reports for live lanes.
 */
export type FinalCheckStatus = "passed" | "failed" | "skipped";

export interface FinalCheckReport {
  label: string;
  type: string;
  status: FinalCheckStatus;
  detail: string;
  /**
   * Numeric LLM-judge score in [0, 1] when this check ran a judge
   * (`judgeRubric`). Absent for non-judged checks and when the judge itself
   * errored. Serialized so downstream training/quality tooling can
   * reward-weight trajectories instead of re-parsing the detail string
   * (#8795).
   */
  score?: number;
}

export interface TurnReport {
  name: string;
  kind: string;
  text?: string;
  responseText: string;
  statusCode?: number;
  responseBody?: unknown;
  actionsCalled: CapturedAction[];
  durationMs: number;
  failedAssertions: string[];
  /**
   * Numeric `responseJudge` score in [0, 1] when this turn ran an LLM judge.
   * Recorded for passing turns too — before this field the score only
   * appeared inside a failure detail string (#8795).
   */
  judgeScore?: number;
  /** `.wav` artifacts a `voice` turn wrote when run under `--run-dir`. */
  audioArtifacts?: VoiceAudioArtifact[];
}

export interface ScenarioReport {
  id: string;
  title: string;
  domain: string;
  tags: readonly string[];
  /** Optional persona-scenario complexity tier (`T1`..`T4`) from the scenario definition. */
  tier?: string;
  status: "passed" | "failed" | "skipped";
  skipReason?: string;
  durationMs: number;
  turns: TurnReport[];
  finalChecks: FinalCheckReport[];
  actionsCalled: CapturedAction[];
  failedAssertions: Array<{ label: string; detail: string }>;
  providerName: string | null;
  /**
   * Execution trust boundary used for this scenario. Optional only while
   * legacy producers migrate; aggregation reports missing values as unreported
   * rather than relabeling them simulated.
   */
  executionProfile?: ScenarioExecutionProfile;
  /** Deterministic worker evidence captured before shared-runtime reset. */
  background?: {
    state: string;
    now: string;
    workers: readonly string[];
    pending: readonly {
      id: string;
      name: string;
      dueAt: string | null;
      due: boolean;
      paused: boolean;
    }[];
    pendingTimers: number;
    errors: readonly { scope: string; code: string; message: string }[];
    ledger: readonly LedgerEntry[];
    resetReceipt?: BackgroundRuntimeResetReceipt;
  };
  /**
   * Trusted, hashed evidence captured outside the action-result/model-prose
   * path. The reporter validates profile agreement, provenance references, and
   * qualification invariants before serializing an aggregate.
   */
  evidence?: ScenarioEvidenceReport;
  error?: string;
  /**
   * Minimum judge score in [0, 1] across every judged turn and `judgeRubric`
   * final check in the scenario — the binding quality constraint. Absent when
   * no judge ran. Carried into `--export-native` rows as
   * `metadata.judge_score` for reward-weighted training (#8795).
   */
  judgeScore?: number;
  /**
   * True when the LLM-judge scores above were produced by the model under
   * test itself (no independent Cerebras judge configured and no
   * deterministic judge fixtures active) — the run self-graded (#9310).
   * `SCENARIO_JUDGE_REQUIRE_INDEPENDENT=1` turns this into a failure.
   */
  judgeSelfGraded?: boolean;
}

export interface AggregateReport {
  runId: string;
  startedAtIso: string;
  completedAtIso: string;
  providerName: string | null;
  /**
   * Profile shared by every explicitly-profiled scenario, `mixed` when they
   * differ, or `null` when no producer reported one. Null is deliberately not
   * coerced to the schema's legacy simulated default.
   */
  executionProfile: ScenarioExecutionProfile | "mixed" | null;
  artifactPaths?: {
    runDir?: string;
    matrixJson?: string;
    viewerIndex?: string;
    viewerData?: string;
    nativeJsonl?: string;
    nativeManifest?: string;
  };
  scenarios: ScenarioReport[];
  evidenceSummary: {
    reportedScenarioCount: number;
    unreportedScenarioCount: number;
    qualificationCounts: {
      qualified: number;
      unqualified: number;
      ineligible: number;
    };
    publishableScenarioCount: number;
    observationCounts: Record<ScenarioEvidenceObservationKind, number>;
  };
  totals: {
    passed: number;
    failed: number;
    skipped: number;
    /**
     * Real summed LLM spend across the run's recorded trajectories
     * (`metrics.totalCostUsd` per trajectory). `0` only when no trajectories
     * were recorded (no `--run-dir`), never fabricated on a costed run.
     */
    costUsd: number;
    /**
     * finalChecks across all scenarios that reported status `skipped`
     * (dependency missing). Non-zero means real coverage was lost — surfaced
     * loudly in the stdout summary for live lanes; the pr-deterministic lane
     * turns these into scenario failures instead.
     */
    finalChecksSkipped: number;
  };
  // Present for benchmark compatibility.
  totalCount: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  totalCostUsd: number;
}

export interface RunnerContext extends ScenarioContext {
  actionsCalled: CapturedAction[];
  turns: ScenarioTurnExecution[];
  approvalRequests: CapturedApprovalRequest[];
  connectorDispatches: CapturedConnectorDispatch[];
  memoryWrites: CapturedMemoryWrite[];
  stateTransitions: CapturedStateTransition[];
  artifacts: CapturedArtifact[];
}
