/** Exercises Stripe-compatible idempotency and the committed-then-lost response fault. */

import { afterEach, describe, expect, test } from "bun:test";
import { request } from "node:http";
import { type RunningFakeStripe, startFakeStripe } from "../src/stripe";

const AUTH_HEADERS = {
  Authorization: "Bearer sk_test_local_only",
  "Content-Type": "application/x-www-form-urlencoded",
};

let running: RunningFakeStripe | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe("fake Stripe", () => {
  test("loses two same-key transport responses, then recovers through list", async () => {
    running = await startFakeStripe();
    const customer = await createCustomer(running, "customer-key");
    const body = checkoutBody(customer.id, "order-123");
    running.loseNextCheckoutSessionCreateResponseAfterCommit();

    let lostResponseError: unknown;
    try {
      await nodeRequestText(
        `${running.url}/v1/checkout/sessions`,
        body.toString(),
        {
          ...AUTH_HEADERS,
          "Idempotency-Key": "checkout-order:order-123",
        },
      );
    } catch (error) {
      lostResponseError = error;
    }
    expect(lostResponseError).toBeInstanceOf(Error);

    let replayResponseError: unknown;
    try {
      await nodeRequestText(
        `${running.url}/v1/checkout/sessions`,
        body.toString(),
        {
          ...AUTH_HEADERS,
          "Idempotency-Key": "checkout-order:order-123",
        },
      );
    } catch (error) {
      replayResponseError = error;
    }
    expect(replayResponseError).toBeInstanceOf(Error);

    expect(running.state.sessions.size).toBe(1);
    expect(running.state.effects).toHaveLength(1);
    expect(running.state.counters.checkoutSessionsCreated).toBe(1);
    expect(running.state.counters.checkoutSessionCreateResponsesLost).toBe(2);

    const session = [...running.state.sessions.values()][0];
    expect(session).toBeDefined();
    if (!session)
      throw new Error("Fake Stripe did not retain the committed session");
    const recoveryResponse = await fetch(
      `${running.url}/v1/checkout/sessions?customer=${customer.id}&created[gte]=${session.created - 1}&created[lte]=${session.created + 1}&limit=100`,
      { headers: { Authorization: AUTH_HEADERS.Authorization } },
    );
    expect(recoveryResponse.status).toBe(200);
    const recovery = (await recoveryResponse.json()) as {
      data: Array<{ id: string }>;
    };

    expect(recovery.data).toEqual([{ ...session }]);
    expect(running.state.sessions.size).toBe(1);
    expect(running.state.effects).toHaveLength(1);
    expect(running.state.counters.checkoutSessionCreateAttempts).toBe(2);
    expect(running.state.counters.checkoutSessionsCreated).toBe(1);
    expect(
      running.state.requests
        .filter(
          (request) =>
            request.method === "POST" &&
            request.path === "/v1/checkout/sessions",
        )
        .map((request) => request.headers["idempotency-key"]),
    ).toEqual(["checkout-order:order-123", "checkout-order:order-123"]);
  });

  test("idempotently replays customer and Checkout Session creation", async () => {
    running = await startFakeStripe();
    const firstCustomer = await createCustomer(running, "same-customer-key");
    const secondCustomer = await createCustomer(running, "same-customer-key");
    expect(secondCustomer.id).toBe(firstCustomer.id);
    expect(running.state.customers.size).toBe(1);
    expect(running.state.counters.customerCreateAttempts).toBe(2);
    expect(running.state.counters.customersCreated).toBe(1);

    const body = checkoutBody(firstCustomer.id, "order-456");
    const first = await createSession(
      running,
      body,
      "checkout-order:order-456",
    );
    const replay = await createSession(
      running,
      body,
      "checkout-order:order-456",
    );
    expect(replay.id).toBe(first.id);
    expect(running.state.sessions.size).toBe(1);
    expect(running.state.effects).toEqual([
      expect.objectContaining({
        kind: "checkout.session.create",
        id: first.id,
        idempotencyKey: "checkout-order:order-456",
      }),
    ]);
  });

  test("moves an open unpaid Session to one stable paid completion", async () => {
    running = await startFakeStripe();
    const customer = await createCustomer(running, "completion-customer-key");
    const session = await createSession(
      running,
      checkoutBody(customer.id, "order-completion"),
      "checkout-order:order-completion",
    );
    const before = running.state.sessions.get(session.id);
    expect(before).toMatchObject({
      payment_status: "unpaid",
      status: "open",
      payment_intent: null,
    });

    const completed = running.completeCheckoutSession(session.id);
    expect(completed).toMatchObject({
      payment_status: "paid",
      status: "complete",
      payment_intent: "pi_fake_000001",
    });
    expect(running.completeCheckoutSession(session.id)).toEqual(completed);
    expect(running.state.sessions.size).toBe(1);
    expect(running.state.effects).toHaveLength(1);
  });

  test("retrieves the exact customer and reports Stripe resource_missing", async () => {
    running = await startFakeStripe();
    const created = await createCustomer(running, "retrieve-customer-key");

    const foundResponse = await fetch(
      `${running.url}/v1/customers/${created.id}`,
      {
        headers: { Authorization: AUTH_HEADERS.Authorization },
      },
    );
    expect(foundResponse.status).toBe(200);
    expect(await foundResponse.json()).toEqual(
      running.state.customers.get(created.id),
    );

    const missingResponse = await fetch(
      `${running.url}/v1/customers/cus_missing`,
      {
        headers: { Authorization: AUTH_HEADERS.Authorization },
      },
    );
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      error: {
        type: "invalid_request_error",
        message: "No such customer: 'cus_missing'",
        code: "resource_missing",
        param: "id",
      },
    });
  });

  test("lists a committed session by pinned customer and created range", async () => {
    running = await startFakeStripe();
    const customer = await createCustomer(running, "search-customer-key");
    const session = await createSession(
      running,
      checkoutBody(customer.id, "order-789"),
      "checkout-order:order-789",
    );

    const response = await fetch(
      `${running.url}/v1/checkout/sessions?customer=${customer.id}&created[gte]=${session.created - 1}&created[lte]=${session.created + 1}&limit=100`,
      { headers: { Authorization: AUTH_HEADERS.Authorization } },
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      data: Array<{
        id: string;
        client_reference_id: string;
        metadata: Record<string, string>;
      }>;
      has_more: boolean;
    };
    expect(page.has_more).toBe(false);
    expect(page.data).toEqual([
      expect.objectContaining({
        id: session.id,
        client_reference_id: "order-789",
        metadata: { checkout_order_id: "order-789", type: "custom_amount" },
      }),
    ]);
  });
});

