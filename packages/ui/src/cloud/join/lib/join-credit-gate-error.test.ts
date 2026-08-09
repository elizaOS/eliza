/**
 * Unit coverage for the /join credit-gate (402) classifier. Deterministic error
 * fixtures for both client transport shapes (ApiError-like and the direct-cloud
 * request error carrying the parsed body on `data`), no network.
 */
import { describe, expect, test } from "vitest";
import { ApiError } from "../../../api/client-types-core";
import { describeJoinCreditGateError } from "./join-credit-gate-error";

const WITHHELD_MESSAGE =
  "Welcome credit unavailable because this network reached the daily free-credit limit. Add funds to start an agent.";

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

describe("describeJoinCreditGateError", () => {
  test("classifies the direct-cloud 402 with a withheld welcome bonus", () => {
    const error = directCloudError(402, {
      success: false,
      code: "insufficient_credits",
      error: WITHHELD_MESSAGE,
      requiredBalance: 0.1,
      currentBalance: 0,
      welcomeBonusWithheld: true,
      welcomeBonusWithheldReason: "ip_daily_cap",
    });

    expect(describeJoinCreditGateError(error)).toEqual({
      message: WITHHELD_MESSAGE,
      welcomeBonusWithheld: true,
    });
  });

  test("classifies a plain drained-org 402 without the withheld flag", () => {
    const error = directCloudError(402, {
      success: false,
      code: "insufficient_credits",
      error: "Insufficient credits. Please add funds at /dashboard/billing.",
      requiredBalance: 0.1,
      currentBalance: 0,
    });

    expect(describeJoinCreditGateError(error)).toEqual({
      message: "Insufficient credits. Please add funds at /dashboard/billing.",
      welcomeBonusWithheld: false,
    });
  });

  test("classifies an ApiError by status even without a body payload", () => {
    const error = new ApiError({
      kind: "http",
      path: "/api/v1/eliza/agents",
      status: 402,
      code: "insufficient_credits",
      message: WITHHELD_MESSAGE,
    });

    expect(describeJoinCreditGateError(error)).toEqual({
      message: WITHHELD_MESSAGE,
      welcomeBonusWithheld: false,
    });
  });

  test("reads the withheld flag from an ApiError carrying the parsed 402 body", () => {
    const error = new ApiError({
      kind: "http",
      path: "/api/cloud/compat/agents",
      status: 402,
      code: "insufficient_credits",
      message: WITHHELD_MESSAGE,
      data: {
        success: false,
        code: "insufficient_credits",
        error: WITHHELD_MESSAGE,
        welcomeBonusWithheld: true,
        welcomeBonusWithheldReason: "ip_daily_cap",
      },
    });

    expect(describeJoinCreditGateError(error)).toEqual({
      message: WITHHELD_MESSAGE,
      welcomeBonusWithheld: true,
    });
  });

  test("walks the cause chain of a wrapped selection error", () => {
    const wrapped = new Error("Failed to create cloud agent", {
      cause: directCloudError(402, {
        success: false,
        code: "insufficient_credits",
        error: WITHHELD_MESSAGE,
        welcomeBonusWithheld: true,
      }),
    });

    expect(describeJoinCreditGateError(wrapped)).toEqual({
      message: WITHHELD_MESSAGE,
      welcomeBonusWithheld: true,
    });
  });

  test("returns null for every non-credit-gate failure shape", () => {
    expect(describeJoinCreditGateError(new Error("network down"))).toBeNull();
    expect(describeJoinCreditGateError(null)).toBeNull();
    expect(describeJoinCreditGateError(undefined)).toBeNull();
    expect(
      describeJoinCreditGateError(
        directCloudError(404, { error: "Agent not found" }),
      ),
    ).toBeNull();
    expect(
      describeJoinCreditGateError(
        new ApiError({
          kind: "http",
          path: "/api/v1/eliza/agents",
          status: 500,
          message: "Failed to start provisioning",
        }),
      ),
    ).toBeNull();
  });

  test("falls back to the transport message when the body has no error string", () => {
    const error = Object.assign(new Error("Cloud request failed (402)"), {
      status: 402,
      data: { success: false, code: "insufficient_credits" },
    });
    expect(describeJoinCreditGateError(error)).toEqual({
      message: "Cloud request failed (402)",
      welcomeBonusWithheld: false,
    });
  });
});
