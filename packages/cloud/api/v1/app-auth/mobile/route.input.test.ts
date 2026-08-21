/** Ensures malformed native App Auth bodies fail as stable caller errors before side effects. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const acknowledgeMobileAppAuthCredential = mock();
const exchangeMobileAppAuthCode = mock();
const requireRegisteredMobileApp = mock();
const logger = {
  error: mock(() => undefined),
  warn: mock(() => undefined),
};

const mobileService = await import("@/lib/services/mobile-app-auth");
const rateLimitActual = await import(
  "@/lib/middleware/rate-limit-hono-cloudflare"
);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) => {
    await next();
  },
}));
mock.module("@/lib/services/mobile-app-auth", () => ({
  ...mobileService,
  acknowledgeMobileAppAuthCredential,
  exchangeMobileAppAuthCode,
}));
mock.module("./_registration", () => ({ requireRegisteredMobileApp }));
mock.module("@/lib/utils/logger", () => ({ logger }));

const tokenRoute = (await import("./token/route")).default;
const ackRoute = (await import("./ack/route")).default;

beforeEach(() => {
  acknowledgeMobileAppAuthCredential.mockClear();
  exchangeMobileAppAuthCode.mockClear();
  requireRegisteredMobileApp.mockClear();
  logger.error.mockClear();
  logger.warn.mockClear();
});

async function malformedRequest(route: typeof tokenRoute): Promise<Response> {
  return await route.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
}

describe("mobile App Auth malformed JSON", () => {
  test.each([
    ["token", tokenRoute, exchangeMobileAppAuthCode],
    ["acknowledgement", ackRoute, acknowledgeMobileAppAuthCredential],
  ] as const)(
    "%s returns invalid_request without registration or service work",
    async (_, route, service) => {
      const response = await malformedRequest(route);
      expect(response.status).toBe(400);
      expect((await response.json()) as Record<string, unknown>).toEqual({
        success: false,
        error: "invalid_request",
        errorDescription:
          route === tokenRoute
            ? "Invalid mobile authorization token request"
            : "Invalid mobile credential acknowledgement",
        retryable: false,
      });
      expect(requireRegisteredMobileApp).not.toHaveBeenCalled();
      expect(service).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    },
  );
});
