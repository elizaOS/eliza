/**
 * Shared Playwright auth seed helpers for UI smoke tests. Keeping the Steward
 * session key and token shape here prevents cloud/onboarding/mobile specs from
 * each inventing their own localStorage contract, which is how the Android
 * auth summary drift escaped review.
 */
import type { Page } from "@playwright/test";

export const STEWARD_SESSION_TOKEN_KEY = "steward_session_token";
export const UI_SMOKE_STEWARD_OPAQUE_TOKEN = "ui-smoke-onboarding-cloud-token";

type StewardSessionOptions = {
  token?: string;
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
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: STEWARD_SESSION_TOKEN_KEY, value: token },
  );
  return token;
}

/** Set the same canonical steward-session key after the page has loaded. */
export async function setStewardSession(
  page: Page,
  opts: StewardSessionOptions = {},
): Promise<string> {
  const token = createStewardSessionToken(opts);
  await page.evaluate(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: STEWARD_SESSION_TOKEN_KEY, value: token },
  );
  return token;
}
