/**
 * Deterministic contract coverage for the MCP-only personal Google plugin
 * surface and its least-privilege OAuth capability mapping.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { getConnectorAccountManager } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import googlePlugin, {
  GOOGLE_OAUTH_SCOPES,
  getGoogleOAuthProviderConfig,
  normalizeGoogleCapabilities,
  scopesForGoogleCapabilities,
} from "./index.js";

describe("Google Workspace MCP plugin", () => {
  it("registers the direct-OAuth Google account provider", async () => {
    const runtime = {
      getService: () => null,
      getSetting: () => undefined,
    } as IAgentRuntime;

    await googlePlugin.init?.({}, runtime);

    expect(getConnectorAccountManager(runtime).getProvider("google")).toMatchObject({
      provider: "google",
      startOAuth: expect.any(Function),
      completeOAuth: expect.any(Function),
    });
  });

  it("derives only the scopes required by selected MCP capabilities", () => {
    const scopes = scopesForGoogleCapabilities([
      "gmail.read",
      "gmail.draft",
      "calendar.read",
      "docs.read",
    ]);

    expect(scopes).toEqual(
      expect.arrayContaining([
        GOOGLE_OAUTH_SCOPES.profile.openid,
        GOOGLE_OAUTH_SCOPES.profile.email,
        GOOGLE_OAUTH_SCOPES.gmail.read,
        GOOGLE_OAUTH_SCOPES.gmail.compose,
        GOOGLE_OAUTH_SCOPES.calendar.read,
        GOOGLE_OAUTH_SCOPES.docs.read,
      ])
    );
    expect(scopes).not.toContain(GOOGLE_OAUTH_SCOPES.drive.write);
    expect(scopes).not.toContain(GOOGLE_OAUTH_SCOPES.chat.send);
  });

  it("drops unknown capabilities instead of widening OAuth access", () => {
    const config = getGoogleOAuthProviderConfig(
      normalizeGoogleCapabilities(["drive.read", "drive.read", "unknown"])
    );

    expect(config.capabilities).toEqual(["drive.read"]);
    expect(config.scopes).toContain(GOOGLE_OAUTH_SCOPES.drive.read);
    expect(config.scopes).not.toContain(GOOGLE_OAUTH_SCOPES.drive.write);
  });

  it("does not expose legacy REST or Gmail-delivery modules", async () => {
    const surface = await import("./index.js");

    expect(surface).not.toHaveProperty("GoogleGmailClient");
    expect(surface).not.toHaveProperty("GoogleCalendarClient");
    expect(surface).not.toHaveProperty("GoogleDriveClient");
    expect(surface).not.toHaveProperty("GoogleMeetClient");
    expect(surface).not.toHaveProperty("GoogleGmailAdapter");
    expect(surface).not.toHaveProperty("createGmailMessageConnector");
  });
});
