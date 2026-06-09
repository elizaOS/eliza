import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "../../api/cloud-worker-errors";
import { APP_DEPLOY_UPFRONT_CHARGE_USD } from "../app-deployments-helpers";

const findDebitByIdempotencyKey = mock();
const findOrgById = mock();
const deductCredits = mock();

mock.module("../../../db/repositories", () => ({
  creditTransactionsRepository: {
    findDebitByIdempotencyKey,
  },
  organizationsRepository: {
    findById: findOrgById,
  },
}));

mock.module("../credits", () => ({
  creditsService: {
    deductCredits,
  },
}));

const { deductDeployCredits } = await import("../app-deploy-billing");

describe("deductDeployCredits", () => {
  const params = {
    organizationId: "org_1",
    userId: "user_1",
    appId: "app_1",
    deploymentId: "app_1:2026-05-19T15:00:00.000Z",
  };

  beforeEach(() => {
    findDebitByIdempotencyKey.mockReset();
    findOrgById.mockReset();
    deductCredits.mockReset();
    findDebitByIdempotencyKey.mockResolvedValue(undefined);
    findOrgById.mockResolvedValue({ credit_balance: "4.50" });
    deductCredits.mockResolvedValue({
      success: true,
      newBalance: 4.5,
      transaction: { id: "tx_1" },
    });
  });

  test("debits the deploy fee when no prior charge exists", async () => {
    const result = await deductDeployCredits(params);

    expect(result).toEqual({ deducted: true, newBalance: 4.5 });
    expect(deductCredits).toHaveBeenCalledWith({
      organizationId: "org_1",
      amount: APP_DEPLOY_UPFRONT_CHARGE_USD,
      description: "App deployment: app_1",
      metadata: {
        type: "app_deploy",
        appId: "app_1",
        deploymentId: params.deploymentId,
        idempotencyKey: `app_deploy:${params.deploymentId}`,
        userId: "user_1",
      },
    });
  });

  test("skips a second debit for the same deployment id", async () => {
    findDebitByIdempotencyKey.mockResolvedValue({ id: "tx_existing" });

    const result = await deductDeployCredits(params);

    expect(result).toEqual({ deducted: false, newBalance: 4.5 });
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("throws ApiError(402) when the atomic deduct fails", async () => {
    deductCredits.mockResolvedValue({
      success: false,
      newBalance: 0.1,
      transaction: null,
    });

    await expect(deductDeployCredits(params)).rejects.toBeInstanceOf(ApiError);
    try {
      await deductDeployCredits(params);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(402);
      expect((error as ApiError).code).toBe("insufficient_credits");
    }
  });
});
