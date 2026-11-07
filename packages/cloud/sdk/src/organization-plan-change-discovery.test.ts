/** Real loopback transport; discovery performs only authenticated GET requests. */
import { expect, test } from "bun:test";
import { ElizaCloudClient } from "./client.js";

test("pending plan-change pages preserve cursor escaping, original kinds and typed errors", async () => {
  const requests: {
    url: string;
    method: string;
    authorization: string | null;
    body: string;
  }[] = [];
  let unavailable = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      return unavailable
        ? Response.json(
            { error: "Status unavailable", code: "service_unavailable" },
            { status: 503 },
          )
        : Response.json({
            success: true,
            data: {
              observedAt: "2026-10-05T00:00:00.000000Z",
              items: [
                {
                  commandId: "original",
                  kind: "downgrade",
                  targetPlanKey: "plus_monthly",
                  status: "OUTCOME_UNKNOWN",
                },
              ],
              nextCursor: "next",
            },
          });
    },
  });
  try {
    const client = new ElizaCloudClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      bearerToken: "synthetic-session",
    });
    const result = await client.listPendingOrganizationPlanChangeCommands({
      limit: 3,
      cursor: "a+b/=?&",
    });
    expect(result.data.items[0]).toMatchObject({
      kind: "downgrade",
      targetPlanKey: "plus_monthly",
    });
    expect(result.data.nextCursor).toBe("next");
    const first = requests[0];
    if (!first) throw Error("Expected discovery request");
    const url = new URL(first.url);
    expect(url.pathname).toBe("/api/v1/subscriptions/plan-change/commands");
    expect(url.searchParams.get("cursor")).toBe("a+b/=?&");
    expect(url.searchParams.get("limit")).toBe("3");
    expect(requests[0]).toMatchObject({
      method: "GET",
      authorization: "Bearer synthetic-session",
      body: "",
    });
    unavailable = true;
    await expect(
      client.listPendingOrganizationPlanChangeCommands({ limit: 1 }),
    ).rejects.toMatchObject({
      statusCode: 503,
      errorBody: { code: "service_unavailable" },
    });
  } finally {
    await server.stop(true);
  }
});
