/** Proves an approved Duffel booking commits once and is readable from the durable approval ledger. */

import type { IAgentRuntime } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { createApprovalQueue } from "../../../../plugins/plugin-personal-assistant/src/lifeops/approval-queue.ts";
import { createFeatureFlagService } from "../../../../plugins/plugin-personal-assistant/src/lifeops/feature-flags.ts";

const DUFFEL_BASE = "https://duffel.connector-contract.test";
const fixtures = new WeakMap<
  object,
  {
    originalFetch: typeof globalThis.fetch;
    previousEnv: Record<string, string | undefined>;
    requests: Array<{ url: string; method: string; body: string }>;
    orderReads: number;
  }
>();

const offer = {
  id: "off_contract_123",
  total_amount: "299.50",
  total_currency: "USD",
  expires_at: "2026-08-20T18:00:00Z",
  passengers: [{ id: "pas_contract_1", type: "adult" }],
  payment_requirements: {
    requires_instant_payment: false,
    price_guarantee_expires_at: "2026-08-20T18:00:00Z",
    payment_required_by: "2026-08-21T18:00:00Z",
  },
  slices: [
    {
      origin: { iata_code: "SFO" },
      destination: { iata_code: "JFK" },
      duration: "PT5H30M",
      fare_brand_name: "Economy",
      segments: [
        {
          origin: { iata_code: "SFO" },
          destination: { iata_code: "JFK" },
          departing_at: "2026-08-24T16:00:00Z",
          arriving_at: "2026-08-24T21:30:00Z",
          operating_carrier: { iata_code: "UA" },
          flight_number: "UA100",
          duration: "PT5H30M",
        },
      ],
    },
  ],
};

function order(documents: unknown[] = []) {
  return {
    id: "ord_contract_123",
    booking_reference: "RZPNX8",
    total_amount: "299.50",
    total_currency: "USD",
    slices: offer.slices,
    passengers: [
      {
        id: "pas_contract_1",
        given_name: "Taylor",
        family_name: "Owner",
      },
    ],
    payment_status: {
      awaiting_payment: documents.length === 0,
      payment_required_by: "2026-08-21T18:00:00Z",
      price_guarantee_expires_at: "2026-08-20T18:00:00Z",
    },
    documents,
  };
}

async function installDuffelFixture(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime;
  await createFeatureFlagService(runtime).enable(
    "travel.book_flight",
    "local",
    String(runtime.agentId),
    { connectorContract: true },
  );
  const previousEnv = {
    DUFFEL_API_KEY: process.env.DUFFEL_API_KEY,
    ELIZA_DUFFEL_DIRECT: process.env.ELIZA_DUFFEL_DIRECT,
    LIFEOPS_DUFFEL_API_BASE: process.env.LIFEOPS_DUFFEL_API_BASE,
  };
  process.env.DUFFEL_API_KEY = "duffel_test_connector_contract";
  process.env.ELIZA_DUFFEL_DIRECT = "1";
  process.env.LIFEOPS_DUFFEL_API_BASE = DUFFEL_BASE;
  const originalFetch = globalThis.fetch;
  const fixture = {
    originalFetch,
    previousEnv,
    requests: [] as Array<{ url: string; method: string; body: string }>,
    orderReads: 0,
  };
  fixtures.set(runtime as object, fixture);
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (!url.startsWith(DUFFEL_BASE)) return originalFetch(input, init);
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    fixture.requests.push({ url, method, body });
    if (url.includes("/air/offer_requests")) {
      return Response.json({
        data: { id: "ofr_contract_123", offers: [offer] },
      });
    }
    if (url.endsWith("/air/offers/off_contract_123")) {
      return Response.json({ data: offer });
    }
    if (url.endsWith("/air/orders") && method === "POST") {
      return Response.json({ data: order() });
    }
    if (url.endsWith("/air/orders/ord_contract_123")) {
      fixture.orderReads += 1;
      return Response.json({
        data: order(
          fixture.orderReads > 1
            ? [
                {
                  type: "electronic_ticket",
                  unique_identifier: "123-1230984567",
                },
              ]
            : [],
        ),
      });
    }
    if (url.endsWith("/air/payments")) {
      return Response.json({
        data: {
          id: "pay_contract_123",
          order_id: "ord_contract_123",
          status: "succeeded",
          currency: "USD",
          amount: "299.50",
          type: "balance",
          created_at: "2026-08-20T12:00:00Z",
        },
      });
    }
    throw new Error(`unexpected Duffel contract request: ${method} ${url}`);
  }) as typeof globalThis.fetch;
  return undefined;
}

