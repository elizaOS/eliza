/**
 * A reservation is released only when the provider clearly refused the
 * request before accepting work. These cases pin the shared-runtime rule
 * that no model call completed in the turn.
 */
import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import {
  classifySharedRuntimeTurnFailure,
  isUnacceptedSharedModelFailure,
  SharedRuntimeTurnError,
} from "./shared-runtime/shared-runtime-errors";

function providerError(statusCode: number) {
  return new APICallError({
    message: `provider failed: ${statusCode}`,
    url: "https://provider.example/v1",
    requestBodyValues: {},
    statusCode,
  });
}

describe("shared runtime turn rejection", () => {
  function turnError(status: number, completed: boolean) {
    const classification = classifySharedRuntimeTurnFailure(providerError(status));
    return new SharedRuntimeTurnError("turn failed", providerError(status), undefined, {
      modelInvocationStarted: true,
      failureKind: "unknown",
      terminalFailurePresent: true,
      terminalMode: "none",
      lastModelCompletion: completed
        ? { operation: "generate", textPresent: true, toolCount: 0, finishClass: "stop" }
        : null,
      modelFailure: {
        operation: "generate",
        errorName: "AI_APICallError",
        failureName: classification.failureName,
        retryable: classification.retryable,
        providerStatus: status,
      },
    });
  }

  test("a refused first model call with no completed call is not accepted", () => {
    expect(isUnacceptedSharedModelFailure(turnError(429, false))).toBe(true);
  });

  test("a refusal after a completed model call stays conservative", () => {
    expect(isUnacceptedSharedModelFailure(turnError(429, true))).toBe(false);
  });

  test("a server error stays conservative", () => {
    expect(isUnacceptedSharedModelFailure(turnError(503, false))).toBe(false);
  });
});
