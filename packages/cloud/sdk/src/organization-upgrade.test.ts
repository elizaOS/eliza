/** Upgrade review transport over real loopback HTTP; no live provider or charge. */
import { expect, test } from "bun:test";
import { ElizaCloudClient } from "./client.js";

test("upgrade review sends the authenticated catalog intent and preserves conflict errors", async () => {
  let conflict = false;
  const requests: {
    path: string;
    method: string;
    authorization: string | null;
    body: unknown;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return conflict
        ? Response.json(
            {
              error: "Review current subscription",
              code: "billing_state_conflict",
            },
            { status: 409 },
          )
        : Response.json({
            success: true,
            data: {
              quoteId: "quote_fixture",
              review: { kind: "upgrade_estimate" },
            },
          });
    },
  });
  try {
    const client = new ElizaCloudClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      bearerToken: "synthetic-session",
    });
    const input = {
      subscriptionId: "75a1e593-bd63-4bff-99f3-b916182bc30d",
      expectedSubscriptionRevision: 2,
      targetPlanKey: "pro_monthly" as const,
    };
    const result =
      await client.createOrganizationSubscriptionUpgradeQuote(input);
    expect(result.data.quoteId).toBe("quote_fixture");
    expect(requests).toEqual([
      {
        path: "/api/v1/subscriptions/upgrade/review",
        method: "POST",
        authorization: "Bearer synthetic-session",
        body: input,
      },
    ]);
    conflict = true;
    await expect(
      client.createOrganizationSubscriptionUpgradeQuote(input),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(requests).toHaveLength(2);
  } finally {
    await server.stop(true);
  }
});

test("confirmation and status retain the original command over authenticated HTTP", async () => {
  const seen: {
    path: string;
    method: string;
    body: unknown;
    auth: string | null;
  }[] = [];
  let denied = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        method: request.method,
        body: request.method === "POST" ? await request.json() : null,
        auth: request.headers.get("authorization"),
      });
      return denied
        ? Response.json(
            { code: "access_denied", error: "Current manager required" },
            { status: 403 },
          )
        : Response.json({
            success: true,
            data: { commandId: "original", status: "OUTCOME_UNKNOWN" },
          });
    },
  });
  try {
    const client = new ElizaCloudClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      bearerToken: "synthetic-session",
    });
    const input = {
      quoteId: "original-quote",
      idempotencyKey: "original-intent",
    };
    expect(
      (await client.confirmOrganizationSubscriptionUpgrade(input)).data.status,
    ).toBe("OUTCOME_UNKNOWN");
    expect(
      (await client.readOrganizationSubscriptionUpgrade("original/id")).data
        .commandId,
    ).toBe("original");
    expect(seen).toEqual([
      {
        path: "/api/v1/subscriptions/upgrade/confirm",
        method: "POST",
        body: input,
        auth: "Bearer synthetic-session",
      },
      {
        path: "/api/v1/subscriptions/upgrade/original%2Fid",
        method: "GET",
        body: null,
        auth: "Bearer synthetic-session",
      },
    ]);
    denied = true;
    await expect(
      client.readOrganizationSubscriptionUpgrade("original"),
    ).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    await server.stop(true);
  }
});

test("payment continuation uses a fresh authenticated POST and preserves authorization failures", async () => {
  const seen: {
    path: string;
    method: string;
    auth: string | null;
    body: string;
  }[] = [];
  let denied = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        method: request.method,
        auth: request.headers.get("authorization"),
        body: await request.text(),
      });
      return denied
        ? Response.json(
            { error: "Current manager required", code: "access_denied" },
            { status: 403 },
          )
        : Response.json(
            {
              success: true,
              data: {
                command: { status: "OUTCOME_UNKNOWN" },
                continuation: {
                  kind: "hosted_invoice",
                  hostedInvoiceUrl: "https://invoice.stripe.com/i/test_private",
                },
              },
            },
            { headers: { "cache-control": "no-store" } },
          );
    },
  });
  try {
    const client = new ElizaCloudClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      bearerToken: "synthetic-session",
    });
    const response =
      await client.continueOrganizationSubscriptionUpgradePayment(
        "original/command",
      );
    expect(response.data.continuation?.kind).toBe("hosted_invoice");
    expect(seen).toEqual([
      {
        path: "/api/v1/subscriptions/upgrade/original%2Fcommand/payment",
        method: "POST",
        auth: "Bearer synthetic-session",
        body: "",
      },
    ]);
    denied = true;
    await expect(
      client.continueOrganizationSubscriptionUpgradePayment("original/command"),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(seen).toHaveLength(2);
  } finally {
    await server.stop(true);
  }
});
