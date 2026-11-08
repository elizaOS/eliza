import { expect, mock, test } from "bun:test";

// The real class pulls in the database client; the route only needs its shape.
class AgentGoogleConnectorError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const reason =
  "Failed to refresh google token: unauthorized_client. User may need to reconnect.";
let failure: Error = new AgentGoogleConnectorError(409, reason);
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "owner-1",
    organization_id: "org-1",
  }),
  requirePrivateOwnerAccess: async () => {},
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/agent-google-connector/shared",
  () => ({ AgentGoogleConnectorError }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/agent-google-connector/inbox-managed",
  () => ({
    managedInboxProvider: {
      capabilities: async () => {
        throw failure;
      },
      review: async () => {
        throw failure;
      },
    },
    managedInboxReceipts: {},
  }),
);
const { default: app } = await import("./route");
const grantId = "8f14e45f-ceea-467f-a8f5-8b4c5e6a7d01";

test("a Google token refresh failure answers 409 reauth_required without its raw reason", async () => {
  const read = await app.request(`/capabilities?grantId=${grantId}`);
  const operation = await app.request("/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grantId,
      requestId: "1f0e3dad-9990-4345-8b4c-6e2a8c1d2b30",
      proposal: {},
    }),
  });
  for (const response of [read, operation]) {
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({
      error: "Reconnect Google to keep using Gmail.",
      code: "reauth_required",
    });
    expect(JSON.stringify(body)).not.toContain("unauthorized");
  }
});

test("other connector failures keep the existing failure response", async () => {
  failure = new AgentGoogleConnectorError(404, "Google connection not found.");
  const response = await app.request(`/capabilities?grantId=${grantId}`);
  expect(response.status).not.toBe(409);
  expect(((await response.json()) as { code?: string }).code).not.toBe(
    "reauth_required",
  );
  failure = new AgentGoogleConnectorError(409, reason);
});