async function createCustomer(
  fake: RunningFakeStripe,
  idempotencyKey: string,
): Promise<{ id: string }> {
  const response = await fetch(`${fake.url}/v1/customers`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Idempotency-Key": idempotencyKey },
    body: new URLSearchParams({
      email: "billing@example.test",
      "metadata[eliza_customer_attempt_id]": "attempt-123",
      "metadata[organization_id]": "org-123",
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

async function createSession(
  fake: RunningFakeStripe,
  body: URLSearchParams,
  idempotencyKey: string,
): Promise<{ id: string; created: number }> {
  const response = await fetch(`${fake.url}/v1/checkout/sessions`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Idempotency-Key": idempotencyKey },
    body,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; created: number };
}

function checkoutBody(customerId: string, orderId: string): URLSearchParams {
  return new URLSearchParams({
    customer: customerId,
    client_reference_id: orderId,
    "metadata[checkout_order_id]": orderId,
    "metadata[type]": "custom_amount",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": "2500",
    "line_items[0][price_data][product_data][name]": "Account Balance Top-up",
    "line_items[0][quantity]": "1",
    mode: "payment",
  });
}

function nodeRequestText(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "POST", headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.once("end", () =>
        resolve(Buffer.concat(chunks).toString("utf8")),
      );
      incoming.once("error", reject);
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}
