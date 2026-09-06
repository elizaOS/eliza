/** Exercises billing SDK response contracts through a real localhost HTTP server. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { AppBillingAdminClient } from "./app-billing-admin.js";
import { ElizaCloudClient } from "./client.js";
import { CloudApiClient } from "./http.js";

let server: Server<undefined>;
const requests: { path: string; body: unknown }[] = [];
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/apps/registered/billing/accounts/resolve") {
        requests.push({ path, body: await request.json() });
        return Response.json({
          success: true,
          data: { id: "resolved-account" },
        });
      }
      if (
        path.includes("/bodyless/") ||
        path === "/api/v1/billing/application-slots/bodyless"
      )
        return new Response(null, { status: 204 });
      return Response.json({ error: "Unknown endpoint" }, { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
function client() {
  return new ElizaCloudClient({ apiBaseUrl: server.url.href });
}

test("account resolution reaches the registered endpoint with the original workspace identity", async () => {
  const input = {
    externalReference: "workspace-original",
    displayName: "Workspace",
  };
  await expect(
    client().appBilling("registered").resolveAccount(input),
  ).resolves.toEqual({
    success: true,
    data: { id: "resolved-account" },
  });
  expect(requests).toEqual([
    { path: "/api/v1/apps/registered/billing/accounts/resolve", body: input },
  ]);
});

test("buyer reads and writes reject missing billing results", async () => {
  const billing = client().appBilling("bodyless");
  await expect(billing.getCatalog()).rejects.toMatchObject({ statusCode: 204 });
  await expect(
    billing.resolveAccount({
      externalReference: null,
      displayName: "Workspace",
    }),
  ).rejects.toMatchObject({ statusCode: 204 });
});

test("admin reads and refund previews reject missing billing results", async () => {
  const admin = new AppBillingAdminClient(
    new CloudApiClient(server.url.href),
    "bodyless",
  );
  await expect(admin.overview()).rejects.toMatchObject({ statusCode: 204 });
  await expect(
    admin.previewRefund({
      clientRegistrationId: "registration",
      paidPeriodId: "period",
    }),
  ).rejects.toMatchObject({ statusCode: 204 });
});

test("native product and nonstreaming inference require response data", async () => {
  await expect(
    client().getApplicationBillingProduct("bodyless"),
  ).rejects.toMatchObject({ statusCode: 204 });
  const inference = client().appInference("bodyless", {
    clientId: "client",
    clientSecret: "controlled-secret",
    developerApiKey: "controlled-key",
  });
  await expect(
    inference.createChatCompletion(
      {
        billingAccountId: "account",
        productFamilyKey: "main",
        delegationToken: "controlled-grant",
        operationId: "operation-original",
      },
      { model: "fixture", messages: [{ role: "user", content: "hello" }] },
    ),
  ).rejects.toMatchObject({ statusCode: 204 });
});
