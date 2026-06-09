import { describe, expect, it } from "vitest";
import {
  buildFeedOAuthRedirectUri,
  buildStewardOAuthAuthorizeUrl,
  createStewardPkceChallenge,
  createStewardPkcePair,
} from "./steward-oauth";

describe("steward-oauth", () => {
  it("createStewardPkcePair challenge is the S256 hash of its verifier", async () => {
    const { verifier, challenge } = await createStewardPkcePair();
    expect(await createStewardPkceChallenge(verifier)).toBe(challenge);
  });

  it("buildFeedOAuthRedirectUri targets the provider callback page", () => {
    expect(buildFeedOAuthRedirectUri("https://feed.example", "google")).toBe(
      "https://feed.example/auth/callback/google",
    );
  });

  it("buildStewardOAuthAuthorizeUrl includes PKCE params when challenge provided", () => {
    const url = buildStewardOAuthAuthorizeUrl(
      "discord",
      "https://feed.example/auth/callback/discord",
      {
        stewardApiUrl: "https://auth.elizacloud.ai",
        stewardTenantId: "feed",
        codeChallenge: "challenge-abc",
      },
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/auth/oauth/discord/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://feed.example/auth/callback/discord",
    );
    expect(parsed.searchParams.get("tenant_id")).toBe("feed");
  });
});
