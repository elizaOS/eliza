/** Converts durable app commands into recoverable buyer actions without exposing provider ownership identifiers. */
import type { AppBillingOperation } from "@elizaos/cloud-sdk/app-billing";
import {
  appBillingConflict,
  type ScopedBillingContext,
} from "../../db/repositories/app-subscription-authority";
import type { BillingSubscriptionCommand } from "../../db/schemas/subscription-billing-operations";

export function appBillingOperationDto(
  scope: ScopedBillingContext,
  command: BillingSubscriptionCommand,
): AppBillingOperation {
  if (
    command.billing_scope_id !== scope.scopeId ||
    command.app_id !== scope.appId ||
    command.livemode !== scope.livemode
  )
    appBillingConflict("App operation does not belong to the requested billing environment");
  const identity = {
    id: command.id,
    appId: scope.appId,
    billingAccountId: scope.billingAccountId,
    productFamilyKey: scope.productFamilyKey,
    environment: scope.livemode ? ("live" as const) : ("test" as const),
  };
  if (command.status === "APPLIED")
    return {
      ...identity,
      status: "succeeded",
      subscriptionRevision:
        command.provider_result?.kind === "completed" &&
        command.provider_result.subscriptionRevision !== null
          ? String(command.provider_result.subscriptionRevision)
          : null,
    };
  if (command.status === "FAILED" || command.status === "SUPERSEDED")
    return {
      ...identity,
      status: "failed",
      error: {
        code: command.error_code ?? "APP_BILLING_OPERATION_FAILED",
        message:
          command.error_code === "APP_BILLING_PAYMENT_EXPIRED"
            ? "Payment expired without applying the change. Your previous plan and seats remain in place; review a new quote to try again."
            : "The subscription change did not complete. Refresh billing before starting another change.",
        retryable: false,
      },
    };
  const result = command.provider_result;
  if (result?.kind === "checkout" && result.resume?.invoicePaid)
    return { ...identity, status: "pending", retryAfterSeconds: 3 };
  if (command.status === "SUCCEEDED" && result) {
    if (result.kind === "checkout" && result.resume) {
      if (result.resume.action)
        return {
          ...identity,
          status: "requires_action",
          action: {
            kind: "payment",
            url: result.resume.action.url,
            expiresAt: result.resume.action.expiresAt,
          },
        };
      return { ...identity, status: "outcome_unknown", retryAfterSeconds: 3 };
    }
    if (
      (result.kind === "checkout" || result.kind === "portal" || result.kind === "payment") &&
      result.url !== null
    )
      return {
        ...identity,
        status: "requires_action",
        action: { kind: result.kind, url: result.url, expiresAt: result.expiresAt },
      };
    if (result.kind === "completed" || result.kind === "expired_checkout")
      return {
        ...identity,
        status: "succeeded",
        subscriptionRevision:
          result.kind === "completed" && result.subscriptionRevision !== null
            ? String(result.subscriptionRevision)
            : null,
      };
  }
  return {
    ...identity,
    status: command.status === "PREPARED" ? "pending" : "outcome_unknown",
    retryAfterSeconds: 3,
  };
}
