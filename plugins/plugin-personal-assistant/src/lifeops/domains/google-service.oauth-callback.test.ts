/**
 * LifeOps Google OAuth start must use the canonical GOOGLE_REDIRECT_URI instead
 * of deriving a portless callback from INTERNAL_URL.
 */
import { describe, expect, it, vi } from "vitest";
import { GoogleDomain } from "./google-service.js";

const CANONICAL =
  "http://127.0.0.1:31437/api/connectors/google/oauth/callback";

describe("GoogleDomain OAuth callback parity", () => {
  it("starts OAuth with GOOGLE_REDIRECT_URI, not a portless INTERNAL_URL origin", async () => {
    const startOAuth = vi.fn(
      async (_provider: string, input: { redirectUri?: string }) => ({
        redirectUri: input.redirectUri,
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
      }),
    );
    const runtime = {
      getSetting: (key: string) =>
        ({
          GOOGLE_CLIENT_ID: "client-id",
          GOOGLE_CLIENT_SECRET: "client-secret",
          GOOGLE_REDIRECT_URI: CANONICAL,
        })[key],
    };
    const manager = {
      getProvider: () => ({ provider: "google" }),
      startOAuth,
    };
    const ctx = {
      runtime,
      agentId: () => "agent-1",
      repository: {
        listCalendarEvents: vi.fn(async () => []),
        deleteCalendarEventsForProvider: vi.fn(async () => undefined),
        deleteCalendarSyncState: vi.fn(async () => undefined),
        deleteGmailSyncState: vi.fn(async () => undefined),
        deleteGmailMessagesForProvider: vi.fn(async () => undefined),
      },
    };
    const domain = new GoogleDomain(ctx as never);
    vi.spyOn(domain as never, "googleConnectorManager").mockReturnValue(
      manager as never,
    );

    const response = await domain.startGoogleConnector(
      { side: "owner" },
      new URL("http://127.0.0.1/"),
    );

    expect(startOAuth).toHaveBeenCalledWith(
      "google",
      expect.objectContaining({ redirectUri: CANONICAL }),
    );
    expect(response.redirectUri).toBe(CANONICAL);
  });
});
