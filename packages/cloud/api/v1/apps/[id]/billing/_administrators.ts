/** Routes purchaser-authenticated administrator changes through the account membership authority. */
import { z } from "zod";
import {
  changeAppBillingAdministratorInput,
  genericBillingAdministratorsService,
} from "@/lib/services/generic-billing-administrators";
import type { AppContext } from "@/types/cloud-worker-env";
import { buyerBillingActor } from "./_handlers";

async function identity(c: AppContext, mutation = false) {
  const actor = await buyerBillingActor(c, mutation);
  return {
    ...actor,
    billingAccountId: z.string().uuid().parse(c.req.param("accountId")),
  };
}
export async function getBillingAdministrators(c: AppContext) {
  return c.json({
    success: true,
    data: await genericBillingAdministratorsService.snapshot(await identity(c)),
  });
}
export async function changeBillingAdministrator(c: AppContext) {
  const actor = await identity(c, true);
  const input = changeAppBillingAdministratorInput.parse(await c.req.json());
  return c.json({
    success: true,
    data: await genericBillingAdministratorsService.change(actor, input),
  });
}
