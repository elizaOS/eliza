import { describe, expect, it } from "vitest";
import {
  buildStewardOAuthAuthorizeUrl,
  createStewardPkceChallenge,
  createStewardPkcePair,
} from "./steward-oauth-pkce.js";

describe("steward-oauth-pkce", () => {
  it("createStewardPkcePair challenge is the S256 hash of its verifier", async () => {
    const { verifier, challenge } = await createStewardPkcePair();
    expect(await createStewardPkceChallenge(verifier)).toBe(challenge);
  });

  it("buildStewardOAuthAuthorizeUrl includes PKCE params when challenge provided", () => {
    const url = buildStewardOAuthAuthorizeUrl(
      "google",
      "https://os.elizaos.ai/checkout?sku=elizaos-usb",
      {
        stewardApiUrl: "https://api.elizacloud.ai/steward",
        codeChallenge: "challenge-abc",
      },
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/steward/auth/oauth/google/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://os.elizaos.ai/checkout?sku=elizaos-usb",
    );
  });

  it("buildStewardOAuthAuthorizeUrl omits PKCE params without a challenge", () => {
    const url = buildStewardOAuthAuthorizeUrl(
      "github",
      "https://www.elizacloud.ai/login",
      { stewardApiUrl: "https://api.elizacloud.ai/steward" },
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.has("code_challenge")).toBe(false);
    expect(parsed.searchParams.has("code_challenge_method")).toBe(false);
  });
});
