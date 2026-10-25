import { beforeEach, expect, mock, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { AgentGoogleConnectorError } from "../../../../../../shared/src/lib/services/agent-google-connector/shared";

let authenticated = true,
  privateOwner = true;
const calls: unknown[] = [];
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => {
    if (!authenticated) throw new HTTPException(401);
    return { id: "owner-1", organization_id: "org-1" };
  },
  requirePrivateOwnerAccess: async () => {
    if (!privateOwner) throw new HTTPException(403);
  },
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/agent-google-connector/shared",
  () => ({ AgentGoogleConnectorError }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/agent-google-connector",
  () => ({
    fetchManagedGoogleGmailHistory: async (input: unknown) => {
      calls.push(input);
      return { version: 1, status: "page", checkpoint: "120", events: [] };
    },
  }),
);
const { default: app } = await import("./route");
beforeEach(() => {
  authenticated = true;
  privateOwner = true;
  calls.length = 0;
});
test("route binds user and organization from auth and preserves opaque cursor", async () => {
  const response = await app.request(
    "/?grantId=grant-1&startHistoryId=100&pageToken=a%2Bb%2F%3D&maxResults=25",
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(calls).toEqual([
    {
      organizationId: "org-1",
      userId: "owner-1",
      grantId: "grant-1",
      startHistoryId: "100",
      pageToken: "a+b/=",
      maxResults: 25,
    },
  ]);
});
test("route rejects agent-side, tenant overrides and duplicate or malformed parameters", async () => {
  for (const query of [
    "side=agent",
    "organizationId=other",
    "grantId=a&grantId=b",
    "maxResults=1e2",
    "maxResults=01",
    "side=owner&side=agent",
  ]) {
    expect((await app.request(`/?${query}`)).status).toBe(400);
  }
  expect(calls).toHaveLength(0);
});
test("auth and private-owner rejection happen before managed provider reads", async () => {
  authenticated = false;
  expect((await app.request("/?grantId=grant-1")).status).toBe(401);
  authenticated = true;
  privateOwner = false;
  expect((await app.request("/?grantId=grant-1")).status).toBe(403);
  expect(calls).toHaveLength(0);
});