function cleanupDuffelFixture(ctx: ScenarioContext): string | undefined {
  const fixture = fixtures.get(ctx.runtime as object);
  if (!fixture) return undefined;
  globalThis.fetch = fixture.originalFetch;
  for (const [key, value] of Object.entries(fixture.previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fixtures.delete(ctx.runtime as object);
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function assertDuffelBooking(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const fixture = fixtures.get(ctx.runtime as object);
  if (!fixture) return "Duffel fixture was not installed";
  const queued = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === "PERSONAL_ASSISTANT",
  );
  const approved = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === "RESOLVE_REQUEST",
  );
  const queuedData = record(queued?.result?.data);
  const approvedData = record(approved?.result?.data);
  if (
    queued?.result?.success !== true ||
    queuedData.state !== "pending" ||
    queuedData.offerId !== "off_contract_123"
  ) {
    return `travel request did not create an exact pending approval: ${JSON.stringify(queued?.result)}`;
  }
  if (
    approved?.result?.success !== true ||
    approvedData.state !== "done" ||
    approvedData.orderId !== "ord_contract_123" ||
    approvedData.bookingReference !== "RZPNX8" ||
    approvedData.paymentId !== "pay_contract_123"
  ) {
    return `approved travel request omitted its provider receipt: ${JSON.stringify(approved?.result)}`;
  }
  if (approvedData.requestId !== queuedData.requestId) {
    return "approval execution did not consume the queued request";
  }
  const orderWrites = fixture.requests.filter(
    (request) =>
      request.method === "POST" && request.url.endsWith("/air/orders"),
  );
  const paymentWrites = fixture.requests.filter(
    (request) =>
      request.method === "POST" && request.url.endsWith("/air/payments"),
  );
  if (orderWrites.length !== 1 || paymentWrites.length !== 1) {
    return `expected one order and one payment commit, saw ${orderWrites.length}/${paymentWrites.length}`;
  }
  const orderBody = JSON.parse(orderWrites[0]?.body ?? "{}") as {
    data?: Record<string, unknown>;
  };
  if (
    !JSON.stringify(orderBody.data).includes("off_contract_123") ||
    !JSON.stringify(orderBody.data).includes("Taylor")
  ) {
    return `Duffel order did not preserve selected offer/passenger: ${orderWrites[0]?.body}`;
  }
  const queue = createApprovalQueue(ctx.runtime as IAgentRuntime, {
    agentId: (ctx.runtime as IAgentRuntime).agentId,
  });
  const durable = await queue.byId(
    String(queuedData.requestId),
    String(ctx.primaryUserId),
  );
  if (
    durable?.state !== "done" ||
    durable.execution?.providerReceipt?.orderId !== "ord_contract_123"
  ) {
    return `durable approval readback omitted the committed order: ${JSON.stringify(durable)}`;
  }
  return undefined;
}

export default scenario({
  lane: "pr-deterministic",
  id: "connector.travel-booking.contract-core",
  title: "Duffel booking commits exactly once after durable approval",
  domain: "connector-contract",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: [
    "connector-contract",
    "duffel",
    "approval-gate",
    "provider-receipt",
    "durable-readback",
  ],
  description:
    "Executes the production PERSONAL_ASSISTANT travel handler and RESOLVE_REQUEST approval action against a deterministic Duffel HTTP boundary. It proves pending-before-write ordering, exact offer/passenger binding, one order and payment, provider receipt fields, and durable done-state readback; it does not claim a live booking.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  seed: [
    {
      type: "custom",
      name: "install deterministic Duffel boundary",
      apply: installDuffelFixture,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore Duffel boundary",
      apply: cleanupDuffelFixture,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Duffel booking contract",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "queue-duffel-booking",
      room: "main",
      actionName: "PERSONAL_ASSISTANT",
      text: "Book the exact SFO to JFK offer after I approve it.",
      options: {
        parameters: {
          action: "book_travel",
          origin: "SFO",
          destination: "JFK",
          departureDate: "2026-08-24",
          passengers: [
            {
              givenName: "Taylor",
              familyName: "Owner",
              bornOn: "1990-01-02",
              email: "taylor@example.test",
            },
          ],
          calendarSync: { enabled: false },
        },
      },
    },
    {
      kind: "action",
      name: "approve-duffel-booking",
      room: "main",
      actionName: "RESOLVE_REQUEST",
      text: "Yes, approve that exact travel booking now.",
      options: { parameters: { subaction: "approve" } },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "PERSONAL_ASSISTANT",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "RESOLVE_REQUEST",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "duffel-approval-provider-receipt-readback",
      predicate: assertDuffelBooking,
    },
  ],
});
