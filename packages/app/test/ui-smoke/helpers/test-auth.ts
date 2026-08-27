/**
 * Shared Playwright auth seed helpers for UI smoke tests. Keeping the Steward
 * session keys and token shape here prevents cloud/onboarding/mobile specs
 * from each inventing their own localStorage contract, which is how the
 * Android auth summary drift escaped review.
 */
import type { Page } from "@playwright/test";

export const STEWARD_SESSION_TOKEN_KEY = "steward_session_token";
export const STEWARD_SESSION_TOKEN_SCOPE_KEY = "steward_session_token_scope";
export const UI_SMOKE_DEFAULT_STEWARD_SCOPE = "eliza-cloud:production";
export const UI_SMOKE_STEWARD_OPAQUE_TOKEN = "ui-smoke-onboarding-cloud-token";

type StewardSessionOptions = {
  token?: string;
  scope?: string;
  jwt?: boolean;
  subject?: string;
  userId?: string;
  email?: string;
  exp?: number;
};

function base64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Unsigned-but-decodable Steward JWT for renderer tests that exercise JWT shape. */
export function createStewardSessionToken(
  opts: StewardSessionOptions = {},
): string {
  if (opts.token) return opts.token;
  if (!opts.jwt) return UI_SMOKE_STEWARD_OPAQUE_TOKEN;

  const subject = opts.subject ?? "ui-smoke-user";
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      sub: subject,
      userId: opts.userId ?? subject,
      email: opts.email ?? "qa@example.test",
      exp: opts.exp ?? 4102444800, // 2100-01-01, fresh enough to avoid refresh.
    }),
  );
  return `${header}.${payload}.unsigned`;
}

/** Seed before React boots. Use `setStewardSession` after the page has loaded. */
export async function seedStewardSession(
  page: Page,
  opts: StewardSessionOptions = {},
): Promise<string> {
  const token = createStewardSessionToken(opts);
  const scope = opts.scope ?? UI_SMOKE_DEFAULT_STEWARD_SCOPE;
  await page.addInitScript(
    ({ key, scopeKey, value, scope }) => {
      window.localStorage.setItem(key, value);
      window.localStorage.setItem(scopeKey, scope);
    },
    {
      key: STEWARD_SESSION_TOKEN_KEY,
      scopeKey: STEWARD_SESSION_TOKEN_SCOPE_KEY,
      value: token,
      scope,
    },
  );
  return token;
}

/** Set the same canonical Steward session pair after the page has loaded. */
export async function setStewardSession(
  page: Page,
  opts: StewardSessionOptions = {},
): Promise<string> {
  const token = createStewardSessionToken(opts);
  const scope = opts.scope ?? UI_SMOKE_DEFAULT_STEWARD_SCOPE;
  await page.evaluate(
    ({ key, scopeKey, value, scope }) => {
      window.localStorage.setItem(key, value);
      window.localStorage.setItem(scopeKey, scope);
    },
    {
      key: STEWARD_SESSION_TOKEN_KEY,
      scopeKey: STEWARD_SESSION_TOKEN_SCOPE_KEY,
      value: token,
      scope,
    },
  );
  return token;
}
