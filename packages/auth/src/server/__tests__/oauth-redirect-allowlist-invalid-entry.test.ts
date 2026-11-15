/**
 * An allowlist entry that is not a valid absolute URL (for example a typo in
 * STEWARD_OAUTH_ALLOWED_REDIRECTS such as `app.example.org/auth/callback`)
 * currently reads as "does not match", so the caller rejects with
 * "redirect_uri is not allowed for this tenant". That message blames the
 * request when the stored configuration is what cannot be parsed, and the real
 * fault never surfaces. A malformed entry can never match, so raising it once
 * nothing matched changes no accepted redirect.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { createPGLiteDb } from "../db/pglite.ts";

let database: Awaited<ReturnType<typeof createPGLiteDb>>;
const databaseEnvironment = new Map<string, string | undefined>();
beforeAll(async () => {
  for (const [key, value] of Object.entries({
    NODE_ENV: "test",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
  })) {
    databaseEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
  const { createPGLiteDb } = await import("../db/pglite.ts");
  const { setPGLiteOverride } = await import("../db/client.ts");
  database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
}, 60_000);
afterAll(async () => {
  if (database) await database.client.close();
  for (const [key, value] of databaseEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

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

  const { logger } = await import("@elizaos/core");
  const warnings = spyOn(logger, "warn");
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
    expect(JSON.stringify(thrown)).not.toContain(
      "app.example.org/other/callback",
    );
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(
      "app.example.org/other/callback",
    );
    expect(warnings).toHaveBeenCalledWith(
      { code: "OAUTH_REDIRECT_ALLOWLIST_ENTRY_INVALID" },
      "OAuth redirect_uri allowlist contains an unparseable entry",
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
    warnings.mockRestore();
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
