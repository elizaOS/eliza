import { describe, expect, test } from "bun:test";
import { getSafeProviderErrorMetadata } from "./provider-error-metadata";

describe("provider failure diagnostic privacy", () => {
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
