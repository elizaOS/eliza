/** Reuses Cloud's Stripe account while isolating Outreachr customers, prices, and subscriptions. */
import type Stripe from "stripe";
import { z } from "zod";
import { OutreachrDelegationError, type OutreachrRegistration } from "./outreachr-delegation";

const uuid = z.string().uuid();
const customerId = z.string().startsWith("cus_").max(100);
const attemptId = uuid;
const plan = z.enum(["sol", "astra"]);
const seats = z.number().int().min(1).max(1000);
export const outreachrBillingInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("customer"), workspaceId: uuid }).strict(),
  z
    .object({
      action: z.literal("checkout"),
      workspaceId: uuid,
      customerId,
      attemptId,
      plan,
      seats,
    })
    .strict(),
  z
    .object({
      action: z.literal("checkoutStatus"),
      workspaceId: uuid,
      customerId,
      sessionId: z.string().startsWith("cs_").max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("expireCheckout"),
      workspaceId: uuid,
      customerId,
      sessionId: z.string().startsWith("cs_").max(200),
    })
    .strict(),
  z.object({ action: z.literal("subscriptions"), workspaceId: uuid, customerId }).strict(),
  z
    .object({
      action: z.literal("portal"),
      workspaceId: uuid,
      customerId,
      attemptId,
      minimumSeats: seats,
      update: z
        .object({ subscriptionId: z.string().startsWith("sub_").max(100), plan, seats })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("event"),
      payload: z.string().max(1_000_000),
      signature: z.string().max(2000),
    })
    .strict(),
]);
type Input = z.infer<typeof outreachrBillingInput>;
export interface OutreachrBillingConfig {
  solPrice: string;
  astraPrice: string;
  webhookSecret: string;
}

function assertBilling(condition: unknown, message: string): asserts condition {
  if (!condition) throw new OutreachrDelegationError(403, "OUTREACHR_BILLING_SCOPE", message);
}

