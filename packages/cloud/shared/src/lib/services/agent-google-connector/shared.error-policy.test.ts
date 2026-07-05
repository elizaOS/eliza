// Pins the fail-closed error policy of getGoogleAccessToken: a designed "unknown
// grant" (404) must stay distinguishable from an internal token-fetch failure
// (409), and an internal failure must PROPAGATE as a typed error rather than
// resolve to a null/empty token. Deps are injected through the module's real
// `managedGoogleConnectorDeps` seam; no network or DB is touched.
import { afterEach, describe, expect, it } from "bun:test";
import {
  AgentGoogleConnectorError,
  getGoogleAccessToken,
  managedGoogleConnectorDeps,
} from "./shared";

const ORIGINAL_OAUTH = { ...managedGoogleConnectorDeps.oauthService };

afterEach(() => {
  Object.assign(managedGoogleConnectorDeps.oauthService, ORIGINAL_OAUTH);
});

type Connection = { id: string };

function stubOauth(overrides: Partial<typeof managedGoogleConnectorDeps.oauthService>): void {
  Object.assign(managedGoogleConnectorDeps.oauthService, overrides);
}

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected getGoogleAccessToken to throw");
}

describe("getGoogleAccessToken error policy", () => {
  it("surfaces an unknown grantId as a distinct 404, not a masked 409", async () => {
    // Designed-empty: the org has no connection matching the requested grant.
    // listConnections legitimately returns [] — that must read as "not found",
    // never get re-labeled by the internal token-fetch catch.
    stubOauth({
      listConnections:
        (async () => []) as typeof managedGoogleConnectorDeps.oauthService.listConnections,
      getValidToken: (async () => {
        throw new Error("getValidToken should not be reached for an unknown grant");
      }) as typeof managedGoogleConnectorDeps.oauthService.getValidToken,
    });

    const error = await capture(() =>
      getGoogleAccessToken({
        organizationId: "org_1",
        userId: "user_1",
        side: "agent",
        grantId: "missing-grant",
      }),
    );

    expect(error).toBeInstanceOf(AgentGoogleConnectorError);
    expect((error as AgentGoogleConnectorError).status).toBe(404);
  });

  it("propagates an internal token-fetch failure as a 409 (never a fabricated token)", async () => {
    // The grant exists, but the OAuth token pipeline fails (no valid/refreshable
    // token). That internal failure must surface as a typed 409, not collapse to
    // an empty/null accessToken that downstream code would treat as "delivered".
    stubOauth({
      listConnections: (async () => [
        { id: "grant-1" } as Connection,
      ]) as typeof managedGoogleConnectorDeps.oauthService.listConnections,
      getValidToken: (async () => {
        throw new Error("token expired and refresh failed");
      }) as typeof managedGoogleConnectorDeps.oauthService.getValidToken,
    });

    const error = await capture(() =>
      getGoogleAccessToken({
        organizationId: "org_1",
        userId: "user_1",
        side: "agent",
        grantId: "grant-1",
      }),
    );

    expect(error).toBeInstanceOf(AgentGoogleConnectorError);
    expect((error as AgentGoogleConnectorError).status).toBe(409);
    expect((error as AgentGoogleConnectorError).message).toContain("token expired");
  });

  it("propagates a default-side token-fetch failure as a 409", async () => {
    // No grantId: the default lookup path also throws instead of returning a
    // hollow token when no active Google connection can produce one.
    stubOauth({
      getValidTokenByPlatformWithConnectionId: (async () => {
        throw new Error("no active google connection");
      }) as typeof managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId,
    });

    const error = await capture(() =>
      getGoogleAccessToken({
        organizationId: "org_1",
        userId: "user_1",
        side: "owner",
      }),
    );

    expect(error).toBeInstanceOf(AgentGoogleConnectorError);
    expect((error as AgentGoogleConnectorError).status).toBe(409);
    expect((error as AgentGoogleConnectorError).message).toContain("no active google connection");
  });

  it("returns the resolved token on the happy path (fail-closed policy does not block success)", async () => {
    stubOauth({
      getValidTokenByPlatformWithConnectionId: (async () => ({
        token: { accessToken: "ya29.real-token" },
        connectionId: "conn-9",
      })) as unknown as typeof managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId,
    });

    const result = await getGoogleAccessToken({
      organizationId: "org_1",
      userId: "user_1",
      side: "owner",
    });

    expect(result).toEqual({ accessToken: "ya29.real-token", connectionId: "conn-9" });
  });
});
