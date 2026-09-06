/** Translates generic buyer billing HTTP requests into scoped identity and billing use-cases. */
import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import { z } from "zod";
import { appBillingCommandRuntimeRepository } from "@/db/repositories/app-billing-command-runtime";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAppBillingActor } from "@/lib/auth/app-delegation-auth";
import { checkCookieMutationGuard } from "@/lib/auth/cookie-mutation-guard";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { AppDelegationError } from "@/lib/services/app-delegation";
import { appDelegationService } from "@/lib/services/app-delegation-adapter";
import {
  appBillingCommandInput,
  appBillingScopeInput,
  cancelAppBillingSubscriptionInput,
  createAppBillingCheckoutInput,
  expireAppBillingCheckoutInput,
  quoteAppBillingUpdateInput,
  resolveAppBillingAccountInput,
  startAppBillingTrialInput,
  updateAppBillingSubscriptionInput,
} from "@/lib/services/generic-billing-input";
import { genericBillingReadService } from "@/lib/services/generic-billing-read";
import {
  type BuyerBillingIdentity,
  genericBillingRuntime,
} from "@/lib/services/generic-billing-runtime";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

function nativeBillingEnvironment(): "test" | "live" {
  const value = getCloudAwareEnv().APP_BILLING_ENVIRONMENT;
  if (value !== "test" && value !== "live")
    throw new AppDelegationError(
      503,
      "APP_BILLING_ENVIRONMENT_UNAVAILABLE",
      "Application billing is not configured for this environment",
    );
  return value;
}

export async function buyerBillingActor(c: AppContext, mutation = false) {
  const appId = z.string().uuid().parse(c.req.param("id"));
  const actor = await requireAppBillingActor(
    c,
    appId,
    mutation ? "billing:write" : "billing:read",
  );
  const selectedClientId = z
    .string()
    .uuid()
    .optional()
    .parse(c.req.query("clientId"));
  let billingEnvironment = actor.billingEnvironment;
  if (selectedClientId) {
    if (actor.clientId !== null && actor.clientId !== selectedClientId)
      throw new AppDelegationError(
        403,
        "APP_SCOPE_DENIED",
        "The selected client differs from the authenticated application client",
      );
    const registration =
      await appDelegationService.registration(selectedClientId);
    if (registration.appId !== appId)
      throw new AppDelegationError(
        403,
        "APP_SCOPE_DENIED",
        "The client is registered to another application",
      );
    billingEnvironment = registration.billingEnvironment;
  }
  if (mutation && actor.clientId === null) {
    const env = getCloudAwareEnv();
    const guard = checkCookieMutationGuard(
      c.req,
      env.ENVIRONMENT,
      env.ENVIRONMENT === "production",
    );
    if (!guard.ok)
      throw new AppDelegationError(
        403,
        guard.code,
        "Billing changes require a first-party browser request",
      );
  }
  return {
    ...actor,
    environment: billingEnvironment ?? nativeBillingEnvironment(),
  };
}

export function appBillingErrorResponse(error: Error, c: AppContext) {
  // error-policy:J1 expose typed authorization, validation and authority failures at HTTP boundary.
  if (error instanceof AppDelegationError)
    return c.json(
      { success: false, error: error.message, code: error.code },
      error.status,
    );
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json(
      {
        success: false,
        error: "Billing request validation failed",
        code: "APP_BILLING_INPUT_INVALID",
      },
      400,
    );
  if (
    error instanceof ElizaError &&
    (error.code === "APP_BILLING_AUTHORITY_CONFLICT" ||
      error.code === "APP_BILLING_MEMBERSHIP_REVISION_CONFLICT" ||
      error.code === "APP_BILLING_COMMAND_NOT_APPLIED")
  )
    return c.json(
      { success: false, error: error.message, code: error.code },
      409,
    );
  return failureResponse(c, error);
}

export function billingRoute() {
  const route = new Hono<AppEnv>();
  route.onError(appBillingErrorResponse);
  route.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  return route;
}

export async function getBillingCatalog(c: AppContext) {
  const appId = z.string().uuid().parse(c.req.param("id"));
  const clientId = z.string().uuid().optional().parse(c.req.query("clientId"));
  let environment: "test" | "live";
  if (clientId) {
    const registration = await appDelegationService.registration(clientId);
    if (registration.appId !== appId)
      throw new AppDelegationError(
        403,
        "APP_SCOPE_DENIED",
        "The client is registered to another application",
      );
    environment = registration.billingEnvironment;
  } else environment = nativeBillingEnvironment();
  return c.json({
    success: true,
    data: await genericBillingReadService.catalog(
      appId,
      environment === "live",
    ),
  });
}

