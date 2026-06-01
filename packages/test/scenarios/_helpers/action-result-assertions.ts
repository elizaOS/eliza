import type {
  CapturedAction,
  ScenarioCheckResult,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";

type Pattern = string | RegExp;

type ActionResultExpectation = {
  description: string;
  actionName?: string | string[];
  includesAny?: Pattern[];
  includesAll?: Pattern[];
};

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function matchesPattern(value: string, pattern: Pattern): boolean {
  if (typeof pattern === "string") {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  return pattern.test(value);
}

function isSynthesizedReply(action: CapturedAction): boolean {
  const data = action.result?.data;
  return (
    data !== null &&
    typeof data === "object" &&
    (data as { source?: unknown }).source === "synthesized-reply"
  );
}

function validateResult(
  actions: CapturedAction[],
  expectation: ActionResultExpectation,
): ScenarioCheckResult {
  const actionFilters = toArray(expectation.actionName);
  const matched = actions.filter(
    (action) =>
      !isSynthesizedReply(action) &&
      (actionFilters.length === 0 || actionFilters.includes(action.actionName)),
  );
  if (matched.length === 0) {
    return `Expected ${expectation.description}: no matching action result found.`;
  }
  const blob = matched
    .map((action) =>
      JSON.stringify({
        actionName: action.actionName,
        result: action.result?.data ?? action.result?.values ?? {},
      }),
    )
    .join(" || ");
  for (const pattern of expectation.includesAll ?? []) {
    if (!matchesPattern(blob, pattern)) {
      return `Expected ${expectation.description}: result payload missing ${String(pattern)}. Payload: ${blob}`;
    }
  }
  if (expectation.includesAny?.length) {
    const ok = expectation.includesAny.some((pattern) =>
      matchesPattern(blob, pattern),
    );
    if (!ok) {
      return `Expected ${expectation.description}: result payload missing any of [${expectation.includesAny.map(String).join(", ")}]. Payload: ${blob}`;
    }
  }
  return undefined;
}

export function expectScenarioActionResultData(
  expectation: ActionResultExpectation,
) {
  return (ctx: ScenarioContext): ScenarioCheckResult =>
    validateResult(ctx.actionsCalled, expectation);
}

export function expectTurnActionResultData(
  expectation: ActionResultExpectation,
) {
  return (turn: ScenarioTurnExecution): ScenarioCheckResult =>
    validateResult(turn.actionsCalled, expectation);
}
