import { describe, expect, it } from "bun:test";

import { EmailAuth } from "../email";

function captureAuth(tokenTtlMs = 10 * 60_000) {
  let text = "";
  const auth = new EmailAuth({
    from: "login@steward.fi",
    baseUrl: "https://steward.fi",
    codeVerifierSecret: "focused-email-login-test-secret",
    tokenTtlMs,
    provider: {
      send: async (_to, _subject, body) => (
        (text = body), { provider: "test" }
      ),
    },
  });
  return {
    auth,
    credentials: () => ({
      token: text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "",
      code: text.match(/\b(\d{6})\b/)?.[1] ?? "",
    }),
  };
}

describe("shared email login challenge", () => {
  it("atomically lets exactly one of simultaneous link and code redemption win", async () => {
    const { auth, credentials } = captureAuth();
    await auth.sendMagicLink("race@example.com", { tenantId: "tenant-a" });
    const { token, code } = credentials();

    const results = await Promise.all([
      auth.verifyMagicLink(token, "race@example.com", "tenant-a"),
      auth.verifyEmailLoginCode("race@example.com", code, "tenant-a"),
    ]);

    expect(results.filter((result) => result.valid)).toHaveLength(1);
    auth.destroy();
  });

  it("binds both credentials to normalized email and tenant", async () => {
    const { auth, credentials } = captureAuth();
    await auth.sendMagicLink("Bound@Example.com", { tenantId: "tenant-a" });
    const { token, code } = credentials();

    expect(
      await auth.verifyEmailLoginCode("bound@example.com", code, "tenant-b"),
    ).toMatchObject({
      valid: false,
    });
    expect(
      await auth.verifyMagicLink(token, "other@example.com", "tenant-a"),
    ).toMatchObject({
      valid: false,
    });
    auth.destroy();
  });

  it("normalizes mixed-case email before companion-code verification", async () => {
    const { auth, credentials } = captureAuth();
    await auth.sendMagicLink("Mixed.com", { tenantId: "tenant-a" });
    const { code } = credentials();
    expect(
      await auth.verifyEmailLoginCode("MIXED.COM", code, "tenant-a"),
    ).toMatchObject({
      valid: true,
      email: "mixed.com",
    });
    auth.destroy();
  });

  it("expires the link, code, and polling status on the same short TTL", async () => {
    const { auth, credentials } = captureAuth(10);
    const issued = await auth.sendMagicLink("ttl@example.com", {
      tenantId: "tenant-a",
    });
    const { token, code } = credentials();
    await Bun.sleep(20);

    expect(
      await auth.verifyMagicLink(token, "ttl@example.com", "tenant-a"),
    ).toMatchObject({
      valid: false,
    });
    expect(
      await auth.verifyEmailLoginCode("ttl@example.com", code, "tenant-a"),
    ).toMatchObject({
      valid: false,
    });
    expect(
      await auth.getEmailLoginStatus(issued.challengeId, issued.pollSecret),
    ).toEqual({
      status: "expired",
    });
    auth.destroy();
  });

  it("invalidates the prior challenge when the same target resends", async () => {
    const { auth, credentials } = captureAuth();
    const first = await auth.sendMagicLink("resend@example.com", {
      tenantId: "tenant-a",
    });
    const old = credentials();
    await auth.sendMagicLink("resend@example.com", { tenantId: "tenant-a" });

    expect(
      await auth.verifyMagicLink(old.token, "resend@example.com", "tenant-a"),
    ).toMatchObject({
      valid: false,
    });
    expect(
      await auth.verifyEmailLoginCode(
        "resend@example.com",
        old.code,
        "tenant-a",
      ),
    ).toMatchObject({
      valid: false,
    });
    expect(
      await auth.getEmailLoginStatus(first.challengeId, first.pollSecret),
    ).not.toMatchObject({
      status: "pending",
    });
    auth.destroy();
  });
});
