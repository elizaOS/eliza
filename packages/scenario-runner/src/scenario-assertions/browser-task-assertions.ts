/** Provides browser-task outcome assertions for executable scenarios. */
import type {
  CapturedAction,
  ScenarioCheckResult,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";

type BrowserTaskExpectation = {
  description: string;
  actionName?: string | string[];
  completed?: boolean;
  needsHuman?: boolean;
  approvalRequired?: boolean;
  approvalSatisfied?: boolean;
  minArtifacts?: number;
  minUploadedAssets?: number;
  minInterventions?: number;
  minProvenance?: number;
  blockedReasonIncludes?: string;
};

type BrowserTaskShape = {
  completed?: boolean;
  needsHuman?: boolean;
  approvalRequired?: boolean;
  approvalSatisfied?: boolean;
  artifactCount?: number;
  uploadedAssetCount?: number;
  interventionCount?: number;
  provenanceCount?: number;
  blockedReason?: string | null;
};

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOptionalBoolean(
  value: Record<string, unknown>,
  key: keyof Pick<
    BrowserTaskShape,
    "completed" | "needsHuman" | "approvalRequired" | "approvalSatisfied"
  >,
): boolean {
  return value[key] === undefined || typeof value[key] === "boolean";
}

function hasOptionalCount(
  value: Record<string, unknown>,
  key: keyof Pick<
    BrowserTaskShape,
    | "artifactCount"
    | "uploadedAssetCount"
    | "interventionCount"
    | "provenanceCount"
  >,
): boolean {
  const count = value[key];
  return (
    count === undefined ||
    (typeof count === "number" && Number.isInteger(count) && count >= 0)
  );
}

function isBrowserTaskShape(
  value: Record<string, unknown>,
): value is BrowserTaskShape {
  return (
    hasOptionalBoolean(value, "completed") &&
    hasOptionalBoolean(value, "needsHuman") &&
    hasOptionalBoolean(value, "approvalRequired") &&
    hasOptionalBoolean(value, "approvalSatisfied") &&
    hasOptionalCount(value, "artifactCount") &&
    hasOptionalCount(value, "uploadedAssetCount") &&
    hasOptionalCount(value, "interventionCount") &&
    hasOptionalCount(value, "provenanceCount") &&
    (value.blockedReason === undefined ||
      value.blockedReason === null ||
      typeof value.blockedReason === "string")
  );
}

function extractBrowserTask(action: CapturedAction): BrowserTaskShape | null {
  const data = action.result?.data;
  if (!isRecord(data) || !isRecord(data.browserTask)) {
    return null;
  }
  return isBrowserTaskShape(data.browserTask) ? data.browserTask : null;
}

function matchesActionFilter(actionName: string, filters: string[]): boolean {
  return filters.length === 0 || filters.includes(actionName);
}

function validateExpectation(
  actions: CapturedAction[],
  expectation: BrowserTaskExpectation,
): ScenarioCheckResult {
  const actionFilters = toArray(expectation.actionName);
  const tasks = actions
    .filter((action) => matchesActionFilter(action.actionName, actionFilters))
    .map((action) => ({
      actionName: action.actionName,
      browserTask: extractBrowserTask(action),
    }))
    .filter(
      (
        candidate,
      ): candidate is { actionName: string; browserTask: BrowserTaskShape } =>
        candidate.browserTask !== null,
    );

  if (tasks.length === 0) {
    return `Expected ${expectation.description}: no browserTask payload found on actions [${actionFilters.join(", ") || "*"}].`;
  }

  const matched = tasks.filter(({ browserTask }) => {
    if (
      expectation.completed !== undefined &&
      browserTask.completed !== expectation.completed
    ) {
      return false;
    }
    if (
      expectation.needsHuman !== undefined &&
      browserTask.needsHuman !== expectation.needsHuman
    ) {
      return false;
    }
    if (
      expectation.approvalRequired !== undefined &&
      browserTask.approvalRequired !== expectation.approvalRequired
    ) {
      return false;
    }
    if (
      expectation.approvalSatisfied !== undefined &&
      browserTask.approvalSatisfied !== expectation.approvalSatisfied
    ) {
      return false;
    }
    if (
      expectation.minArtifacts !== undefined &&
      (browserTask.artifactCount ?? 0) < expectation.minArtifacts
    ) {
      return false;
    }
    if (
      expectation.minUploadedAssets !== undefined &&
      (browserTask.uploadedAssetCount ?? 0) < expectation.minUploadedAssets
    ) {
      return false;
    }
    if (
      expectation.minInterventions !== undefined &&
      (browserTask.interventionCount ?? 0) < expectation.minInterventions
    ) {
      return false;
    }
    if (
      expectation.minProvenance !== undefined &&
      (browserTask.provenanceCount ?? 0) < expectation.minProvenance
    ) {
      return false;
    }
    if (
      expectation.blockedReasonIncludes &&
      !String(browserTask.blockedReason ?? "")
        .toLowerCase()
        .includes(expectation.blockedReasonIncludes.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  if (matched.length === 0) {
    return `Expected ${expectation.description}: saw browserTask payloads ${JSON.stringify(tasks.map((task) => task.browserTask))}`;
  }

  return undefined;
}

export function expectScenarioBrowserTask(expectation: BrowserTaskExpectation) {
  return (ctx: ScenarioContext): ScenarioCheckResult =>
    validateExpectation(ctx.actionsCalled, expectation);
}

export function expectTurnBrowserTask(expectation: BrowserTaskExpectation) {
  return (turn: ScenarioTurnExecution): ScenarioCheckResult =>
    validateExpectation(turn.actionsCalled, expectation);
}
