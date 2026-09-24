/** Supplies explicit SDK HTTP fixtures for notification UI behavior; signing material is synthetic and never a live key. */
import { CloudApiClient } from "@elizaos/cloud-sdk";
import { AppBillingAdminClient } from "@elizaos/cloud-sdk/app-billing-admin";
import type { AppBillingNotificationConfig } from "@elizaos/cloud-sdk/app-notifications";
export function notificationFixture() {
  let config: AppBillingNotificationConfig = {
    appId: "app-a",
    environment: "test",
    endpointUrl: "https://app.example/api/billing/notifications",
    enabled: false,
    revision: "1",
    keyId: null,
    pendingKeyId: null,
    lastDeliveredAt: null,
    pendingCount: 0,
    failedCount: 0,
  };
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  }[] = [];
  let fail = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body =
      request.method === "GET"
        ? null
        : ((await request.json()) as Record<string, unknown>);
    calls.push({ path, method: request.method, body });
    if (fail)
      return Response.json(
        { error: "Notification configuration unavailable" },
        { status: 503 },
      );
    if (path.endsWith("/prepare")) {
      config = { ...config, revision: "2", pendingKeyId: "pending-key-1" };
      return Response.json({
        success: true,
        data: { config, signingSecret: "synthetic-one-time-signing-secret" },
      });
    }
    if (path.endsWith("/activate"))
      config = {
        ...config,
        revision: "3",
        keyId: config.pendingKeyId,
        pendingKeyId: null,
      };
    else if (request.method === "POST")
      config = {
        ...config,
        revision: "4",
        endpointUrl: String(body?.endpointUrl),
        enabled: body?.enabled === true,
      };
    return Response.json({ success: true, data: config });
  };
  return {
    fetchImpl,
    calls,
    client: new AppBillingAdminClient(
      new CloudApiClient("https://fixture.example/api/v1", undefined, {
        fetchImpl,
      }),
      "app-a",
    ),
    set config(value: AppBillingNotificationConfig) {
      config = value;
    },
    get config() {
      return config;
    },
    set failure(value: boolean) {
      fail = value;
    },
  };
}
