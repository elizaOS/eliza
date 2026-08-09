/**
 * Contract tests for the short-lived access-token bridge used by Google MCP.
 * Refresh credentials remain inside the auth client and are never returned to
 * the MCP resource engine.
 */
import { describe, expect, it, vi } from "vitest";
import { createGoogleMcpAccessTokenProvider } from "./access-token-provider";

describe("createGoogleMcpAccessTokenProvider", () => {
  it("returns only the current access token and invalidates it without dropping refresh state", async () => {
    const setCredentials = vi.fn();
    const client = {
      credentials: {
        access_token: "short-lived-access",
        refresh_token: "vault-owned-refresh",
        expiry_date: 123_456,
      },
      getAccessToken: vi.fn(async () => ({ token: "short-lived-access" })),
      setCredentials,
    };
    const resolveAuthClient = vi.fn(async () => client);
    const provider = createGoogleMcpAccessTokenProvider({
      accountId: "acct-google-1",
      product: "gmail",
      resolveAuthClient,
    });

    await expect(
      provider.getAccessToken({
        key: "google:agent:acct-google-1:gmail",
        endpoint: new URL("https://gmailmcp.googleapis.com/mcp/v1"),
        purpose: "discover",
      })
    ).resolves.toEqual({ accessToken: "short-lived-access", expiresAt: 123_456 });

    await provider.invalidateAccessToken?.({
      key: "google:agent:acct-google-1:gmail",
      endpoint: new URL("https://gmailmcp.googleapis.com/mcp/v1"),
      reason: "unauthorized",
    });

    expect(resolveAuthClient).toHaveBeenCalledWith({
      accountId: "acct-google-1",
      capability: "gmail.read",
      reason: "Execute Gmail through the official Google Workspace MCP resource",
    });
    expect(setCredentials).toHaveBeenCalledWith({
      refresh_token: "vault-owned-refresh",
      expiry_date: 0,
    });
  });
});
