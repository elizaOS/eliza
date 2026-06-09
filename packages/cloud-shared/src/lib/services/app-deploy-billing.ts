/**
 * App deploy upfront billing — debits CONTAINER_PRICING.DEPLOYMENT when a
 * deploy is queued.
 */

import {
  creditTransactionsRepository,
  organizationsRepository,
} from "../../db/repositories";
import { ApiError } from "../api/cloud-worker-errors";
import {
  APP_DEPLOY_UPFRONT_CHARGE_USD,
  deployCreditIdempotencyKey,
} from "./app-deployments-helpers";
import { creditsService } from "./credits";

export interface DeductDeployCreditsParams {
  organizationId: string;
  userId: string;
  appId: string;
  deploymentId: string;
}

export interface DeductDeployCreditsResult {
  deducted: boolean;
  newBalance: number;
}

/**
 * Debit the one-time deploy fee for a stamped deployment. Idempotent per
 * `deploymentId` so a retried queue after a partial failure is not double-charged.
 */
export async function deductDeployCredits(
  params: DeductDeployCreditsParams,
): Promise<DeductDeployCreditsResult> {
  const idempotencyKey = deployCreditIdempotencyKey(params.deploymentId);

  const existing = await creditTransactionsRepository.findDebitByIdempotencyKey(
    params.organizationId,
    idempotencyKey,
  );
  if (existing) {
    const org = await organizationsRepository.findById(params.organizationId);
    return {
      deducted: false,
      newBalance: org ? Number(org.credit_balance) : 0,
    };
  }

  const result = await creditsService.deductCredits({
    organizationId: params.organizationId,
    amount: APP_DEPLOY_UPFRONT_CHARGE_USD,
    description: `App deployment: ${params.appId}`,
    metadata: {
      type: "app_deploy",
      appId: params.appId,
      deploymentId: params.deploymentId,
      idempotencyKey,
      userId: params.userId,
    },
  });

  if (!result.success) {
    const deficit = Math.max(APP_DEPLOY_UPFRONT_CHARGE_USD - result.newBalance, 0.01);
    throw new ApiError(
      402,
      "insufficient_credits",
      `Insufficient credits to deploy. Required: $${APP_DEPLOY_UPFRONT_CHARGE_USD.toFixed(2)}, ` +
        `available: $${result.newBalance.toFixed(2)}. Add at least $${deficit.toFixed(2)} at /dashboard/billing.`,
    );
  }

  return {
    deducted: true,
    newBalance: result.newBalance,
  };
}
