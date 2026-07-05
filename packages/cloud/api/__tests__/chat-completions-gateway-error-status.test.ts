/**
 * Gateway caller-fault classification for POST /api/v1/chat/completions.
 * The route receives some Vercel AI Gateway failures as plain Error objects,
 * so the boundary must preserve their HTTP status from stable names/fields
 * rather than relying on SDK-local instance markers.
 */

import { describe, expect, test } from "bun:test";
import { __streamingCreditTestHooks } from "../v1/chat/completions/route";

const { getRecoverableProviderErrorStatus } = __streamingCreditTestHooks;

function gatewayError(name: string, statusCode?: number) {
  return Object.assign(new Error(`${name} from gateway`), {
    name,
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

describe("chat/completions gateway error status classification", () => {
  test.each([
    ["GatewayInvalidRequestError", 400],
    ["GatewayModelNotFoundError", 404],
    ["GatewayRateLimitError", 429],
  ] as const)("%s maps to %i", (name, status) => {
    expect(getRecoverableProviderErrorStatus(gatewayError(name))).toBe(status);
  });

  test.each([
    400, 404, 429,
  ] as const)("plain gateway error preserves statusCode %i", (status) => {
    expect(
      getRecoverableProviderErrorStatus(gatewayError("GatewayError", status)),
    ).toBe(status);
  });

  test("gateway infrastructure failures still fall through to provider-configuration handling", () => {
    expect(
      getRecoverableProviderErrorStatus(
        gatewayError("GatewayResponseError", 500),
      ),
    ).toBeNull();
  });
});
