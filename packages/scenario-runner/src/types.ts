/**
 * Internal types for the scenario runner. Scenario definitions themselves are
 * imported from `@elizaos/scenario-schema`; this file only models the runner's
 * execution & report state.
 */

import type {
  CapturedAction,
  CapturedApprovalRequest,
  CapturedArtifact,
  CapturedConnectorDispatch,
  CapturedMemoryWrite,
  CapturedStateTransition,
  ScenarioContext,
  ScenarioDefinition,
  ScenarioFinalCheck,
  ScenarioTurn,
  ScenarioTurnExecution,
} from "@elizaos/scenario-schema";

export type FinalCheckStatus =
  | "passed"
  | "failed"
  | "skipped-dependency-missing";

export interface FinalCheckReport {
  label: string;
  type: string;
  status: FinalCheckStatus;
  detail: string;
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
}

export interface AggregateReport {
  runId: string;
  startedAtIso: string;
  completedAtIso: string;
  providerName: string | null;
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

export type { ScenarioDefinition, ScenarioFinalCheck, ScenarioTurn };
