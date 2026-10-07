/** Proves normalized retry and privacy contracts against the canonical runtime error leaf and coordinator adapter. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ElizaError } from "@elizaos/core/protocol";
import {
  classifySharedRuntimeTurnFailure,
  projectQualifiedSharedProviderFailure,
  SharedRuntimeTurnError,
  sharedModelCompletionDiagnostic,
} from "../../shared/src/lib/services/shared-runtime/shared-runtime-errors.ts";

function normalizedFailure(kind: string, transient: boolean): ElizaError {
  return new ElizaError("Eliza Shared runtime message processing failed.", {
    code: "SHARED_RUNTIME_MESSAGE_FAILED",
    context: { failureKind: kind, transient },
    cause: { kind, transient, message: "Private failure content" },
    severity: transient ? "ephemeral" : "fatal",
  });
}

describe("Shared normalized failure delivery classification", () => {
  for (const kind of ["transient_failure", "rate_limited"]) {
    test(`keeps ${kind} retryable across the coordinator classification`, () => {
      const original = normalizedFailure(kind, true);
      const turn = new SharedRuntimeTurnError("Shared turn failed.", original);
      assert.equal(turn.failureName, "SharedRuntimeProviderUnavailableError");
      assert.equal(turn.retryable, true);
      assert.equal(turn.cause, original);
      const transported = SharedRuntimeTurnError.fromClassification(
        turn.failureName,
        turn.retryable,
      );
      assert.equal(transported.failureName, turn.failureName);
      assert.equal(transported.retryable, true);
      assert.deepEqual(turn.context, {
        failureName: "SharedRuntimeProviderUnavailableError",
        retryable: true,
      });
      assert.equal(
        JSON.stringify(turn.context).includes("Private failure content"),
        false,
      );
    });
  }

  test("keeps missing provider configuration terminal", () => {
    const turn = new SharedRuntimeTurnError(
      "Shared turn failed.",
      normalizedFailure("no_provider", false),
    );
    assert.equal(turn.failureName, "SharedRuntimeProviderConfigurationError");
    assert.equal(turn.retryable, false);
  });

  for (const kind of ["provider_issue", "insufficient_credits"]) {
    test(`does not retry the terminal ${kind} outcome`, () => {
      const turn = new SharedRuntimeTurnError(
        "Shared turn failed.",
        normalizedFailure(kind, false),
      );
      assert.equal(turn.failureName, "SharedRuntimeProviderRejectedError");
      assert.equal(turn.retryable, false);
    });
  }

  test("unknown or inconsistent terminal metadata stays fail closed", () => {
    for (const error of [
      normalizedFailure("transient_failure", false),
      normalizedFailure("no_provider", true),
      normalizedFailure("unknown_future_kind", true),
    ]) {
      const turn = new SharedRuntimeTurnError("Shared turn failed.", error);
      assert.equal(turn.failureName, "SharedRuntimeUnknownError");
      assert.equal(turn.retryable, false);
    }
  });

  test("a plain transport object cannot forge canonical normalized failure authority", () => {
    const turn = new SharedRuntimeTurnError("Shared turn failed.", {
      code: "SHARED_RUNTIME_MESSAGE_FAILED",
      context: { failureKind: "rate_limited", transient: true },
    });
    assert.equal(turn.failureName, "SharedRuntimeUnknownError");
    assert.equal(turn.retryable, false);
  });

  test("the existing raw provider error classification remains unchanged", () => {
    const providerError = Object.assign(new Error("Private provider error"), {
      name: "AI_APICallError",
      statusCode: 503,
    });
    const turn = new SharedRuntimeTurnError(
      "Shared turn failed.",
      providerError,
    );
    assert.equal(turn.failureName, "SharedRuntimeProviderUnavailableError");
    assert.equal(turn.retryable, true);
  });

  test("model diagnostics contain only classification and bounded upstream status", () => {
    const providerError = Object.assign(new Error("private provider message"), {
      name: "AI_APICallError",
      statusCode: 401,
      requestBodyValues: { prompt: "private prompt" },
      responseBody: "private response",
      responseHeaders: { authorization: "private credential" },
      url: "https://private-endpoint.invalid/",
    });
    assert.deepEqual(classifySharedRuntimeTurnFailure(providerError), {
      failureName: "SharedRuntimeProviderRejectedError",
      retryable: false,
      providerStatus: 401,
    });
    for (const statusCode of [99, 600, Number.NaN, 503.5, "503"]) {
      const invalid = Object.assign(new Error("private invalid status"), {
        statusCode,
      });
      const projected = classifySharedRuntimeTurnFailure(invalid);
      assert.equal(projected.providerStatus, undefined);
      assert.equal(JSON.stringify(projected).includes("private"), false);
    }
  });

  for (const statusCode of [401, 503] as const) {
    test(`projects HTTP${statusCode} into core without provider payloads`, () => {
      const privateSentinel = "private prompt / credential sentinel";
      const sdk = Object.assign(new Error(privateSentinel), {
        name: "AI_APICallError",
        statusCode,
        requestBodyValues: { prompt: privateSentinel },
        responseBody: privateSentinel,
        responseHeaders: { authorization: privateSentinel },
        url: `https://private-endpoint.invalid/${privateSentinel}`,
      });
      const projected = projectQualifiedSharedProviderFailure(sdk);
      assert.ok(projected instanceof ElizaError);
      assert.equal(projected.statusCode, statusCode);
      assert.equal(projected.cause, undefined);
      assert.equal(projected.message.includes(privateSentinel), false);
      assert.equal(JSON.stringify(projected).includes(privateSentinel), false);
      assert.deepEqual(classifySharedRuntimeTurnFailure(projected), {
        failureName:
          statusCode === 503
            ? "SharedRuntimeProviderUnavailableError"
            : "SharedRuntimeProviderRejectedError",
        retryable: statusCode === 503,
        providerStatus: statusCode,
      });
      assert.equal(sdk.responseBody, privateSentinel);
    });
  }

  test("unqualified provider classes do not acquire new core behavior", () => {
    for (const statusCode of [400, 403, 429, 500, undefined]) {
      assert.equal(
        projectQualifiedSharedProviderFailure(
          Object.assign(new Error("private unqualified failure"), {
            statusCode,
          }),
        ),
        undefined,
      );
    }
  });
  test("completion diagnostics retain only fixed shape and bounded counts", () => {
    const sentinel = "private output / tool / finish sentinel";
    const projected = sharedModelCompletionDiagnostic(
      "generate",
      sentinel,
      99999,
      sentinel,
    );
    assert.deepEqual(projected, {
      operation: "generate",
      textPresent: true,
      toolCount: 64,
      finishClass: "unknown",
    });
    assert.equal(JSON.stringify(projected).includes(sentinel), false);
    assert.deepEqual(sharedModelCompletionDiagnostic("stream", "", 0, "stop"), {
      operation: "stream",
      textPresent: false,
      toolCount: 0,
      finishClass: "stop",
    });
    assert.equal(
      sharedModelCompletionDiagnostic("generate", null, Number.NaN, "other")
        .toolCount,
      null,
    );
  });
});
