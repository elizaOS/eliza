/**
 * Shape tests for provider-error body recovery: `providerErrorBodyMessage` /
 * `enrichProviderCallError` (unmasking the AI SDK's statusText-only message
 * for providers with non-OpenAI error envelopes, e.g. Cerebras's flat
 * `{"message","type","param","code"}` shape) and the transient-400 retry
 * classifier reading the response body. Deterministic — constructed error
 * objects, no live provider.
 */
import { describe, expect, it } from "vitest";

import {
  __INTERNAL_enrichProviderCallError,
  __INTERNAL_isTransientProviderError,
  __INTERNAL_providerErrorBodyMessage,
} from "../models/text";

function apiCallError(args: {
  message?: string;
  statusCode?: number;
  responseBody?: string;
}): Error & { statusCode?: number; responseBody?: string } {
  return Object.assign(new Error(args.message ?? "Bad Request"), {
    statusCode: args.statusCode,
    responseBody: args.responseBody,
  });
}

const CEREBRAS_FLAT_400 =
  '{"message":": Invalid JSON: lone leading surrogate in hex escape at line 1 column 135","type":"invalid_request_error","param":"validation_error","code":"wrong_api_format"}';

describe("providerErrorBodyMessage", () => {
  it("parses the flat Cerebras error shape", () => {
    const error = apiCallError({ statusCode: 400, responseBody: CEREBRAS_FLAT_400 });
    expect(__INTERNAL_providerErrorBodyMessage(error)).toContain("lone leading surrogate");
  });

  it("parses the OpenAI error envelope", () => {
    const error = apiCallError({
      statusCode: 400,
      responseBody: '{"error":{"message":"model_not_found"}}',
    });
    expect(__INTERNAL_providerErrorBodyMessage(error)).toBe("model_not_found");
  });

  it("returns a bounded excerpt for a non-JSON body", () => {
    const error = apiCallError({
      statusCode: 400,
      responseBody: `gateway says no ${"y".repeat(1000)}`,
    });
    const message = __INTERNAL_providerErrorBodyMessage(error);
    expect(message).toContain("gateway says no");
    expect((message ?? "").length).toBeLessThanOrEqual(300);
  });

  it("walks the cause chain", () => {
    const wrapped = new Error("outer", {
      cause: apiCallError({ statusCode: 400, responseBody: '{"message":"inner detail"}' }),
    });
    expect(__INTERNAL_providerErrorBodyMessage(wrapped)).toBe("inner detail");
  });

  it("is undefined without a body", () => {
    expect(__INTERNAL_providerErrorBodyMessage(apiCallError({ statusCode: 400 }))).toBeUndefined();
    expect(__INTERNAL_providerErrorBodyMessage(undefined)).toBeUndefined();
  });
});

describe("enrichProviderCallError", () => {
  it("appends the body message to a masked statusText message in place", () => {
    const error = apiCallError({ statusCode: 400, responseBody: CEREBRAS_FLAT_400 });
    const enriched = __INTERNAL_enrichProviderCallError(error) as Error;
    expect(enriched).toBe(error);
    expect(enriched.message).toContain("Bad Request");
    expect(enriched.message).toContain("lone leading surrogate");
  });

  it("is idempotent — enriching twice does not duplicate the detail", () => {
    const error = apiCallError({ statusCode: 400, responseBody: '{"message":"only once"}' });
    __INTERNAL_enrichProviderCallError(error);
    __INTERNAL_enrichProviderCallError(error);
    expect(error.message.match(/only once/g)?.length).toBe(1);
  });

  it("leaves errors without a recoverable body untouched", () => {
    const error = apiCallError({ statusCode: 400 });
    expect((__INTERNAL_enrichProviderCallError(error) as Error).message).toBe("Bad Request");
  });

  it("passes through non-object errors", () => {
    expect(__INTERNAL_enrichProviderCallError("boom")).toBe("boom");
    expect(__INTERNAL_enrichProviderCallError(undefined)).toBeUndefined();
  });
});

describe("isTransientProviderError with response bodies", () => {
  it("classifies a Cerebras overload 400 as transient even when the message is masked", () => {
    // The live failure signature: message is the bare statusText because the
    // SDK could not parse the flat error shape; the transient wording lives
    // only in the body. Before body-reading, this returned false and the
    // documented transient-400 retry lane never engaged.
    const error = apiCallError({
      statusCode: 400,
      responseBody:
        '{"message":"Encountered a server error, please try again","type":"server_error"}',
    });
    expect(__INTERNAL_isTransientProviderError(error)).toBe(true);
  });

  it("keeps a genuine validation 400 non-transient (no retry masking)", () => {
    const error = apiCallError({ statusCode: 400, responseBody: CEREBRAS_FLAT_400 });
    expect(__INTERNAL_isTransientProviderError(error)).toBe(false);
  });

  it("keeps a body-less masked 400 non-transient", () => {
    expect(__INTERNAL_isTransientProviderError(apiCallError({ statusCode: 400 }))).toBe(false);
  });
});
