/**
 * Deterministic coverage for separating Google OAuth's cumulative grant from
 * the narrower personal Workspace products selected for the current agent.
 */

import type { ConnectorAccountManager, IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleConnectorAccountProvider,
  revokeGoogleOAuthToken,
  selectRequestedGrantedCapabilities,
} from "./connector-account-provider.js";

function oauthRuntime(): IAgentRuntime {
  const vault = new Map([
    ["GOOGLE_CLIENT_ID", "google-client-id"],
    ["GOOGLE_CLIENT_SECRET", "google-client-secret"],
  ]);
  return {
    getSetting: () => undefined,
    getService: (name: string) =>
      name === "SECRETS" ? { getGlobal: async (key: string) => vault.get(key) ?? null } : null,
  } as unknown as IAgentRuntime;
}

function vaultOnlyOAuthRuntime(): IAgentRuntime {
  const vault = new Map([
    ["GOOGLE_CLIENT_ID", "vault-google-client-id"],
    ["GOOGLE_CLIENT_SECRET", "vault-google-client-secret"],
  ]);
  return {
    getSetting: () => undefined,
    getService: (name: string) =>
      name === "SECRETS" ? { getGlobal: async (key: string) => vault.get(key) ?? null } : null,
  } as unknown as IAgentRuntime;
}

function pendingFlow() {
  return {
    id: "google-oauth-flow",
    provider: "google",
    state: "google-oauth-state",
    status: "pending" as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Google connector OAuth selection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not re-enable products that remain in Google's incremental grant", () => {
    expect(
      selectRequestedGrantedCapabilities(
        ["gmail.read", "gmail.draft"],
        ["gmail.read", "gmail.draft", "calendar.read", "drive.read"]
      )
    ).toEqual(["gmail.read", "gmail.draft"]);
  });

  it.each([
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar",
  ])(
    "accepts the legacy %s grant as calendar.read but requests only readonly",
    async (legacyScope) => {
      const provider = createGoogleConnectorAccountProvider(oauthRuntime());
      const started = await provider.startOAuth?.(
        {
          provider: "google",
          flow: pendingFlow(),
          redirectUri: "https://example.test/oauth/google/callback",
          scopes: [legacyScope],
        },
        {} as ConnectorAccountManager
      );
      const url = new URL(started?.authUrl ?? "");
      const requestedScopes = new Set(
        (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean)
      );

      expect(started?.metadata).toMatchObject({
        requestedCapabilities: ["calendar.read"],
      });
      expect(requestedScopes).toContain("https://www.googleapis.com/auth/calendar.readonly");
      expect(requestedScopes).not.toContain(legacyScope);
    }
  );

  it("starts OAuth from vault credentials and the request-derived callback", async () => {
    const provider = createGoogleConnectorAccountProvider(vaultOnlyOAuthRuntime());
    const started = await provider.startOAuth?.(
      {
        provider: "google",
        flow: pendingFlow(),
        redirectUri: "http://localhost:31337/api/connectors/google/oauth/callback",
        scopes: ["calendar.read"],
      },
      {} as ConnectorAccountManager
    );
    const url = new URL(started?.authUrl ?? "");

    expect(url.searchParams.get("client_id")).toBe("vault-google-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:31337/api/connectors/google/oauth/callback"
    );
  });

  it("revokes with a form-encoded token and never places it in the URL", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await revokeGoogleOAuthToken("refresh-token-secret");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({
        method: "POST",
        body: "token=refresh-token-secret",
      })
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("refresh-token-secret");
  });
});
