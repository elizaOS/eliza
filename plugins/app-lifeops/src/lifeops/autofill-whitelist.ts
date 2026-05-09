/**
 * Agent-side autofill refusal list. This is the first gate before a request is
 * sent to the browser companion, so unsafe domains are rejected even if the
 * companion is unreachable.
 *
 * The 49 default brand domains live in
 * `src/default-packs/autofill-whitelist-pack.ts` (W2-F). This module re-exports
 * them as `DEFAULT_AUTOFILL_WHITELIST` so callers don't need to know about the
 * pack — adding a default domain is a literal-edit in the pack file, not here.
 */

import { getDefaultAutofillWhitelist } from "../default-packs/autofill-whitelist-pack.js";

export const DEFAULT_AUTOFILL_WHITELIST: readonly string[] =
  getDefaultAutofillWhitelist();

export function extractRegistrableDomain(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  let host: string;
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return null;
    }
  } else {
    host = trimmed.replace(/^\/+/, "").split("/")[0] ?? "";
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return null;
  if (host === "localhost") return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  if (host.startsWith("[") && host.endsWith("]")) return null;
  const labels = host.split(".").filter((l) => l.length > 0);
  if (labels.length < 2) return null;
  return labels.slice(-2).join(".");
}

export function normalizeAutofillDomain(input: string): string | null {
  return extractRegistrableDomain(input);
}

export interface WhitelistCheckResult {
  readonly allowed: boolean;
  readonly registrableDomain: string | null;
  readonly matched: string | null;
}

export function isUrlWhitelisted(
  url: string,
  domains: readonly string[],
): WhitelistCheckResult {
  const registrable = extractRegistrableDomain(url);
  if (registrable === null) {
    return { allowed: false, registrableDomain: null, matched: null };
  }
  let host: string = registrable;
  if (/^[a-z]+:\/\//i.test(url)) {
    try {
      host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      return { allowed: false, registrableDomain: null, matched: null };
    }
  } else {
    host = url.trim().toLowerCase().split("/")[0] ?? registrable;
  }
  for (const raw of domains) {
    const entry = normalizeAutofillDomain(raw);
    if (!entry) continue;
    if (host === entry || host.endsWith(`.${entry}`)) {
      return { allowed: true, registrableDomain: registrable, matched: entry };
    }
  }
  return { allowed: false, registrableDomain: registrable, matched: null };
}
