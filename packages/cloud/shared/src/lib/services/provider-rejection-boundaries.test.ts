/**
 * A reservation is released only when the provider clearly refused the
 * request before accepting work. These cases pin the status set and the
 * shared-runtime rule that no model call completed in the turn.
 */
import { describe, expect, test } from "bun:test";
import { APICallError, RetryError } from "ai";
import {
  isKnownUnacceptedProviderError,
  isKnownUnacceptedProviderStatus,
} from "./inference-provider-outcome";
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

describe("provider rejection status set", () => {
  test("explicit refusals count as not accepted", () => {
    for (const status of [400, 401, 402, 403, 404, 409, 413, 422, 429]) {
      expect(isKnownUnacceptedProviderStatus(status)).toBe(true);
      expect(isKnownUnacceptedProviderError(providerError(status))).toBe(true);
    }
  });

  test("timeouts and server errors stay conservative", () => {
    for (const status of [408, 500, 502, 503, 504]) {
      expect(isKnownUnacceptedProviderStatus(status)).toBe(false);
      expect(isKnownUnacceptedProviderError(providerError(status))).toBe(false);
    }
  });

  test("a retry counts only by its last attempt", () => {
    const retried = new RetryError({
      message: "retries exhausted",
      reason: "maxRetriesExceeded",
      errors: [providerError(422), providerError(503)],
    });
    expect(isKnownUnacceptedProviderError(retried)).toBe(false);
  });
});

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
