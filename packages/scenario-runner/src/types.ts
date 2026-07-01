/**
 * Internal types for the scenario runner. Scenario definitions themselves are
 * imported from `@elizaos/scenario-runner/schema`; this file only models the runner's
 * execution & report state.
 */

import type { VoiceAudioArtifact } from "@elizaos/plugin-local-inference/voice-workbench";
import type {
  CapturedAction,
  CapturedApprovalRequest,
  CapturedArtifact,
  CapturedConnectorDispatch,
  CapturedMemoryWrite,
  CapturedStateTransition,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";

export type FinalCheckStatus =
  | "passed"
  | "failed"
  | "skipped-dependency-missing";

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
  status: "passed" | "failed" | "skipped";
  skipReason?: string;
  durationMs: number;
  turns: TurnReport[];
  finalChecks: FinalCheckReport[];
  actionsCalled: CapturedAction[];
  failedAssertions: Array<{ label: string; detail: string }>;
  providerName: string | null;
  error?: string;
  /**
   * Minimum judge score in [0, 1] across every judged turn and `judgeRubric`
   * final check in the scenario — the binding quality constraint. Absent when
   * no judge ran. Carried into `--export-native` rows as
   * `metadata.judge_score` for reward-weighted training (#8795).
   */
  judgeScore?: number;
}

export interface AggregateReport {
  runId: string;
  startedAtIso: string;
  completedAtIso: string;
  providerName: string | null;
  artifactPaths?: {
    runDir?: string;
    matrixJson?: string;
    viewerIndex?: string;
    viewerData?: string;
    nativeJsonl?: string;
    nativeManifest?: string;
  };
  scenarios: ScenarioReport[];
  totals: {
    passed: number;
    failed: number;
    skipped: number;
    flakyPassed: number;
    costUsd: number;
  };
  // Present for benchmark compatibility.
  totalCount: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  flakyPassedCount: number;
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
