/**
 * Verifies only explicit caller/auth/rate-limit rejections qualify for a
 * known-zero settlement after provider dispatch.
 */

import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import {
  isKnownPreDispatchProviderConfigurationError,
  isKnownUnacceptedProviderError,
} from "./inference-provider-outcome";

function providerError(statusCode: number): APICallError {
  return new APICallError({
    message: `provider returned ${statusCode}`,
    url: "https://provider.example/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
  });
}

describe("isKnownUnacceptedProviderError", () => {
  test.each([400, 401, 402, 403, 404, 413, 422, 429])(
    "classifies explicit %i rejection as unaccepted",
    (status) => {
      expect(isKnownUnacceptedProviderError(providerError(status))).toBe(true);
    },
  );

  test.each([408, 499, 500, 503, 529])("keeps ambiguous %i outcomes conservative", (status) => {
    expect(isKnownUnacceptedProviderError(providerError(status))).toBe(false);
  });

  test("keeps transport failures conservative", () => {
    expect(isKnownUnacceptedProviderError(new TypeError("network reset"))).toBe(false);
  });

  test("follows context-adding causes without treating a wrapped 5xx as free", () => {
    expect(
      isKnownUnacceptedProviderError(
        new Error("shared turn failed", { cause: providerError(422) }),
      ),
    ).toBe(true);
    expect(
      isKnownUnacceptedProviderError(
        new Error("shared turn failed", { cause: providerError(503) }),
      ),
    ).toBe(false);
  });

  test("rejects cyclic cause chains without looping", () => {
    const error = new Error("cycle") as Error & { cause?: unknown };
    error.cause = error;
    expect(isKnownUnacceptedProviderError(error)).toBe(false);
  });

  test("distinguishes local configuration from ambiguous gateway failures", () => {
    const configuration = new Error("missing key");
    configuration.name = "ProviderConfigurationError";
    expect(
      isKnownPreDispatchProviderConfigurationError(
        new Error("turn failed", { cause: configuration }),
      ),
    ).toBe(true);

    const gatewayTimeout = new Error("gateway timed out");
    gatewayTimeout.name = "GatewayTimeoutError";
    expect(
      isKnownPreDispatchProviderConfigurationError(
        new Error("turn failed", { cause: gatewayTimeout }),
      ),
    ).toBe(false);
  });
});
