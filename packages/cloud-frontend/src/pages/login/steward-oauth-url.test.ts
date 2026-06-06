import { beforeEach, describe, expect, it } from "vitest";
import {
  buildStewardOAuthAuthorizeUrl,
  buildStewardOAuthRedirectUri,
  consumeStewardPkceVerifier,
  createStewardPkceChallenge,
  createStewardPkcePair,
  generateStewardPkceVerifier,
  storeStewardPkceVerifier,
} from "./steward-oauth-url";

describe("Steward OAuth PKCE", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("createStewardPkceChallenge matches the RFC 7636 Appendix B vector", async () => {
    // The canonical RFC 7636 example — also what Steward's pkceChallengeForVerifier
    // computes (base64url(sha256(verifier))). Locks our S256 to the spec.
    const challenge = await createStewardPkceChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generateStewardPkceVerifier is URL-safe and within RFC 7636 length bounds", () => {
    const verifier = generateStewardPkceVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(generateStewardPkceVerifier()).not.toBe(verifier); // high-entropy
  });

  it("createStewardPkcePair's challenge is the S256 hash of its verifier", async () => {
    const { verifier, challenge } = await createStewardPkcePair();
    expect(challenge).toBe(await createStewardPkceChallenge(verifier));
  });

  it("store/consume round-trips the verifier exactly once (single-use)", () => {
    expect(storeStewardPkceVerifier("verifier-xyz")).toBe(true);
    expect(consumeStewardPkceVerifier()).toBe("verifier-xyz");
    // Consumed — a replayed/duplicate callback can't reuse a stale verifier.
    expect(consumeStewardPkceVerifier()).toBeNull();
  });

  it("buildStewardOAuthRedirectUri stays stable regardless of login query params", () => {
    expect(buildStewardOAuthRedirectUri("https://www.elizacloud.ai")).toBe(
      "https://www.elizacloud.ai/login",
    );
  });

  it("buildStewardOAuthAuthorizeUrl includes the PKCE challenge only when provided", () => {
    const withPkce = new URL(
      buildStewardOAuthAuthorizeUrl("google", "https://www.elizacloud.ai", {
        stewardApiUrl: "https://api.example/steward",
        codeChallenge: "CHALLENGE",
      }),
    );
    expect(withPkce.searchParams.get("redirect_uri")).toBe(
      "https://www.elizacloud.ai/login",
    );
    expect(withPkce.searchParams.get("response_type")).toBe("code");
    expect(withPkce.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(withPkce.searchParams.get("code_challenge_method")).toBe("S256");

    const withoutPkce = new URL(
      buildStewardOAuthAuthorizeUrl("google", "https://www.elizacloud.ai", {
        stewardApiUrl: "https://api.example/steward",
      }),
    );
    expect(withoutPkce.searchParams.has("code_challenge")).toBe(false);
    expect(withoutPkce.searchParams.has("code_challenge_method")).toBe(false);
  });
});
