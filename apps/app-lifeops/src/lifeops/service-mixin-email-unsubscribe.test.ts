import type { LifeOpsConnectorGrant } from "@elizaos/app-lifeops/contracts";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "./service.js";

function runtime() {
  return {
    agentId: "agent-email-subscription-scan",
  } as unknown as ConstructorParameters<typeof LifeOpsService>[0];
}

function cloudGrant(
  id: string,
  cloudConnectionId: string,
  email: string,
): LifeOpsConnectorGrant {
  return {
    id,
    agentId: "agent-email-subscription-scan",
    provider: "google",
    side: "owner",
    mode: "cloud_managed",
    executionTarget: "cloud",
    sourceOfTruth: "cloud_connection",
    preferredByAgent: false,
    identity: { email },
    grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    capabilities: ["google.gmail.triage"],
    tokenRef: null,
    metadata: {},
    lastRefreshAt: null,
    cloudConnectionId,
    createdAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T12:00:00.000Z",
  };
}

function subscriptionHeader(id: string, fromEmail: string) {
  return {
    messageId: `message-${id}`,
    threadId: `thread-${id}`,
    receivedAt: "2026-04-22T12:00:00.000Z",
    subject: `Subscription ${id}`,
    fromDisplay: fromEmail,
    fromEmail,
    listId: `list-${id}`,
    listUnsubscribe: `<https://example.test/unsubscribe/${id}>`,
    listUnsubscribePost: "List-Unsubscribe=One-Click",
    snippet: "subscription receipt",
    labels: ["INBOX"],
  };
}

describe("LifeOps email subscription scan", () => {
  it("scans every cloud-managed Gmail grant using cloud connection ids", async () => {
    const service = new LifeOpsService(runtime());
    vi.spyOn(service.repository, "listConnectorGrants").mockResolvedValue([
      cloudGrant("grant-1", "cloud-connection-1", "one@example.test"),
      cloudGrant("grant-2", "cloud-connection-2", "two@example.test"),
    ]);
    const scan = vi
      .spyOn(service.googleManagedClient, "getGmailSubscriptionHeaders")
      .mockImplementation(async ({ grantId }) => ({
        headers: [
          subscriptionHeader(
            grantId ?? "missing",
            `${grantId}@sender.example.test`,
          ),
        ],
        syncedAt: "2026-04-22T12:00:00.000Z",
      }));

    const result = await service.scanEmailSubscriptions(
      new URL("http://localhost/api/lifeops/email/subscriptions/scan"),
    );

    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls.map(([args]) => args.grantId)).toEqual([
      "cloud-connection-1",
      "cloud-connection-2",
    ]);
    expect(result.summary.scannedMessageCount).toBe(2);
    expect(result.summary.uniqueSenderCount).toBe(2);
  });
});
