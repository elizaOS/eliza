/**
 * Unit coverage for the domain-neutral insufficient-credits (402) classifier.
 * Deterministic error fixtures for both client transport shapes (ApiError-like
 * and the direct-cloud request error carrying the parsed body on `data`), no
 * network. The /join welcome-bonus reading layered on top is covered by
 * `cloud/join/lib/join-credit-gate-error.test.ts`.
 */
import { describe, expect, test } from "vitest";
import { ApiError } from "./client-types-core";
import { describeCreditGateError } from "./credit-gate-error";

const GATE_MESSAGE =
  "Insufficient credits. Please add funds at /dashboard/billing.";

/** The direct-cloud request error shape: message + status + parsed JSON body. */
function directCloudError(
  status: number,
  body: Record<string, unknown>,
): Error {
  return Object.assign(
    new Error(`Cloud request failed (${status}): ${String(body.error ?? "")}`),
    {
      status,
      data: body,
      url: "https://api.elizacloud.ai/api/v1/eliza/agents",
    },
  );
}

describe("describeCreditGateError", () => {
  test("classifies the direct-cloud 402 and returns the parsed body", () => {
    const body = {
      success: false,
      code: "insufficient_credits",
      error: GATE_MESSAGE,
      requiredBalance: 0.1,
      currentBalance: 0,
    };
    expect(describeCreditGateError(directCloudError(402, body))).toEqual({
      message: GATE_MESSAGE,
      body,
    });
  });

  test("classifies an ApiError by status+code even without a body payload", () => {
    const error = new ApiError({
      kind: "http",
      path: "/api/messages",
      status: 402,
      code: "insufficient_credits",
      message: GATE_MESSAGE,
    });
    expect(describeCreditGateError(error)).toEqual({
      message: GATE_MESSAGE,
      body: null,
    });
  });

  test("walks the cause chain of a wrapped error", () => {
    const wrapped = new Error("send failed", {
      cause: directCloudError(402, {
        code: "insufficient_credits",
        error: GATE_MESSAGE,
      }),
    });
    expect(describeCreditGateError(wrapped)?.message).toBe(GATE_MESSAGE);
  });

  test("falls back to the transport message when the body has no error string", () => {
    const error = Object.assign(new Error("Cloud request failed (402)"), {
      status: 402,
      data: { success: false, code: "insufficient_credits" },
    });
    expect(describeCreditGateError(error)?.message).toBe(
      "Cloud request failed (402)",
    );
  });

  test("stays fail-closed for every non-gate shape", () => {
    expect(describeCreditGateError(new Error("network down"))).toBeNull();
    expect(describeCreditGateError(null)).toBeNull();
    expect(describeCreditGateError(undefined)).toBeNull();
    expect(
      describeCreditGateError(
        directCloudError(402, { code: "payment_required", error: "Pay" }),
      ),
    ).toBeNull();
    expect(
      describeCreditGateError(
        directCloudError(500, {
          code: "insufficient_credits",
          error: "wrong status",
        }),
      ),
    ).toBeNull();
    expect(
      describeCreditGateError(
        new ApiError({
          kind: "http",
          path: "/api/messages",
          status: 500,
          message: "boom",
        }),
      ),
    ).toBeNull();
  });
});
