/** Verifies gateway token response validation and bounded, jittered renewal timing. */

import { describe, expect, test } from "bun:test";
import {
  gatewayTokenRefreshDelayMs,
  gatewayTokenRetryDelayMs,
  parseGatewayTokenResponse,
} from "../src/gateway-auth";

describe("gateway auth contract", () => {
  test("accepts the bounded bearer response", () => {
    expect(
      parseGatewayTokenResponse({
        access_token: "signed-token",
        token_type: "Bearer",
        expires_in: 60,
      }),
    ).toEqual({
      access_token: "signed-token",
      token_type: "Bearer",
      expires_in: 60,
    });
  });

  test.each([
    null,
    {},
    { access_token: "", token_type: "Bearer", expires_in: 60 },
    { access_token: " token ", token_type: "Bearer", expires_in: 60 },
    { access_token: "token", token_type: "NotBearer", expires_in: 60 },
    { access_token: "token", token_type: "Bearer", expires_in: 0 },
    { access_token: "token", token_type: "Bearer", expires_in: -1 },
    { access_token: "token", token_type: "Bearer", expires_in: 61 },
    { access_token: "token", token_type: "Bearer", expires_in: Number.NaN },
  ])("rejects malformed response %#", (value) => {
    expect(() => parseGatewayTokenResponse(value)).toThrow(
      "Invalid gateway token response",
    );
  });

  test("refreshes halfway through a lease", () => {
    expect(gatewayTokenRefreshDelayMs(60)).toBe(30_000);
  });

  test("caps exponential retries and applies equal jitter", () => {
    expect(gatewayTokenRetryDelayMs(0, () => 0)).toBe(500);
    expect(gatewayTokenRetryDelayMs(0, () => 1)).toBe(1_000);
    expect(gatewayTokenRetryDelayMs(20, () => 0)).toBe(4_000);
    expect(gatewayTokenRetryDelayMs(20, () => 1)).toBe(8_000);
  });
});
