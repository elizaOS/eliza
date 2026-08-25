/**
 * Verifies Google connector account creation requires an explicit canonical
 * role instead of silently granting OWNER on missing or malformed input.
 */

import { describe, expect, it, vi } from "vitest";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";

const provider = createGoogleConnectorAccountProvider({
  getSetting: () => undefined,
  getService: () => null,
} as never);

describe("Google connector account role admission", () => {
  it.each([
    ["missing", {}],
    ["invalid", { role: "administrator" }],
  ])("rejects a %s role", async (_label, input) => {
    await expect(provider.createAccount?.(input as never, {} as never)).rejects.toMatchObject({
      code:
        _label === "missing" ? "GOOGLE_CONNECTOR_ROLE_REQUIRED" : "GOOGLE_CONNECTOR_ROLE_INVALID",
    });
  });

  it("preserves an explicit canonical role", async () => {
    await expect(
      provider.createAccount?.({ role: "AGENT" } as never, {} as never)
    ).resolves.toMatchObject({ provider: "google", role: "AGENT" });
  });

  it.each([
    ["missing", undefined, "GOOGLE_CONNECTOR_ROLE_REQUIRED"],
    ["invalid", { requestedRole: "administrator" }, "GOOGLE_CONNECTOR_ROLE_INVALID"],
  ])(
    "refuses OAuth start with a %s new-grant role before consent",
    async (_label, metadata, code) => {
      const oauthProvider = createGoogleConnectorAccountProvider({
        getSetting: (key: string) =>
          ({
            GOOGLE_CLIENT_ID: "google-client",
            GOOGLE_CLIENT_SECRET: "google-secret",
            GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
          })[key],
        getService: () => null,
      } as never);
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await expect(
        oauthProvider.startOAuth?.(
          {
            provider: "google",
            scopes: ["gmail.read"],
            metadata,
            flow: {
              id: "flow-role-rejection",
              provider: "google",
              state: "state-role-rejection",
              status: "pending",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
          {} as never
        )
      ).rejects.toMatchObject({ code });
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }
  );

  it("binds the stored role when reauthorizing an existing account", async () => {
    const oauthProvider = createGoogleConnectorAccountProvider({
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:31437/api/connectors/google/oauth/callback",
        })[key],
      getService: () => null,
    } as never);
    const getAccount = vi.fn(async () => ({
      id: "account-1",
      provider: "google",
      role: "TEAM",
      metadata: { grantedCapabilities: ["gmail.read"] },
    }));

    const result = await oauthProvider.startOAuth?.(
      {
        provider: "google",
        accountId: "account-1",
        scopes: ["gmail.read"],
        metadata: { requestedRole: "OWNER" },
        flow: {
          id: "flow-role-reauth",
          provider: "google",
          state: "state-role-reauth",
          status: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
      { getAccount } as never
    );

    expect(result?.metadata).toMatchObject({ requestedRole: "TEAM" });
    expect(getAccount).toHaveBeenCalledWith("google", "account-1");
  });
});
