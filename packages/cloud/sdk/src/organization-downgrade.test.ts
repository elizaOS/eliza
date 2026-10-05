/** Downgrade review transport over real loopback HTTP; no live provider or charge. */
import { expect, test } from "bun:test";
import { ElizaCloudClient } from "./client.js";

test("downgrade review sends the authenticated catalog intent and preserves conflict errors", async () => {
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
              review: { kind: "downgrade_estimate" },
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
      targetPlanKey: "plus_monthly" as const,
    };
    const result =
      await client.createOrganizationSubscriptionDowngradeQuote(input);
    expect(result.data.quoteId).toBe("quote_fixture");
    expect(requests).toEqual([
      {
        path: "/api/v1/subscriptions/downgrade/review",
        method: "POST",
        authorization: "Bearer synthetic-session",
        body: input,
      },
    ]);
    conflict = true;
    await expect(
      client.createOrganizationSubscriptionDowngradeQuote(input),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(requests).toHaveLength(2);
  } finally {
    await server.stop(true);
  }
});
