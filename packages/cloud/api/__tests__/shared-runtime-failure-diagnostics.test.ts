/** Exercises closed provider diagnostics and cause identity through the public protocol constructor. */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core/protocol";
import { APICallError } from "ai";
import {
  parseSharedRuntimeFailureDiagnostic,
  recordSharedRuntimeFailureDiagnostic,
  SharedRuntimeTurnError,
  sharedModelFailureDiagnostic,
} from "../../shared/src/lib/services/shared-runtime/shared-runtime-errors";

describe("Shared failure diagnostic boundary", () => {
  const diagnostic = () => ({
    diagnosticSchemaVersion: 2 as const,
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
      lastModelCompletion: {
        ...diagnostic().lastModelCompletion,
        text: "PRIVATE_OUTPUT",
      },
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
      parseSharedRuntimeFailureDiagnostic({
        ...input,
        failureKind: "PRIVATE_KIND",
      })?.failureKind,
    ).toBe("unknown");
  });

  test("rejects malformed counts, provider statuses and model names without changing disposition", () => {
    for (const value of [
      { ...diagnostic(), modelInvocationStarted: "true" },
      {
        ...diagnostic(),
        lastModelCompletion: {
          ...diagnostic().lastModelCompletion,
          toolCount: 65,
        },
      },
      {
        ...diagnostic(),
        modelFailure: { ...diagnostic().modelFailure, providerStatus: 503.5 },
      },
      {
        ...diagnostic(),
        modelFailure: {
          ...diagnostic().modelFailure,
          errorName: "PRIVATE_ERROR_NAME",
        },
      },
      {
        ...diagnostic(),
        modelFailure: {
          ...diagnostic().modelFailure,
          diagnosticCode: "PRIVATE_CODE",
        },
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
    expect(sharedModelFailureDiagnostic(cause, "generate")).toMatchObject({
      operation: "generate",
      errorName: "AI_APICallError",
      failureName: "SharedRuntimeProviderRejectedError",
      retryable: false,
      providerStatus: 400,
    });
    expect(
      sharedModelFailureDiagnostic(
        new TypeError("PRIVATE_PIPELINE_DETAILS"),
        "generate",
      ),
    ).toMatchObject({
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
    expect(() =>
      recordSharedRuntimeFailureDiagnostic(cause, poisoned),
    ).not.toThrow();
    const error = new SharedRuntimeTurnError("failed", cause);
    expect(error.cause).toBe(cause);
    expect(error.retryable).toBe(true);
    expect(error.failureName).toBe("SharedRuntimeProviderUnavailableError");
    expect(error.failureDiagnostic).toBeUndefined();
  });

  test("projects known structured-output names while discarding arbitrary names and codes", () => {
    for (const name of [
      "AI_NoObjectGeneratedError",
      "NoObjectGeneratedError",
    ]) {
      const cause = Object.assign(new Error("PRIVATE_OUTPUT"), { name });
      expect(sharedModelFailureDiagnostic(cause, "generate").errorName).toBe(
        name,
      );
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
    expect(parseSharedRuntimeFailureDiagnostic(diagnostic())).toEqual(
      diagnostic(),
    );
    expect(
      parseSharedRuntimeFailureDiagnostic({
        ...diagnostic(),
        processingSuccess: "PRIVATE_RESULT",
      }),
    ).toBeUndefined();
    expect(
      parseSharedRuntimeFailureDiagnostic({ ...diagnostic(), didRespond: 1 }),
    ).toBeUndefined();
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
    expect(
      new SharedRuntimeTurnError("failed", cause).failureDiagnostic,
    ).toEqual({
      ...diagnostic(),
      processingSuccess: null,
      didRespond: false,
      responseErrorPresent: true,
    });
  });
});

describe("Closed provider error diagnostics", () => {
  const sdkError = (detail: unknown, responseBody?: string) =>
    new APICallError({
      message: "PRIVATE_SDK_MESSAGE",
      url: "https://fixture.invalid/chat/completions",
      requestBodyValues: { prompt: "PRIVATE_PROMPT" },
      statusCode: 400,
      responseHeaders: { "x-fixture": "PRIVATE_HEADER" },
      data: detail === undefined ? undefined : { error: detail },
      responseBody,
      isRetryable: false,
    });
  const safeDiagnostic = (error: unknown) => ({
    diagnosticSchemaVersion: 2 as const,
    modelInvocationStarted: true,
    failureKind: "transient_failure",
    terminalFailurePresent: false,
    terminalMode: "simple" as const,
    lastModelCompletion: null,
    modelFailure: sharedModelFailureDiagnostic(error, "generate"),
  });
  test.each([
    [
      "duplicate tool_call.id values are rejected",
      "messages[4].tool_calls[0].id",
      "duplicate_tool_call_id",
      "messages",
    ],
    [
      "tool messages must follow the prior assistant tool call",
      "messages.4",
      "tool_message_pairing",
      "messages",
    ],
    [
      "tool_choice cannot be set unless tools is provided",
      "tool_choice",
      "tool_choice",
      "tool_choice",
    ],
    [
      "minLength is unsupported in schema",
      "tools[0].function.parameters",
      "schema",
      "tools",
    ],
    [
      "maximum context window length exceeds limit",
      "messages",
      "context_limit",
      "messages",
    ],
    [
      "unsupported parameter",
      "temperature",
      "unsupported_parameter",
      "generation",
    ],
  ])(
    "projects only a closed category for %s",
    (message, param, category, parameterClass) => {
      const error = sdkError({
        message: `${message} PRIVATE_BODY`,
        type: "invalid_request_error",
        param,
        code: null,
      });
      const result = sharedModelFailureDiagnostic(error, "generate");
      expect(result.providerError).toMatchObject({
        category,
        parameterClass,
        type: "invalid_request_error",
        code: "unknown",
      });
      expect(result.failureName).toBe("SharedRuntimeProviderRejectedError");
      expect(result.retryable).toBe(false);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    },
  );
  test("closed tool generation codes do not expose failed generated content", () => {
    for (const code of ["tool_use_failed", "failed_generation"]) {
      const error = sdkError({
        code,
        message: "PRIVATE_BODY",
        failed_generation: "PRIVATE_TOOL",
      });
      const result = sharedModelFailureDiagnostic(error, "generate");
      expect(result.providerError).toMatchObject({
        category: "tool_generation",
        type: "unknown",
        code,
        parameterClass: "unknown",
      });
      expect(result.retryable).toBe(false);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    }
  });
  test("explicit failed tool generation patterns produce only closed categories", () => {
    for (const operation of ["generate", "parse"]) {
      const error = sdkError({
        message: `Failed to ${operation} tool call: PRIVATE_TOOL`,
      });
      const result = sharedModelFailureDiagnostic(error, "generate");
      expect(result.providerError?.category).toBe("tool_generation");
      expect(result.providerError?.code).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    }
  });
  test("reads SDK responseBody only in RAM when parsed data is absent", () => {
    const body = JSON.stringify({
      error: {
        message: "PRIVATE_BODY",
        type: "PRIVATE_TYPE",
        code: "invalid_tool_schema",
        param: "response_format.json_schema.schema.PRIVATE_FIELD",
      },
    });
    const error = sdkError(undefined, body);
    const result = sharedModelFailureDiagnostic(error, "generate");
    expect(result.providerError).toMatchObject({
      category: "schema",
      type: "unknown",
      code: "invalid_tool_schema",
      parameterClass: "response_format",
    });
    expect(error.responseBody).toBe(body);
    expect(error.requestBodyValues).toEqual({ prompt: "PRIVATE_PROMPT" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });
  test("bounds malformed, oversized and non-object response bodies", () => {
    for (const body of [
      "PRIVATE_NON_JSON",
      "null",
      "[]",
      JSON.stringify({ error: "PRIVATE_DETAIL" }),
      "x".repeat(32769),
    ]) {
      const error = sdkError(undefined, body);
      expect(
        sharedModelFailureDiagnostic(error, "generate").providerError,
      ).toBeDefined();
      expect(error.responseBody).toBe(body);
    }
  });
  test("unknown private values become closed unknown categories", () => {
    const result = sharedModelFailureDiagnostic(
      sdkError({
        message: "PRIVATE_BODY",
        type: "PRIVATE_TYPE",
        code: "PRIVATE_CODE",
        param: "PRIVATE_PARAM",
      }),
      "generate",
    );
    expect(result.providerError).toMatchObject({
      category: "unknown",
      type: "unknown",
      code: "unknown",
      parameterClass: "unknown",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });
  test("poisoned SDK data and nested accessors preserve original error identity and disposition", () => {
    const error = sdkError(
      undefined,
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "invalid_tool_choice",
          param: "tool_choice",
          message: "PRIVATE_BODY",
        },
      }),
    );
    Object.defineProperty(error, "data", {
      get() {
        throw new Error("PRIVATE_POISON");
      },
    });
    const result = sharedModelFailureDiagnostic(error, "generate");
    expect(result.providerError?.category).toBe("tool_choice");
    const wrapper = new SharedRuntimeTurnError("failed", error);
    expect(wrapper.cause).toBe(error);
    expect(wrapper.retryable).toBe(false);
    const detail = {
      type: "invalid_request_error",
      get message() {
        throw new Error("PRIVATE_POISON");
      },
      get param() {
        throw new Error("PRIVATE_POISON");
      },
    };
    expect(
      sharedModelFailureDiagnostic(sdkError(detail), "generate").providerError,
    ).toMatchObject({
      category: "invalid_request",
      type: "invalid_request_error",
      code: "unknown",
      parameterClass: "unknown",
    });
    const allPoisoned = sdkError(undefined);
    Object.defineProperty(allPoisoned, "responseBody", {
      get() {
        throw new Error("PRIVATE_POISON");
      },
    });
    expect(
      sharedModelFailureDiagnostic(allPoisoned, "generate").providerError
        ?.responseBodyState,
    ).toBe("unreadable");
  });
  test("closed categories survive WeakMap, coordinator JSON and rehydration without payloads", () => {
    const original = sdkError({
      type: "invalid_request_error",
      code: "invalid_tool_schema",
      param: "tools",
      message: "PRIVATE_BODY",
    });
    const diagnostic = safeDiagnostic(original);
    const terminal = new Error("PRIVATE_TERMINAL");
    recordSharedRuntimeFailureDiagnostic(terminal, diagnostic);
    const wrapper = new SharedRuntimeTurnError("failed", terminal, {
      failureName: "SharedRuntimeProviderUnavailableError",
      retryable: true,
    });
    expect(wrapper.cause).toBe(terminal);
    const transport = JSON.parse(JSON.stringify(wrapper.failureDiagnostic));
    const hydrated = SharedRuntimeTurnError.fromClassification(
      wrapper.failureName,
      wrapper.retryable,
      transport,
    );
    expect(hydrated.failureDiagnostic).toEqual(diagnostic);
    expect(hydrated.retryable).toBe(true);
    expect(JSON.stringify(hydrated.failureDiagnostic)).not.toContain(
      "PRIVATE_",
    );
  });
  test("transport validators strip extra payloads and reject arbitrary category injection", () => {
    const diagnostic = safeDiagnostic(
      sdkError({ type: "invalid_request_error", message: "PRIVATE_BODY" }),
    );
    const input = JSON.parse(JSON.stringify(diagnostic));
    input.modelFailure.providerError.body = "PRIVATE_BODY";
    expect(parseSharedRuntimeFailureDiagnostic(input)).toEqual(diagnostic);
    for (const key of ["category", "type", "code", "parameterClass"]) {
      const poisoned = JSON.parse(JSON.stringify(diagnostic));
      poisoned.modelFailure.providerError[key] = "PRIVATE_INJECTION";
      expect(parseSharedRuntimeFailureDiagnostic(poisoned)).toBeUndefined();
    }
    Object.defineProperty(input.modelFailure.providerError, "category", {
      get() {
        throw new Error("PRIVATE_POISON");
      },
    });
    expect(parseSharedRuntimeFailureDiagnostic(input)).toBeUndefined();
  });
  test("nested retry errors retain the first SDK category without mutating either error", () => {
    const error = sdkError({
      type: "invalid_request_error",
      message: "duplicate tool_call.id",
      param: "messages",
    });
    const envelope = Object.assign(new Error("PRIVATE_RETRY"), {
      name: "AI_RetryError",
      lastError: error,
    });
    const result = sharedModelFailureDiagnostic(envelope, "generate");
    expect(result.providerError?.category).toBe("duplicate_tool_call_id");
    expect(result.retryable).toBe(false);
    expect(envelope.lastError).toBe(error);
  });
});

describe("Provider error envelope shape diagnostics", () => {
  const errorFor = (
    data?: unknown,
    responseBody?: string,
    message = "PRIVATE_SDK_MESSAGE",
  ) =>
    new APICallError({
      message,
      url: "https://fixture.invalid/chat/completions",
      requestBodyValues: { prompt: "PRIVATE_PROMPT" },
      statusCode: 400,
      data,
      responseBody,
      isRetryable: false,
    });
  test.each([
    [
      { message: "Failed to generate tool call: PRIVATE_BODY" },
      "top_message",
      "tool_generation",
    ],
    [
      { error: "tool_choice cannot be set unless tools provided PRIVATE_BODY" },
      "error_string",
      "tool_choice",
    ],
    [
      { detail: "minLength unsupported in schema PRIVATE_BODY" },
      "detail_string",
      "schema",
    ],
    [
      {
        detail: [
          {
            loc: ["body", "messages", 2],
            msg: "PRIVATE_BODY",
            input: "PRIVATE_INPUT",
          },
        ],
      },
      "validation_array",
      "unknown",
    ],
    [
      [{ loc: ["body", "tools", 0], msg: "invalid schema PRIVATE_BODY" }],
      "validation_array",
      "schema",
    ],
    [{ privateField: "PRIVATE_BODY" }, "other_json", "unknown"],
    [
      "Failed to parse tool call: PRIVATE_BODY",
      "string_value",
      "tool_generation",
    ],
  ])("projects bounded SDK data envelope", (data, shape, category) => {
    const error = errorFor(data);
    const result = sharedModelFailureDiagnostic(error, "generate");
    expect(result.providerError).toMatchObject({
      source: "data",
      shape,
      category,
      responseBodyState: "absent",
    });
    expect(result.retryable).toBe(false);
    expect(error.data).toBe(data);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });
  test.each([
    [
      JSON.stringify({
        message: "unsupported parameter PRIVATE_BODY",
        param: "temperature",
      }),
      "top_message",
      "json",
      "unsupported_parameter",
    ],
    [
      JSON.stringify({ detail: "Failed to generate tool call PRIVATE_BODY" }),
      "detail_string",
      "json",
      "tool_generation",
    ],
    [
      JSON.stringify({ error: "duplicate tool_call.id PRIVATE_BODY" }),
      "error_string",
      "json",
      "duplicate_tool_call_id",
    ],
    [
      JSON.stringify({
        detail: [
          {
            loc: ["body", "messages", 1],
            msg: "PRIVATE_BODY",
            input: "PRIVATE_INPUT",
          },
        ],
      }),
      "validation_array",
      "json",
      "unknown",
    ],
    [
      JSON.stringify("Failed to parse tool call PRIVATE_BODY"),
      "string_value",
      "json",
      "tool_generation",
    ],
    [
      "tool_choice cannot be set unless tools provided PRIVATE_BODY",
      "plain_text",
      "non_json",
      "tool_choice",
    ],
    ["PRIVATE_NON_JSON", "plain_text", "non_json", "unknown"],
    ["null", "other_json", "json", "unknown"],
  ])(
    "projects bounded SDK response body envelope without output",
    (body, shape, responseBodyState, category) => {
      const error = errorFor(undefined, body);
      const result = sharedModelFailureDiagnostic(error, "generate");
      expect(result.providerError).toMatchObject({
        source: "response_body",
        shape,
        category,
        dataState: "absent",
        responseBodyState,
      });
      expect(error.responseBody).toBe(body);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    },
  );
  test("absent, empty and oversized bodies still emit an explicit SDK shape", () => {
    for (const [body, state] of [
      [undefined, "absent"],
      ["", "empty"],
      ["x".repeat(32769), "oversized"],
    ] as const) {
      const error = errorFor(undefined, body);
      expect(
        sharedModelFailureDiagnostic(error, "generate").providerError,
      ).toMatchObject({
        source: "sdk_message",
        shape: "sdk_message",
        dataState: "absent",
        responseBodyState: state,
        category: "unknown",
      });
      expect(error.responseBody).toBe(body);
    }
  });
  test("a bounded SDK message provides a closed fallback category without its text", () => {
    const error = errorFor(
      undefined,
      undefined,
      "Failed to generate tool call: PRIVATE_TOOL",
    );
    const result = sharedModelFailureDiagnostic(error, "generate");
    expect(result.providerError).toMatchObject({
      category: "tool_generation",
      source: "sdk_message",
      dataState: "absent",
      responseBodyState: "absent",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });
  test("poisoned payload getters expose only unreadable state and preserve original identity", () => {
    const error = errorFor();
    for (const key of ["data", "responseBody"])
      Object.defineProperty(error, key, {
        get() {
          throw new Error("PRIVATE_POISON");
        },
      });
    const result = sharedModelFailureDiagnostic(error, "generate");
    expect(result.providerError).toMatchObject({
      dataState: "unreadable",
      responseBodyState: "unreadable",
      category: "unknown",
    });
    const wrapped = new SharedRuntimeTurnError("failed", error);
    expect(wrapped.cause).toBe(error);
    expect(wrapped.retryable).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });
  test("validation arrays inspect at most eight entries and eight location components", () => {
    const detail = Array.from({ length: 8 }, () => ({
      loc: ["body", "PRIVATE_PATH"],
      msg: "PRIVATE_BODY",
    }));
    detail.push({
      loc: ["body", "messages"],
      msg: "invalid schema PRIVATE_BODY",
    });
    const error = errorFor({ detail });
    const result = sharedModelFailureDiagnostic(error, "generate");
    expect(result.providerError).toMatchObject({
      shape: "validation_array",
      category: "unknown",
      parameterClass: "unknown",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });
  test("rejects arbitrary shape/source/state strings at transport and accepts legacy closed fields", () => {
    const diagnostic = {
      modelInvocationStarted: true,
      terminalFailurePresent: false,
      terminalMode: "simple" as const,
      failureKind: "transient_failure",
      lastModelCompletion: null,
      modelFailure: sharedModelFailureDiagnostic(errorFor(), "generate"),
    };
    expect(parseSharedRuntimeFailureDiagnostic(diagnostic)).toEqual(diagnostic);
    for (const key of ["shape", "source", "dataState", "responseBodyState"]) {
      const invalid = JSON.parse(JSON.stringify(diagnostic));
      invalid.modelFailure.providerError[key] = "PRIVATE_INJECTION";
      expect(parseSharedRuntimeFailureDiagnostic(invalid)).toBeUndefined();
    }
    const legacy = JSON.parse(JSON.stringify(diagnostic));
    for (const key of ["shape", "source", "dataState", "responseBodyState"])
      delete legacy.modelFailure.providerError[key];
    expect(parseSharedRuntimeFailureDiagnostic(legacy)).toEqual(legacy);
  });
});

describe("Fixed diagnostic producer and recorder version", () => {
  test("SDK producer and WeakMap recorder emit closed version2 without changing cause", () => {
    const error = new APICallError({
      message: "PRIVATE_BODY",
      url: "https://fixture.invalid",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    const modelFailure = sharedModelFailureDiagnostic(error, "generate");
    expect(modelFailure.diagnosticSchemaVersion).toBe(2);
    const legacy = {
      modelInvocationStarted: true,
      terminalFailurePresent: false,
      terminalMode: "simple" as const,
      failureKind: "transient_failure",
      lastModelCompletion: null,
      modelFailure,
    };
    const terminal = new Error("PRIVATE_TERMINAL");
    recordSharedRuntimeFailureDiagnostic(terminal, legacy);
    const wrapped = new SharedRuntimeTurnError("failed", terminal, {
      failureName: "SharedRuntimeProviderUnavailableError",
      retryable: true,
    });
    expect(wrapped.cause).toBe(terminal);
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.failureDiagnostic?.diagnosticSchemaVersion).toBe(2);
    expect(
      wrapped.failureDiagnostic?.modelFailure?.diagnosticSchemaVersion,
    ).toBe(2);
    expect("diagnosticSchemaVersion" in legacy).toBe(false);
    expect(JSON.stringify(wrapped.failureDiagnostic)).not.toContain("PRIVATE_");
  });
  test("transport rejects arbitrary producer or recorder versions without changing retry disposition", () => {
    const legacy = {
      modelInvocationStarted: true,
      terminalFailurePresent: false,
      terminalMode: "simple" as const,
      failureKind: "transient_failure",
      lastModelCompletion: null,
      modelFailure: sharedModelFailureDiagnostic(
        new Error("PRIVATE_BODY"),
        "generate",
      ),
    };
    expect(parseSharedRuntimeFailureDiagnostic(legacy)).toEqual(legacy);
    for (const location of ["recorder", "producer"]) {
      const input = JSON.parse(JSON.stringify(legacy));
      if (location === "recorder")
        input.diagnosticSchemaVersion = "PRIVATE_VERSION";
      else input.modelFailure.diagnosticSchemaVersion = 3;
      const wrapped = SharedRuntimeTurnError.fromClassification(
        "SharedRuntimeProviderUnavailableError",
        true,
        input,
      );
      expect(wrapped.failureDiagnostic).toBeUndefined();
      expect(wrapped.retryable).toBe(true);
    }
  });
});
