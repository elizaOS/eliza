/**
 * Application URL for SIWE domain validation and redirects.
 * WHY: SIWE EIP-4361 requires the message domain to match the relying party;
 * we use this as the canonical app origin (no trailing slash).
 *
 * NOTE for Cloudflare Worker callers: `process.env` is empty under Workers
 * (bindings live on `c.env`). Always pass the request env explicitly:
 * `getAppUrl(c.env)` / `getAppHost(c.env)`. The `process.env` default is only
 * appropriate for the browser bundle (Vite replaces `process.env.NEXT_PUBLIC_*`
 * at build time) and Node tests.
 */
import { ElizaError } from "@elizaos/core";

interface AppUrlEnv {
  NEXT_PUBLIC_APP_URL?: unknown;
  [key: string]: unknown;
}

const DEFAULT_APP_URL = "http://localhost:3000";
const EXPLICIT_SCHEME_PATTERN = /^([A-Za-z][A-Za-z\d+.-]*):/;
const HTTP_SCHEME_PATTERN = /^https?:\/\//i;

function invalidAppUrl(configured: string, reason: string): never {
  const explicitScheme = EXPLICIT_SCHEME_PATTERN.exec(configured)?.[1]?.toLowerCase();
  throw new ElizaError("NEXT_PUBLIC_APP_URL must identify a valid HTTP(S) application URL", {
    code: "INVALID_APP_URL",
    context: {
      reason,
      configuredLength: configured.length,
      explicitScheme: explicitScheme ?? null,
    },
    severity: "fatal",
  });
}

export function getAppUrl(env: AppUrlEnv = process.env): string {
  const configuredUrl =
    typeof env.NEXT_PUBLIC_APP_URL === "string" ? env.NEXT_PUBLIC_APP_URL.trim() : "";
  const value = configuredUrl || DEFAULT_APP_URL;
  const explicitScheme = EXPLICIT_SCHEME_PATTERN.test(value);

  if ((explicitScheme && !HTTP_SCHEME_PATTERN.test(value)) || value.startsWith("//")) {
    return invalidAppUrl(value, "unsupported-or-ambiguous-scheme");
  }

  const candidate = HTTP_SCHEME_PATTERN.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    // error-policy:J3 Invalid operator configuration fails closed without
    // retaining a parser error that can echo embedded credentials.
    return invalidAppUrl(value, "malformed-url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return invalidAppUrl(value, "unsupported-scheme");
  }
  if (!parsed.hostname) return invalidAppUrl(value, "missing-hostname");
  if (parsed.username || parsed.password) {
    return invalidAppUrl(value, "embedded-credentials");
  }

  return parsed.href.replace(/\/$/, "");
}

export function getAppHost(env: AppUrlEnv = process.env): string {
  return new URL(getAppUrl(env)).host;
}