export async function outreachrBillingOperation(
  stripe: Stripe,
  registration: OutreachrRegistration,
  config: OutreachrBillingConfig,
  input: Input,
) {
  const tag = (workspaceId: string) => ({
    outreachr_app_id: registration.appId,
    outreachr_workspace_id: workspaceId,
  });
  const matches = (metadata: Stripe.Metadata | null, workspaceId: string) =>
    metadata?.outreachr_app_id === registration.appId &&
    metadata.outreachr_workspace_id === workspaceId;
  const returnUrl = `${registration.origin}/#/settings`;
  const priceFor = async (chosen: "sol" | "astra") => {
    const id = chosen === "sol" ? config.solPrice : config.astraPrice;
    if (!id)
      throw new OutreachrDelegationError(
        503,
        "OUTREACHR_PRICE_UNAVAILABLE",
        "Outreachr subscription prices are not configured",
      );
    const price = await stripe.prices.retrieve(id);
    assertBilling(
      price.active &&
        price.currency === "usd" &&
        price.unit_amount === (chosen === "sol" ? 4900 : 20000) &&
        price.recurring?.interval === "month" &&
        price.recurring.interval_count === 1 &&
        price.metadata.outreachr_app_id === registration.appId,
      "Outreachr price does not match the registered plan",
    );
    return price;
  };
  if (input.action === "event") {
    if (!config.webhookSecret)
      throw new OutreachrDelegationError(
        503,
        "OUTREACHR_WEBHOOK_UNAVAILABLE",
        "Outreachr webhook verification is not configured",
      );
    const event = await stripe.webhooks.constructEventAsync(
      input.payload,
      input.signature,
      config.webhookSecret,
    );
    const object = event.data.object;
    const metadata = "metadata" in object ? object.metadata : null;
    if (
      !metadata ||
      metadata.outreachr_app_id !== registration.appId ||
      !uuid.safeParse(metadata.outreachr_workspace_id).success
    )
      return { eventId: event.id, workspaceId: null };
    return { eventId: event.id, workspaceId: metadata.outreachr_workspace_id };
  }
  if (input.action === "customer") {
    const customer = await stripe.customers.create(
      { name: `Outreachr workspace ${input.workspaceId}`, metadata: tag(input.workspaceId) },
      { idempotencyKey: `outreachr:${registration.appId}:customer:${input.workspaceId}` },
    );
    return { customerId: customer.id };
  }
  const customer = await stripe.customers.retrieve(input.customerId);
  assertBilling(
    !customer.deleted && matches(customer.metadata, input.workspaceId),
    "Customer does not belong to this Outreachr workspace",
  );
  if (input.action === "checkout") {
    const price = await priceFor(input.plan);
    const existing = await stripe.subscriptions.list({
      customer: input.customerId,
      status: "all",
      limit: 100,
    });
    assertBilling(
      !existing.has_more &&
        !existing.data.some((sub) => !["canceled", "incomplete_expired"].includes(sub.status)),
      "This workspace already has a subscription; use billing management",
    );
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: input.customerId,
        line_items: [{ price: price.id, quantity: input.seats }],
        metadata: tag(input.workspaceId),
        subscription_data: { metadata: tag(input.workspaceId) },
        success_url: `${registration.origin}/?billing=return#/settings`,
        cancel_url: returnUrl,
      },
      { idempotencyKey: `outreachr:${registration.appId}:checkout:${input.attemptId}` },
    );
    return { sessionId: session.id, url: session.url, status: session.status };
  }
  if (input.action === "checkoutStatus" || input.action === "expireCheckout") {
    const session = await stripe.checkout.sessions.retrieve(input.sessionId);
    assertBilling(
      session.customer === input.customerId && matches(session.metadata, input.workspaceId),
      "Checkout does not belong to this Outreachr workspace",
    );
    if (input.action === "expireCheckout" && session.status === "open")
      await stripe.checkout.sessions.expire(session.id);
    return {
      sessionId: session.id,
      url: session.url,
      status:
        input.action === "expireCheckout" && session.status === "open" ? "expired" : session.status,
    };
  }
  const subscriptions = await stripe.subscriptions.list({
    customer: input.customerId,
    status: "all",
    limit: 100,
  });
  assertBilling(
    !subscriptions.has_more &&
      subscriptions.data.every((sub) => matches(sub.metadata, input.workspaceId)),
    "Unexpected subscriptions exist for this Outreachr customer",
  );
  if (input.action === "subscriptions") {
    return {
      subscriptions: subscriptions.data.map((sub) => {
        const item = sub.items.data[0];
        const known =
          item?.price.id === config.solPrice
            ? "sol"
            : item?.price.id === config.astraPrice
              ? "astra"
              : null;
        assertBilling(
          sub.items.data.length === 1 &&
            item &&
            known &&
            item.price.currency === "usd" &&
            item.price.unit_amount === (known === "sol" ? 4900 : 20000) &&
            item.price.recurring?.interval === "month" &&
            item.price.recurring.interval_count === 1,
          "Subscription does not match an Outreachr plan",
        );
        return {
          id: sub.id,
          status: sub.status,
          plan: known,
          seats: item.quantity,
          periodStart: item.current_period_start,
          periodEnd: item.current_period_end,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          created: sub.created,
        };
      }),
    };
  }
  const prices = await Promise.all([priceFor("sol"), priceFor("astra")]);
  const products = new Map<string, string[]>();
  for (const price of prices) {
    const product = typeof price.product === "string" ? price.product : price.product.id;
    products.set(product, [...(products.get(product) ?? []), price.id]);
  }
  const configuration = await stripe.billingPortal.configurations.create(
    {
      default_return_url: returnUrl,
      business_profile: { headline: "Outreachr workspace billing" },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price", "quantity"],
          proration_behavior: "always_invoice",
          products: [...products].map(([product, prices]) => ({
            product,
            prices,
            adjustable_quantity: { enabled: true, minimum: input.minimumSeats, maximum: 1000 },
          })),
        },
      },
    },
    { idempotencyKey: `outreachr:${registration.appId}:portal-config:${input.attemptId}` },
  );
  let flow: Stripe.BillingPortal.SessionCreateParams.FlowData | undefined;
  if (input.update) {
    const subscription = subscriptions.data.find((sub) => sub.id === input.update!.subscriptionId);
    assertBilling(
      subscription &&
        subscription.items.data.length === 1 &&
        input.update.seats >= input.minimumSeats,
      "Subscription update does not match this workspace",
    );
    const price = await priceFor(input.update.plan);
    flow = {
      type: "subscription_update_confirm",
      subscription_update_confirm: {
        subscription: subscription.id,
        items: [
          { id: subscription.items.data[0]!.id, price: price.id, quantity: input.update.seats },
        ],
      },
      after_completion: {
        type: "redirect",
        redirect: { return_url: `${registration.origin}/?billing=return#/settings` },
      },
    };
  }
  const portal = await stripe.billingPortal.sessions.create(
    {
      customer: input.customerId,
      configuration: configuration.id,
      return_url: returnUrl,
      ...(flow ? { flow_data: flow } : {}),
    },
    { idempotencyKey: `outreachr:${registration.appId}:portal:${input.attemptId}` },
  );
  return { url: portal.url };
}
