/**
 * Owns paid-provider admission and durable post-dispatch settlement for shared
 * cloud services that run outside an inference route handler.
 */

import { logger } from "../utils/logger";
import type { PricingBillingSource } from "./ai-pricing-definitions";
import type { InferenceAdmissionSnapshot } from "./inference-auth-cache";
import { admitOrganizationInference } from "./organization-inference-admission";

export interface GenerativeOperationContext {
  organizationId: string;
  userId: string;
  apiKeyId: string | null;
  requestId: string;
  admissionSnapshot?: InferenceAdmissionSnapshot;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

export interface FlatProviderOperation {
  provider: string;
  billingSource: PricingBillingSource;
  model: string;
  operation: string;
  cost: number;
  metadata?: Record<string, unknown>;
}

const admissionErrors = new WeakSet<object>();

export function isGenerativeOperationAdmissionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && admissionErrors.has(error);
}

function observeBackgroundTask(
  task: Promise<unknown>,
  context: GenerativeOperationContext,
  operation: FlatProviderOperation,
): Promise<void> {
  return task.then(
    () => undefined,
    (error) => {
      logger.error("[GenerativeOperation] background task failed", {
        organizationId: context.organizationId,
        requestId: context.requestId,
        provider: operation.provider,
        model: operation.model,
        operation: operation.operation,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

export async function retainGenerativeTask(
  context: GenerativeOperationContext,
  operation: FlatProviderOperation,
  task: Promise<unknown>,
): Promise<void> {
  const observed = observeBackgroundTask(task, context, operation);
  if (context.executionCtx) {
    context.executionCtx.waitUntil(observed);
    return;
  }
  await observed;
}

/** Admits one priced operation and marks its lease immediately before dispatch. */
export async function runFlatProviderOperation<T>(
  context: GenerativeOperationContext,
  operation: FlatProviderOperation,
  dispatch: () => Promise<T>,
): Promise<T> {
  let admission;
  try {
    admission = await admitOrganizationInference({
      context: {
        organizationId: context.organizationId,
        userId: context.userId,
        apiKeyId: context.apiKeyId,
        requestId: `${context.requestId}:${operation.operation}:${crypto.randomUUID()}`,
        provider: operation.provider,
        billingSource: operation.billingSource,
        model: operation.model,
        description: operation.operation,
        metadata: operation.metadata,
      },
      apiKeyId: context.apiKeyId,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      flatCost: {
        totalCost: operation.cost,
        baseTotalCost: operation.cost,
        platformMarkup: 0,
      },
      admissionSnapshot: context.admissionSnapshot,
      executionCtx: context.executionCtx,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null) admissionErrors.add(error);
    throw error;
  }

  let marked = false;
  try {
    await admission.markProviderDispatched?.();
    marked = true;
    const value = await dispatch();
    await retainGenerativeTask(context, operation, admission.settle(operation.cost));
    return value;
  } catch (error) {
    if (marked) {
      await retainGenerativeTask(context, operation, admission.settleUnknown());
    }
    logger.error("[GenerativeOperation] provider operation failed", {
      organizationId: context.organizationId,
      requestId: context.requestId,
      provider: operation.provider,
      model: operation.model,
      operation: operation.operation,
      providerDispatched: marked,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
