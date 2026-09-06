/** Translates owner session and strict HTTP requests into generic merchant and catalog administration. */
import { ElizaError } from "@elizaos/core";
import type { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { checkCookieMutationGuard } from "@/lib/auth/cookie-mutation-guard";
import { requireCurrentBillingManagerSession } from "@/lib/auth/workers-hono-auth";
import {
  type GenericBillingAdminService,
  genericBillingAdminService,
} from "@/lib/services/generic-billing-admin";
import {
  adoptAppBillingPlanSchema,
  appBillingMerchantRequestSchema,
  appBillingPlanRevisionRequestSchema,
  appBillingRefundRequestSchema,
  createAppBillingPlanSchema,
  disconnectAppBillingMerchantSchema,
  registerAppBillingMerchantSchema,
} from "@/lib/services/generic-billing-admin-requests";
import {
  appBillingPaidPeriodsRequestSchema,
  appBillingRefundPreviewRequestSchema,
} from "@/lib/services/generic-billing-refund-read";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

export function appBillingAdministrationBoundary(app: Hono<AppEnv>) {
  app.onError((error, c) => {
    // error-policy:J1 translate administration authorization, conflict and input failures at the HTTP boundary.
    if (
      error instanceof ElizaError &&
      error.code.startsWith("APP_BILLING_ADMIN_")
    )
      return c.json(
        { success: false, error: error.message, code: error.code },
        error.code.endsWith("FORBIDDEN") ? 403 : 409,
      );
    return failureResponse(c, error);
  });
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    const guard = checkCookieMutationGuard(
      c.req,
      c.env.ENVIRONMENT,
      c.env.NODE_ENV === "production",
    );
    if (!guard.ok)
      return c.json(
        { success: false, error: "Forbidden", code: guard.code },
        403,
      );
    await next();
  });
}
export function createAppBillingAdminHandlers(
  service: GenericBillingAdminService = genericBillingAdminService,
) {
  async function owner(c: AppContext) {
    const user = await requireCurrentBillingManagerSession(c);
    return {
      appId: z.string().uuid().parse(c.req.param("id")),
      userId: user.id,
      organizationId: user.organization_id,
    };
  }
  return {
    overview: async (c: AppContext) =>
      c.json({ success: true, data: await service.overview(await owner(c)) }),
    registerMerchant: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.registerMerchant(
          await owner(c),
          registerAppBillingMerchantSchema.parse(await c.req.json()),
        ),
      }),
    onboardMerchant: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.onboardMerchant(
          await owner(c),
          appBillingMerchantRequestSchema.parse(await c.req.json()),
        ),
      }),
    refreshMerchant: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.refreshMerchant(
          await owner(c),
          appBillingMerchantRequestSchema.parse(await c.req.json()),
        ),
      }),
    disconnectMerchant: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.disconnectMerchant(
          await owner(c),
          disconnectAppBillingMerchantSchema.parse(await c.req.json()),
        ),
      }),
    paidPeriods: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.paidPeriods(
          await owner(c),
          appBillingPaidPeriodsRequestSchema.parse(c.req.query()),
        ),
      }),
    previewRefund: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.previewRefund(
          await owner(c),
          appBillingRefundPreviewRequestSchema.parse(await c.req.json()),
        ),
      }),
    refund: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.refund(
          await owner(c),
          appBillingRefundRequestSchema.parse(await c.req.json()),
        ),
      }),
    createPlan: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.createPlan(
          await owner(c),
          createAppBillingPlanSchema.parse(await c.req.json()),
        ),
      }),
    adoptPlan: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.createPlan(
          await owner(c),
          adoptAppBillingPlanSchema.parse(await c.req.json()),
        ),
      }),
    verifyPlan: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.verifyPlan(
          await owner(c),
          appBillingPlanRevisionRequestSchema.parse(await c.req.json()),
        ),
      }),
    publishPlan: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.verifyPlan(
          await owner(c),
          appBillingPlanRevisionRequestSchema.parse(await c.req.json()),
          true,
        ),
      }),
    retirePlan: async (c: AppContext) =>
      c.json({
        success: true,
        data: await service.retirePlan(
          await owner(c),
          appBillingPlanRevisionRequestSchema.parse(await c.req.json()),
        ),
      }),
    recoverOperation: async (c: AppContext) => {
      const actor = await owner(c);
      z.object({})
        .strict()
        .parse(await c.req.json());
      return c.json({
        success: true,
        data: await service.recoverOperation(
          actor,
          z.string().uuid().parse(c.req.param("commandId")),
        ),
      });
    },
  };
}
export const appBillingAdminHandlers = createAppBillingAdminHandlers();
