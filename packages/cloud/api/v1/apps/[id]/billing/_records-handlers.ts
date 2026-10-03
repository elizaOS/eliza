/** Translates buyer record requests into the canonical app actor and scoped records service. */
import { z } from "zod";
import type { AppBillingReadIdentity } from "@/db/repositories/app-billing-queries";
import {
  appBillingScopeInput,
  assignAppBillingSeatInput,
  revokeAppBillingSeatInput,
} from "@/lib/services/generic-billing-input";
import {
  type GenericBillingRecordsService,
  genericBillingRecordsService,
} from "@/lib/services/generic-billing-records";
import type { AppContext } from "@/types/cloud-worker-env";
import { buyerBillingActor } from "./_handlers";

async function recordsIdentity(
  c: AppContext,
  mutation = false,
): Promise<AppBillingReadIdentity> {
  const actor = await buyerBillingActor(c, mutation);
  return {
    ...appBillingScopeInput.parse({
      appId: actor.appId,
      billingAccountId: c.req.param("accountId"),
      productFamilyKey: c.req.param("family"),
    }),
    actorUserId: actor.userId,
    livemode: actor.environment === "live",
  };
}

export function createAppBillingRecordsHandlers(
  service: GenericBillingRecordsService = genericBillingRecordsService,
) {
  async function listBillingSeats(c: AppContext) {
    return c.json({
      success: true,
      data: await service.seats(
        await recordsIdentity(c),
        c.req.query("cursor"),
      ),
    });
  }

  async function assignBillingSeat(c: AppContext) {
    const identity = await recordsIdentity(c, true);
    const input = assignAppBillingSeatInput.parse(await c.req.json());
    return c.json({
      success: true,
      data: await service.assignSeat(identity, input),
    });
  }

  async function revokeBillingSeat(c: AppContext) {
    const identity = await recordsIdentity(c, true);
    const seatId = z.string().uuid().parse(c.req.param("seatId"));
    const input = revokeAppBillingSeatInput.parse(await c.req.json());
    return c.json({
      success: true,
      data: await service.revokeSeat(identity, { ...input, seatId }),
    });
  }

  async function listBillingInvoices(c: AppContext) {
    return c.json({
      success: true,
      data: await service.invoices(
        await recordsIdentity(c),
        c.req.query("cursor"),
      ),
    });
  }

  async function listBillingUsage(c: AppContext) {
    return c.json({
      success: true,
      data: await service.usage(
        await recordsIdentity(c),
        c.req.query("cursor"),
      ),
    });
  }

  return {
    listBillingSeats,
    assignBillingSeat,
    revokeBillingSeat,
    listBillingInvoices,
    listBillingUsage,
  };
}

export const {
  listBillingSeats,
  assignBillingSeat,
  revokeBillingSeat,
  listBillingInvoices,
  listBillingUsage,
} = createAppBillingRecordsHandlers();
