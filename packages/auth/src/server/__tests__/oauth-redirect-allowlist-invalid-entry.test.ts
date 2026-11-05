/**
 * An allowlist entry that is not a valid absolute URL (for example a typo in
 * STEWARD_OAUTH_ALLOWED_REDIRECTS such as `app.example.org/auth/callback`)
 * currently reads as "does not match", so the caller rejects with
 * "redirect_uri is not allowed for this tenant". That message blames the
 * request when the stored configuration is what cannot be parsed, and the real
 * fault never surfaces. A malformed entry can never match, so raising it once
 * nothing matched changes no accepted redirect.
 */
import { expect, mock, test } from "bun:test";

const dbModule = await import("../db/index.ts");
const actualDb = dbModule as Record<string, unknown>;

// The allowlist rows come from the shared DB client; the store is not what is
// under test here, so every query returns no rows.
mock.module("../db/index.ts", () => ({
  ...actualDb,
  getDb: () => ({ execute: async () => ({ rows: [] }) }),
}));

const ENV_KEYS = [
  "STEWARD_OAUTH_ALLOWED_REDIRECTS",
  "STEWARD_OAUTH_REDIRECT_ALLOWLIST",
] as const;

test("reports an unparseable allowlist entry instead of a policy denial", async () => {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    const { assertAllowedOAuthRedirectUri, OAuthRedirectAllowlistEntryError } =
      await import("../api/services/auth-lifecycle");

    // A malformed entry next to a valid one must not change an accepted
    // redirect: matching entries still win.
    process.env.STEWARD_OAUTH_ALLOWED_REDIRECTS =
      "https://app.example.org/auth/callback,app.example.org/other/callback";
    await expect(
      assertAllowedOAuthRedirectUri("https://app.example.org/auth/callback"),
    ).resolves.toBeInstanceOf(URL);

    // Nothing matches and the allowlist itself is unparseable: that is a
    // configuration fault, not a rejected redirect_uri.
    let thrown: unknown;
    try {
      await assertAllowedOAuthRedirectUri("https://evil.example.org/cb");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OAuthRedirectAllowlistEntryError);
    expect((thrown as Error).message).not.toContain(
      "redirect_uri is not allowed for this tenant",
    );

    // A parseable allowlist that simply does not list the URL keeps the
    // policy-denial error, and an empty allowlist keeps its own message.
    process.env.STEWARD_OAUTH_ALLOWED_REDIRECTS =
      "https://app.example.org/auth/callback";
    await expect(
      assertAllowedOAuthRedirectUri("https://evil.example.org/cb"),
    ).rejects.toThrow("redirect_uri is not allowed for this tenant");

    delete process.env.STEWARD_OAUTH_ALLOWED_REDIRECTS;
    await expect(
      assertAllowedOAuthRedirectUri("https://evil.example.org/cb"),
    ).rejects.toThrow("allowlist is not configured");
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
