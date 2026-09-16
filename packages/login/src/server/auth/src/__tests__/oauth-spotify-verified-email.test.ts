import { describe, expect, it } from "bun:test";
import { getProviderConfig, OAuthClient } from "../oauth";

// Regression test for issue #116. Spotify /v1/me returns an email but does not
// prove that email is verified, so Spotify must not satisfy the verified-email
// takeover gate.

function asFetchMock(
  impl: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch {
  return impl as unknown as typeof fetch;
}

function spotifyClient() {
  return new OAuthClient({
    clientId: "spotify-id",
    clientSecret: "spotify-secret",
    authorizationUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    userInfoUrl: "https://api.spotify.com/v1/me",
    scopes: ["user-read-email"],
    assertsEmailVerified: false,
    profileMap: {
      id: "id",
      email: "email",
      name: "display_name",
      picture: "images.0.url",
    },
  });
}

describe("Spotify OAuth verified-email handling (issue #116)", () => {
  it("built-in Spotify config does not assert the returned email is verified", () => {
    process.env.SPOTIFY_CLIENT_ID = "spotify-id";
    process.env.SPOTIFY_CLIENT_SECRET = "spotify-secret";
    const config = getProviderConfig("spotify");
    expect(config.assertsEmailVerified).toBe(false);
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
  });

  it("keeps verified_email=false for a Spotify email with no verification flag", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchMock(
      async () =>
        new Response(
          JSON.stringify({
            id: "spotify-user-id",
            display_name: "Spotify User",
            email: "user@example.com",
            images: [{ url: "https://i.scdn.co/image/avatar" }],
            // Note: Spotify returns NO verified/email_verified field.
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const info = await spotifyClient().getUserInfo("tok");
    expect(info.id).toBe("spotify-user-id");
    expect(info.email).toBe("user@example.com");
    expect(info.name).toBe("Spotify User");
    expect(info.verified_email).toBe(false);
    globalThis.fetch = originalFetch;
  });

  it("does NOT fabricate verification when the provider returns no email", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchMock(
      async () =>
        new Response(
          JSON.stringify({ id: "spotify-user-id", display_name: "No Email" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const info = await spotifyClient().getUserInfo("tok");
    expect(info.email).toBe("");
    // No email => nothing to trust; the gate must still see verified_email=false.
    expect(info.verified_email).toBe(false);
    globalThis.fetch = originalFetch;
  });
});
