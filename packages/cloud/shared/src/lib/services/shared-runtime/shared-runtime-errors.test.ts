/** Verifies Shared turn failures retain safe cause and retry classification. */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import {
  parseSharedRuntimeFailureDiagnostic,
  recordSharedRuntimeFailureDiagnostic,
  SharedRuntimeTurnError,
  sharedModelFailureDiagnostic,
} from "./shared-runtime-errors";

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

describe("Shared failure diagnostic boundary", () => {
  const diagnostic = () => ({
    modelInvocationStarted: true,
    failureKind: "transient_failure",
    terminalFailurePresent: true,
    terminalMode: "simple" as const,
    lastModelCompletion: {
      operation: "generate" as const,
      textPresent: true,
      toolCount: 0,
      finishClass: "stop" as const,
    },
    modelFailure: {
      operation: "generate" as const,
      errorName: "AI_InvalidToolInputError",
      failureName: "SharedRuntimeUnknownError" as const,
      retryable: false,
    },
  });

  test("preserves weak cause metadata through JSON without changing cause or retry classification", () => {
    const cause = new Error("PRIVATE_PROVIDER_BODY");
    recordSharedRuntimeFailureDiagnostic(cause, diagnostic());
    const original = new SharedRuntimeTurnError("failed", cause, {
      failureName: "SharedRuntimeProviderUnavailableError",
      retryable: true,
    });
    expect(original.cause).toBe(cause);
    expect(Object.keys(cause)).toEqual([]);
    const transport = JSON.parse(
      JSON.stringify({
        failureName: original.failureName,
        retryable: original.retryable,
        failureDiagnostic: original.failureDiagnostic,
      }),
    );
    const hydrated = SharedRuntimeTurnError.fromClassification(
      transport.failureName,
      transport.retryable,
      transport.failureDiagnostic,
    );
    expect(hydrated.failureDiagnostic).toEqual(diagnostic());
    expect(hydrated.retryable).toBe(true);
    expect(JSON.stringify(hydrated)).not.toContain("PRIVATE_PROVIDER_BODY");
  });

  test("drops undeclared SDK and transcript payloads at every nested transport level", () => {
    const input = {
      ...diagnostic(),
      prompt: "PRIVATE_PROMPT",
      responseBody: "PRIVATE_BODY",
      lastModelCompletion: { ...diagnostic().lastModelCompletion, text: "PRIVATE_OUTPUT" },
      modelFailure: {
        ...diagnostic().modelFailure,
        headers: { authorization: "PRIVATE_KEY" },
        message: "PRIVATE_MESSAGE",
      },
    };
    const projected = parseSharedRuntimeFailureDiagnostic(input);
    expect(projected).toEqual(diagnostic());
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
    expect(
      parseSharedRuntimeFailureDiagnostic({ ...input, failureKind: "PRIVATE_KIND" })?.failureKind,
    ).toBe("unknown");
  });

  test("rejects malformed counts, provider statuses and model names without changing disposition", () => {
    for (const value of [
      { ...diagnostic(), modelInvocationStarted: "true" },
      {
        ...diagnostic(),
        lastModelCompletion: { ...diagnostic().lastModelCompletion, toolCount: 65 },
      },
      { ...diagnostic(), modelFailure: { ...diagnostic().modelFailure, providerStatus: 503.5 } },
      {
        ...diagnostic(),
        modelFailure: { ...diagnostic().modelFailure, errorName: "PRIVATE_ERROR_NAME" },
      },
      {
        ...diagnostic(),
        modelFailure: { ...diagnostic().modelFailure, diagnosticCode: "PRIVATE_CODE" },
      },
    ]) {
      const error = SharedRuntimeTurnError.fromClassification(
        "SharedRuntimeProviderUnavailableError",
        true,
        value,
      );
      expect(error.failureDiagnostic).toBeUndefined();
      expect(error.retryable).toBe(true);
    }
    const inconsistent = SharedRuntimeTurnError.fromClassification(
      "SharedRuntimeNoReplyError",
      true,
      diagnostic(),
    );
    expect(inconsistent.failureDiagnostic).toBeUndefined();
    expect(inconsistent.retryable).toBe(false);
  });

  test("keeps an actual upstream status separate from generic normalized transient failure", () => {
    const cause = Object.assign(new Error("PRIVATE_PROVIDER_DETAILS"), {
      name: "AI_APICallError",
      statusCode: 400,
    });
    expect(sharedModelFailureDiagnostic(cause, "generate")).toEqual({
      operation: "generate",
      errorName: "AI_APICallError",
      failureName: "SharedRuntimeProviderRejectedError",
      retryable: false,
      providerStatus: 400,
    });
    expect(
      sharedModelFailureDiagnostic(new TypeError("PRIVATE_PIPELINE_DETAILS"), "generate"),
    ).toEqual({
      operation: "generate",
      errorName: "TypeError",
      failureName: "SharedRuntimeUnknownError",
      retryable: false,
    });
  });
  test("a poisoned diagnostic getter cannot replace the original provider failure", () => {
    const cause = Object.assign(new Error("PRIVATE_CAUSE"), {
      name: "AI_APICallError",
      statusCode: 503,
    });
    const poisoned = {
      ...diagnostic(),
      get modelInvocationStarted(): boolean {
        throw new Error("PRIVATE_DIAGNOSTIC_ERROR");
      },
    };
    expect(() => recordSharedRuntimeFailureDiagnostic(cause, poisoned)).not.toThrow();
    const error = new SharedRuntimeTurnError("failed", cause);
    expect(error.cause).toBe(cause);
    expect(error.retryable).toBe(true);
    expect(error.failureName).toBe("SharedRuntimeProviderUnavailableError");
    expect(error.failureDiagnostic).toBeUndefined();
  });

  test("projects known structured-output names while discarding arbitrary names and codes", () => {
    for (const name of ["AI_NoObjectGeneratedError", "NoObjectGeneratedError"]) {
      const cause = Object.assign(new Error("PRIVATE_OUTPUT"), { name });
      expect(sharedModelFailureDiagnostic(cause, "generate").errorName).toBe(name);
    }
    const arbitrary = Object.assign(
      new ElizaError("PRIVATE_MESSAGE", {
        code: "PRIVATE_CODE",
        context: { headers: "PRIVATE_HEADERS" },
      }),
      { name: "PRIVATE_ERROR_NAME" },
    );
    const projected = sharedModelFailureDiagnostic(arbitrary, "generate");
    expect(projected.errorName).toBe("UnknownError");
    expect(projected.diagnosticCode).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
  });
  test("poisoned transport metadata and a second cause read preserve HTTP retry disposition", () => {
    const poisoned = {
      ...diagnostic(),
      get modelInvocationStarted(): boolean {
        throw new Error("PRIVATE_METADATA");
      },
    };
    const hydrated = SharedRuntimeTurnError.fromClassification(
      "SharedRuntimeProviderUnavailableError",
      true,
      poisoned,
    );
    expect(hydrated.retryable).toBe(true);
    expect(hydrated.failureDiagnostic).toBeUndefined();
    let reads = 0;
    const cause = Object.assign(new Error("PRIVATE_CAUSE"), {
      name: "AI_APICallError",
      statusCode: 503,
    });
    Object.defineProperty(cause, "cause", {
      get() {
        if (++reads > 1) throw new Error("PRIVATE_SECOND_READ");
        return undefined;
      },
    });
    const error = new SharedRuntimeTurnError("failed", cause);
    expect(error.cause).toBe(cause);
    expect(error.retryable).toBe(true);
    expect(error.failureName).toBe("SharedRuntimeProviderUnavailableError");
    expect(error.failureDiagnostic).toBeUndefined();
  });
  test("optional processing flags preserve booleans, null and legacy records without content", () => {
    for (const processingSuccess of [true, false, null]) {
      const value = {
        ...diagnostic(),
        processingSuccess,
        didRespond: true,
        responseErrorPresent: false,
      };
      expect(parseSharedRuntimeFailureDiagnostic(value)).toEqual(value);
    }
    expect(parseSharedRuntimeFailureDiagnostic(diagnostic())).toEqual(diagnostic());
    expect(
      parseSharedRuntimeFailureDiagnostic({ ...diagnostic(), processingSuccess: "PRIVATE_RESULT" }),
    ).toBeUndefined();
    expect(parseSharedRuntimeFailureDiagnostic({ ...diagnostic(), didRespond: 1 })).toBeUndefined();
    expect(
      parseSharedRuntimeFailureDiagnostic({
        ...diagnostic(),
        responseErrorPresent: "PRIVATE_ERROR",
      }),
    ).toBeUndefined();
  });

  test("poisoned result getters during diagnostic construction preserve the original terminal error", () => {
    const cause = Object.assign(new Error("PRIVATE_CAUSE"), {
      name: "AI_APICallError",
      statusCode: 503,
    });
    const result = {
      get success(): boolean {
        throw new Error("PRIVATE_RESULT_GETTER");
      },
    };
    expect(() =>
      recordSharedRuntimeFailureDiagnostic(cause, () => ({
        ...diagnostic(),
        processingSuccess: result.success,
      })),
    ).not.toThrow();
    const error = new SharedRuntimeTurnError("failed", cause);
    expect(error.cause).toBe(cause);
    expect(error.retryable).toBe(true);
    expect(error.failureDiagnostic).toBeUndefined();
    recordSharedRuntimeFailureDiagnostic(cause, () => ({
      ...diagnostic(),
      processingSuccess: null,
      didRespond: false,
      responseErrorPresent: true,
    }));
    expect(new SharedRuntimeTurnError("failed", cause).failureDiagnostic).toEqual({
      ...diagnostic(),
      processingSuccess: null,
      didRespond: false,
      responseErrorPresent: true,
    });
  });
});
