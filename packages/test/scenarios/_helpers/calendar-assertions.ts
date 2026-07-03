import type {
  ScenarioCheckResult,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { describeCalls, successfulCalls } from "./effect-assertions.ts";

type Pattern = string | RegExp;

type CalendarExpectation = {
  description: string;
  includesAll?: Pattern[];
  includesAny?: Pattern[];
  minCount?: number;
};

function matchesPattern(value: string, pattern: Pattern): boolean {
  if (typeof pattern === "string") {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  return pattern.test(value);
}

function validateBlob(
  blob: string,
  expectation: CalendarExpectation,
): ScenarioCheckResult {
  for (const pattern of expectation.includesAll ?? []) {
    if (!matchesPattern(blob, pattern)) {
      return `Expected ${expectation.description}: missing ${String(pattern)}. Payload: ${blob.slice(0, 600)}`;
    }
  }

  if (expectation.includesAny?.length) {
    const matched = expectation.includesAny.some((pattern) =>
      matchesPattern(blob, pattern),
    );
    if (!matched) {
      return `Expected ${expectation.description}: missing any of [${expectation.includesAny.map(String).join(", ")}]. Payload: ${blob.slice(0, 600)}`;
    }
  }

  return undefined;
}

function successfulCalendarCalls(ctx: ScenarioContext) {
  const calls = successfulCalls(ctx, "CALENDAR");
  if (calls.length === 0) {
    return {
      calls,
      failure: `Expected successful CALENDAR action. Saw: ${describeCalls(ctx)}`,
    };
  }
  return { calls, failure: undefined };
}

export function expectCalendarResultData(expectation: CalendarExpectation) {
  return (ctx: ScenarioContext): ScenarioCheckResult => {
    const { calls, failure } = successfulCalendarCalls(ctx);
    if (failure) return failure;

    const dataValues = calls
      .map((call) => call.result?.data)
      .filter((data) => data !== undefined && data !== null);
    if (dataValues.length < (expectation.minCount ?? 1)) {
      return `Expected ${expectation.description}: successful CALENDAR result data, saw ${dataValues.length}. Calls: ${describeCalls(ctx)}`;
    }

    return validateBlob(JSON.stringify(dataValues).toLowerCase(), expectation);
  };
}

export function expectCalendarPayload(expectation: CalendarExpectation) {
  return (ctx: ScenarioContext): ScenarioCheckResult => {
    const { calls, failure } = successfulCalendarCalls(ctx);
    if (failure) return failure;

    const blob = JSON.stringify(
      calls.map((call) => ({
        parameters: call.parameters ?? null,
        data: call.result?.data ?? null,
        text: call.result?.text ?? null,
      })),
    ).toLowerCase();

    return validateBlob(blob, expectation);
  };
}
