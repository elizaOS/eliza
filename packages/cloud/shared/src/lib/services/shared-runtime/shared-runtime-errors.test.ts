/** Verifies Shared turn failures retain safe cause and retry classification. */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { SharedRuntimeTurnError } from "./shared-runtime-errors";

describe("SharedRuntimeTurnError", () => {
  test("classifies an action receipt invariant as terminal", () => {
    const cause = new Error(
      "Eliza Shared runtime completed an executable REMINDERS request without an action result",
    );
    const error = new SharedRuntimeTurnError("turn failed", cause);

    expect(error).toBeInstanceOf(ElizaError);
    expect(error.code).toBe("SHARED_RUNTIME_TURN_FAILED");
    expect(error.context).toEqual({
      failureName: "SharedRuntimeActionContractError",
      retryable: false,
    });
    expect(error.severity).toBe("fatal");
    expect(error.cause).toBe(cause);
    expect(error.failureName).toBe("SharedRuntimeActionContractError");
    expect(error.retryable).toBe(false);
  });

  test("classifies a nested retry envelope by provider status", () => {
    const provider = Object.assign(new Error("private provider response"), {
      name: "AI_APICallError",
      statusCode: 503,
    });
    const retry = Object.assign(new Error("retry exhausted"), {
      lastError: provider,
    });
    const error = new SharedRuntimeTurnError("turn failed", retry);

    expect(error.failureName).toBe("SharedRuntimeProviderUnavailableError");
    expect(error.retryable).toBe(true);
    expect(error.severity).toBe("ephemeral");
    expect(JSON.stringify(error)).not.toContain("private provider response");
  });

  test("keeps an unknown runtime failure terminal instead of blind replay", () => {
    const error = new SharedRuntimeTurnError(
      "turn failed",
      new TypeError("private invariant detail"),
    );

    expect(error.failureName).toBe("SharedRuntimeUnknownError");
    expect(error.retryable).toBe(false);
  });

  test("rehydrates only allowlisted, internally consistent classifications", () => {
    expect(
      SharedRuntimeTurnError.fromClassification("SharedRuntimeProviderUnavailableError", true),
    ).toMatchObject({
      name: "SharedRuntimeTurnError",
      failureName: "SharedRuntimeProviderUnavailableError",
      retryable: true,
    });

    expect(
      SharedRuntimeTurnError.fromClassification("SharedRuntimeActionContractError", true),
    ).toMatchObject({
      failureName: "SharedRuntimeUnknownError",
      retryable: false,
    });
    expect(SharedRuntimeTurnError.fromClassification("private provider body", true)).toMatchObject({
      failureName: "SharedRuntimeUnknownError",
      retryable: false,
    });
  });
});
