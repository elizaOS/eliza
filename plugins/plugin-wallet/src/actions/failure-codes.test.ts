/**
 * Contract coverage for wallet action failure codes. Planner-visible codes
 * must stay classified by phase so callers can distinguish validation,
 * approval, idempotency, venue, credential, transport, and execution failures.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => {
  return await import("../__tests__/core-vitest-mock.js");
});

import { StewardTradingService } from "../services/steward-trading-service.js";
import {
  type ActionFailureCode,
  isActionFailureCode,
  isValidateFailureCode,
  type ValidateFailureCode,
} from "./failure-codes.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("wallet action failure codes", () => {
  it("classifies actionable validation failures and rejects execution-only codes", () => {
    const validateCodes: ValidateFailureCode[] = [
      "INVALID_PARAMS",
      "PLUGIN_DISABLED",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_AUTH_MISSING",
      "WALLET_NOT_AVAILABLE",
      "VENUE_NOT_SUPPORTED_ON_BACKEND",
      "VENUE_NOT_SUPPORTED_FOR_KIND",
      "POLICY_REQUIRES_APPROVAL",
      "POLICY_BLOCKED",
      "INSUFFICIENT_BALANCE",
      "MARKET_CLOSED",
      "INSTRUMENT_NOT_FOUND",
      "LEVERAGE_OUT_OF_RANGE",
      "SLIPPAGE_EXCEEDED",
      "WITHDRAWAL_NOT_ALLOWLISTED",
      "VENUE_GEO_RESTRICTED",
      "SESSION_REQUIRED",
      "IDEMPOTENCY_CONFLICT",
      "RATE_LIMITED",
      "INVALID_ADDRESS",
      "TOKEN_NOT_SUPPORTED",
      "POOL_NOT_FOUND",
      "RANGE_OUT_OF_BOUNDS",
    ];

    for (const code of validateCodes) {
      expect(isValidateFailureCode(code)).toBe(true);
      expect(isActionFailureCode(code)).toBe(false);
    }
    expect(isValidateFailureCode("SIGNATURE_REJECTED")).toBe(false);
    expect(isValidateFailureCode("NOT_A_WALLET_FAILURE")).toBe(false);
  });

  it("classifies execution failures and rejects validation-only codes", () => {
    const actionCodes: ActionFailureCode[] = [
      "PROVIDER_REJECTED",
      "SIGNATURE_REJECTED",
      "STEWARD_UNAVAILABLE",
      "ROUTE_NOT_FOUND",
      "TRANSACTION_REVERTED",
      "TIMEOUT",
    ];

    for (const code of actionCodes) {
      expect(isActionFailureCode(code)).toBe(true);
      expect(isValidateFailureCode(code)).toBe(false);
    }
    expect(isActionFailureCode("POLICY_BLOCKED")).toBe(false);
    expect(isActionFailureCode("NOT_A_WALLET_FAILURE")).toBe(false);
  });

  it("maps Steward trading guard failures onto planner-visible code classes", async () => {
    const settings: Record<string, string> = {
      STEWARD_API_URL: "https://steward.local",
      STEWARD_AGENT_ID: "agent-fixture",
      STEWARD_AGENT_TOKEN: "token-fixture",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(400, {
          ok: false,
          code: "policy-violation",
          reason: "daily cap exceeded",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          ok: false,
          error: "idempotency key reused with a different order",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(503, {
          ok: false,
          error: "transient upstream failure",
        }),
      );
    const service = new StewardTradingService(
      {
        getSetting: (key: string) => settings[key],
      } as never,
      {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => undefined,
        maxRetries: 1,
      },
    );

    const baseOrder = {
      venue: "hyperliquid" as const,
      sessionId: "session-fixture",
      coin: "BTC",
      side: "buy" as const,
      size: 0.01,
      idempotencyKey: "idempotency-fixture",
    };
    const policyDenied = await service.submitOrder(baseOrder);
    const idempotencyConflict = await service.submitOrder(baseOrder);
    const submissionUnknown = await service.submitOrder(baseOrder);

    expect(policyDenied).toMatchObject({
      ok: false,
      outcome: "policy_denied",
      error: "POLICY_BLOCKED",
      policy: { reason: "daily-cap-exceeded" },
    });
    expect(
      isValidateFailureCode(policyDenied.ok ? "" : policyDenied.error),
    ).toBe(true);
    expect(idempotencyConflict).toMatchObject({
      ok: false,
      outcome: "not_attempted",
      error: "IDEMPOTENCY_CONFLICT",
    });
    expect(
      isValidateFailureCode(
        idempotencyConflict.ok ? "" : idempotencyConflict.error,
      ),
    ).toBe(true);
    expect(submissionUnknown).toMatchObject({
      ok: false,
      outcome: "unknown",
      error: "TIMEOUT",
      retryable: false,
    });
    expect(
      isActionFailureCode(submissionUnknown.ok ? "" : submissionUnknown.error),
    ).toBe(true);
  });
});
