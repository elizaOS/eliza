import type {
  CapturedAction,
  ScenarioCheckResult,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-schema";

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

function extractBrowserTask(action: CapturedAction): BrowserTaskShape | null {
  const data =
    action.result?.data && typeof action.result.data === "object"
      ? (action.result.data as Record<string, unknown>)
      : null;
  const browserTask =
    data?.browserTask && typeof data.browserTask === "object"
      ? (data.browserTask as Record<string, unknown>)
      : null;
  if (!browserTask) {
    return null;
  }
  return browserTask as BrowserTaskShape;
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
