/** Exercises Twitter status role validation and fail-closed connection projection with mocks. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { TwitterConnectionStatus } from "@/lib/services/twitter-automation";

const getConnectionStatus = mock(
  async (): Promise<TwitterConnectionStatus> => ({
    connected: true,
    username: "owner-acct",
  }),
);
const isConfigured = mock(() => true);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/services/twitter-automation", () => ({
  twitterAutomationService: { getConnectionStatus, isConfigured },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "internal_error" }, 500),
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/twitter/status", route);

function getStatus(query = "") {
  return app.request(`/api/v1/twitter/status${query}`);
}

describe("GET /api/v1/twitter/status connectionRole identity", () => {
  beforeEach(() => {
    getConnectionStatus.mockClear();
    isConfigured.mockClear();
    isConfigured.mockReturnValue(true);
  });

  test.each([
    ["", "owner"],
    ["?connectionRole=", "owner"],
    ["?connectionRole=owner", "owner"],
    ["?connectionRole=agent", "agent"],
  ])("accepts %s as %s", async (query, role) => {
    const response = await getStatus(query);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connectionRole: string };
    expect(body.connectionRole).toBe(role);
    expect(getConnectionStatus).toHaveBeenCalledTimes(1);
    expect(getConnectionStatus).toHaveBeenCalledWith("org-1", role);
  });

  test("returns no active connectionId for an unverified provider identity", async () => {
    getConnectionStatus.mockResolvedValueOnce({
      connected: false,
      storedIdentity: {
        verified: false,
        username: "stored-handle",
        userId: "stored-user",
      },
      errorCode: "provider_identity_verification_failed",
      error: "X identity could not be verified. Try reconnecting.",
    });

    const response = await getStatus("?connectionRole=owner");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      connected: boolean;
      connectionId: string | null;
      storedIdentity: { verified: false; username: string; userId: string };
      errorCode: string;
    };
    expect(body.connected).toBe(false);
    expect(body.connectionId).toBeNull();
    expect(body.storedIdentity).toEqual({
      verified: false,
      username: "stored-handle",
      userId: "stored-user",
    });
    expect(body.errorCode).toBe("provider_identity_verification_failed");
  });

  test.each(["AGENT", "Owner", "foo", "1e2", "agent ", "owner\n"])(
    "rejects connectionRole=%s before status lookup",
    async (token) => {
      const response = await getStatus(
        `?connectionRole=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/connection_role|connectionRole/i);
      expect(getConnectionStatus).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?connectionRole=agent&connectionRole=agent",
    "?connectionRole=agent&connectionRole=owner",
    "?connectionRole=&connectionRole=agent",
    "?connectionRole=foo&connectionRole=owner",
  ])(
    "rejects duplicate role values in %s before status lookup",
    async (query) => {
      const response = await getStatus(query);
      expect(response.status).toBe(400);
      expect(getConnectionStatus).not.toHaveBeenCalled();
    },
  );
});