export async function resolveBillingAccount(c: AppContext) {
  const actor = await buyerBillingActor(c, true);
  const input = resolveAppBillingAccountInput.parse(await c.req.json());
  return c.json({
    success: true,
    data: await genericBillingReadService.resolveAccount({
      ...input,
      appId: actor.appId,
      actorUserId: actor.userId,
      registeredClientId: actor.clientId,
    }),
  });
}

export async function getBillingSnapshot(c: AppContext) {
  const actor = await buyerBillingActor(c);
  const input = appBillingScopeInput.parse({
    appId: actor.appId,
    billingAccountId: c.req.param("accountId"),
    productFamilyKey: c.req.param("family"),
  });
  return c.json({
    success: true,
    data: await genericBillingReadService.snapshot({
      ...input,
      actorUserId: actor.userId,
      livemode: actor.environment === "live",
    }),
  });
}

async function mutationIdentity(c: AppContext): Promise<BuyerBillingIdentity> {
  const actor = await buyerBillingActor(c, true);
  const input = appBillingScopeInput.parse({
    appId: actor.appId,
    billingAccountId: c.req.param("accountId"),
    productFamilyKey: c.req.param("family"),
  });
  return {
    ...input,
    actorUserId: actor.userId,
    clientRegistrationId: actor.clientId,
    livemode: actor.environment === "live",
  };
}

export async function startBillingTrial(c: AppContext) {
  const identity = await mutationIdentity(c);
  const input = startAppBillingTrialInput.parse(await c.req.json());
  return c.json({
    success: true,
    data: await genericBillingRuntime.prepare(identity, {
      ...input,
      payload: {
        version: 1,
        domain: "buyer",
        action: "trial",
        planRevisionId: input.planRevisionId,
        quantity: input.quantity,
      },
    }),
  });
}

export async function createBillingCheckout(c: AppContext) {
  const identity = await mutationIdentity(c);
  const input = createAppBillingCheckoutInput.parse(await c.req.json());
  return c.json({
    success: true,
    data: await genericBillingRuntime.checkout(identity, input),
  });
}

export async function quoteBillingUpdate(c: AppContext) {
  const identity = await mutationIdentity(c);
  const input = quoteAppBillingUpdateInput.parse(await c.req.json());
  return c.json({
    success: true,
    data: await genericBillingRuntime.quote(identity, input),
  });
}

export async function updateBillingSubscription(c: AppContext) {
  const identity = await mutationIdentity(c);
  const input = updateAppBillingSubscriptionInput.parse(await c.req.json());
  return c.json({
    success: true,
    data: await genericBillingRuntime.prepare(identity, {
      ...input,
      payload: {
        version: 1,
        domain: "buyer",
        action: "update",
        planRevisionId: input.planRevisionId,
        quantity: input.quantity,
        quoteId: input.quoteId,
        billingConsent: input.billingConsent,
      },
    }),
  });
}

export async function cancelBillingSubscription(c: AppContext) {
  const identity = await mutationIdentity(c);
  const input = cancelAppBillingSubscriptionInput.parse(await c.req.json());
  return c.json({
    success: true,
    data: await genericBillingRuntime.prepare(identity, {
      ...input,
      payload: {
        version: 1,
        domain: "buyer",
        action: "cancel",
        timing: input.timing,
      },
    }),
  });
}

export async function createBillingPortal(c: AppContext) {
  const identity = await mutationIdentity(c);
  const input = appBillingCommandInput.parse(await c.req.json());
  return c.json({
    success: true,
    data: await genericBillingRuntime.portal(identity, input),
  });
}

export async function expireBillingCheckout(c: AppContext) {
  const identity = await mutationIdentity(c);
  const input = expireAppBillingCheckoutInput.parse(await c.req.json());
  return c.json({
    success: true,
    data: await genericBillingRuntime.prepare(identity, {
      ...input,
      payload: {
        version: 1,
        domain: "buyer",
        action: "expire_checkout",
        checkoutCommandId: input.operationId,
      },
    }),
  });
}

export async function getBillingOperation(c: AppContext) {
  const actor = await buyerBillingActor(c);
  const commandId = z.string().uuid().parse(c.req.param("operationId"));
  const accountId = z.string().uuid().parse(c.req.param("accountId"));
  const scopeId =
    await appBillingCommandRuntimeRepository.resolveOperationScope({
      appId: actor.appId,
      billingAccountId: accountId,
      actorUserId: actor.userId,
      commandId,
      livemode: actor.environment === "live",
    });
  // GET observes durable state. Provider reconciliation runs under a leased background command.
  const read = await appBillingCommandRuntimeRepository.read({
    scopeId,
    commandId,
    actorUserId: actor.userId,
  });
  const { appBillingOperationDto } = await import(
    "@/lib/services/generic-billing-operation"
  );
  return c.json({
    success: true,
    data: appBillingOperationDto(read.scope, read.command),
  });
}
