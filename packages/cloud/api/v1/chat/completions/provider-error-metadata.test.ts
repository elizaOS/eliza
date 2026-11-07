import { describe, expect, test } from "bun:test";
import { APICallError, generateText, RetryError } from "ai";
import {
  getSafeCallerLlmPurpose,
  getSafeProviderErrorMetadata,
} from "./provider-error-metadata";

describe("provider failure diagnostic privacy", () => {
  test("correlates rejected requests using only caller-asserted finite purposes", () => {
    const error = {
      statusCode: 400,
      data: {
        error: {
          code: "invalid_json_schema",
          param: "tools[0].PRIVATE_SENTINEL",
        },
      },
    };
    for (const purpose of ["should_respond", "action_planner", "response"]) {
      const request = new Request(
        "https://example.invalid/api/v1/chat/completions",
        { headers: { "X-Eliza-Llm-Purpose": purpose } },
      );
      expect(
        getSafeProviderErrorMetadata(
          error,
          getSafeCallerLlmPurpose(request.headers.get("X-Eliza-Llm-Purpose")),
        ),
      ).toEqual({
        callerPurpose: purpose,
        upstreamStatus: 400,
        providerErrorCode: "invalid_json_schema",
        parameterCategory: "tools",
      });
    }
    for (const purpose of [
      null,
      "",
      "ACTION_PLANNER",
      "unknown",
      "action_planner,response",
      "PRIVATE_SENTINEL",
      "response\r\nPRIVATE_SENTINEL",
      "x".repeat(32768),
    ]) {
      const result = getSafeProviderErrorMetadata(
        error,
        getSafeCallerLlmPurpose(purpose),
      );
      expect(result).toEqual({
        upstreamStatus: 400,
        providerErrorCode: "invalid_json_schema",
        parameterCategory: "tools",
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    }
  });

  test("classifies a provider rejection without its private schema path or body", () => {
    const result = getSafeProviderErrorMetadata({
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          code: "invalid_json_schema",
          type: "invalid_request_error",
          param: "tools[0].function.parameters.properties.PRIVATE_NOTE",
          message:
            'Invalid schema: "additionalProperties" must be false; PRIVATE_NOTE',
        },
      }),
    });
    expect(result).toEqual({
      upstreamStatus: 400,
      providerErrorCode: "invalid_json_schema",
      providerErrorType: "invalid_request_error",
      parameterCategory: "tools",
      schemaKeywords: ["additionalProperties"],
      reasonClass: "invalid_schema",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_NOTE");
  });

  test("never returns arbitrary provider strings, headers, arguments or identifiers", () => {
    const marker = "PRIVATE_SENTINEL";
    const result = getSafeProviderErrorMetadata({
      statusCode: 400,
      message: marker,
      url: marker,
      requestHeaders: { Authorization: marker },
      data: {
        error: {
          code: marker,
          type: marker,
          param: marker,
          message: marker,
          tool_arguments: marker,
        },
      },
    });
    expect(result).toEqual({ upstreamStatus: 400 });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  test("handles SDK retry envelopes and nested causes", () => {
    expect(
      getSafeProviderErrorMetadata({
        statusCode: 400,
        cause: {
          lastError: {
            statusCode: 400,
            data: {
              error: {
                code: "unsupported_parameter",
                param: "reasoning_effort",
                message: "Unsupported parameter",
              },
            },
          },
        },
      }),
    ).toEqual({
      upstreamStatus: 400,
      providerErrorCode: "unsupported_parameter",
      parameterCategory: "reasoning_effort",
      reasonClass: "unsupported_parameter",
    });
  });

  test("retains finite metadata after a real SDK generation rejection and retry wrapping", async () => {
    const marker = "PRIVATE_PROVIDER_REQUEST_SENTINEL";
    const failure = new APICallError({
      message: marker,
      url: `https://example.invalid/${marker}`,
      requestBodyValues: { messages: [{ role: "user", content: marker }] },
      responseHeaders: { "x-private": marker },
      responseBody: JSON.stringify({
        error: {
          code: "invalid_json_schema",
          type: "invalid_request_error",
          param: `tools[0].function.parameters.properties.${marker}`,
          message: `Invalid schema: "additionalProperties" must be false; ${marker}`,
        },
      }),
      statusCode: 400,
      isRetryable: false,
    });
    let dispatches = 0;
    let rejected: unknown;
    try {
      await generateText({
        model: {
          specificationVersion: "v3",
          provider: "closed-regression",
          modelId: "closed-regression",
          supportedUrls: {},
          async doGenerate() {
            dispatches++;
            throw failure;
          },
          async doStream() {
            throw new Error("Unexpected streaming dispatch");
          },
        },
        prompt: marker,
        maxRetries: 0,
      });
    } catch (error) {
      rejected = error;
    }
    expect(dispatches).toBe(1);
    expect(APICallError.isInstance(rejected)).toBe(true);
    expect(rejected).toBe(failure);
    const retry = new RetryError({
      message: marker,
      reason: "errorNotRetryable",
      errors: [rejected],
    });
    expect(RetryError.isInstance(retry)).toBe(true);
    for (const error of [
      rejected,
      retry,
      new Error(marker, { cause: retry }),
    ]) {
      const metadata = getSafeProviderErrorMetadata(error, "action_planner");
      expect(metadata).toEqual({
        callerPurpose: "action_planner",
        upstreamStatus: 400,
        providerErrorCode: "invalid_json_schema",
        providerErrorType: "invalid_request_error",
        parameterCategory: "tools",
        schemaKeywords: ["additionalProperties"],
        reasonClass: "invalid_schema",
      });
      expect(JSON.stringify(metadata)).not.toContain(marker);
    }
  });

  test("invalid and oversize bodies retain status without processing their contents", () => {
    for (const responseBody of [
      "not JSON PRIVATE_SENTINEL",
      `${" ".repeat(32769)}{"error":{"code":"invalid_request"}}`,
    ]) {
      expect(
        getSafeProviderErrorMetadata({ statusCode: 400, responseBody }),
      ).toEqual({ upstreamStatus: 400 });
    }
  });

  test("cycles, missing errors and forged status strings do not escape", () => {
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    for (const value of [
      null,
      undefined,
      cycle,
      { statusCode: "400" },
      { statusCode: 200 },
      { statusCode: NaN },
    ])
      expect(getSafeProviderErrorMetadata(value)).toEqual({});
  });
  test("empty SDK data does not hide a structured provider body", () => {
    expect(
      getSafeProviderErrorMetadata({
        statusCode: 400,
        data: {},
        responseBody:
          '{"error":{"code":"invalid_request","param":"messages[0].PRIVATE"}}',
      }),
    ).toEqual({
      upstreamStatus: 400,
      providerErrorCode: "invalid_request",
      parameterCategory: "messages",
    });
  });

  test("throwing getters cannot replace the original failure", () => {
    const error = Object.defineProperty({}, "statusCode", {
      get() {
        throw new Error("PRIVATE_SENTINEL");
      },
    });
    expect(getSafeProviderErrorMetadata(error)).toEqual({});
  });
  test("near-limit repeated prefixes without a terminal match remain unclassified", () => {
    for (const prefix of [
      "tool response ",
      "tool messages ",
      "schema ",
      "parameter ",
    ]) {
      const message = prefix.repeat(5000).slice(0, 32768);
      expect(
        getSafeProviderErrorMetadata({
          statusCode: 400,
          data: { error: { message } },
        }),
      ).toEqual({ upstreamStatus: 400 });
    }
  });

  test("ordered classification retains supported reasons and rejects reversed words", () => {
    for (const [message, reasonClass] of [
      ["Schema field is not supported", "invalid_schema"],
      ["Parameter value is not supported", "unsupported_parameter"],
      ["Tool call response is missing", "invalid_tool_history"],
      ["Tool messages must precede this response", "invalid_tool_history"],
    ])
      expect(
        getSafeProviderErrorMetadata({
          statusCode: 400,
          data: { error: { message } },
        }),
      ).toEqual({ upstreamStatus: 400, reasonClass });
    expect(
      getSafeProviderErrorMetadata({
        statusCode: 400,
        data: { error: { message: "missing response tool" } },
      }),
    ).toEqual({ upstreamStatus: 400 });
  });
});
