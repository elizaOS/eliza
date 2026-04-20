/**
 * Agent-side copy of the autofill whitelist logic.
 *
 * Kept in sync with the browser extension's `autofill/whitelist.ts`. The
 * default list is duplicated intentionally — the extension reads its JSON
 * via an `import ... with { type: "json" }`, and we do not want the agent
 * process to reach into `apps/browser-extension-lifeops/` at runtime (that
 * would couple build boundaries in a way the project explicitly avoids).
 *
 * If the two lists drift, the source of truth for the extension's own
 * behavior remains the JSON file; the agent-side list is used for the
 * initial refusal decision that keeps credentials safe even if the
 * extension is unreachable.
 */

export const DEFAULT_AUTOFILL_WHITELIST: readonly string[] = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "google.com",
  "googlemail.com",
  "gmail.com",
  "microsoft.com",
  "live.com",
  "outlook.com",
  "office.com",
  "apple.com",
  "icloud.com",
  "stripe.com",
  "figma.com",
  "notion.so",
  "linear.app",
  "slack.com",
  "discord.com",
  "zoom.us",
  "dropbox.com",
  "box.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "reddit.com",
  "youtube.com",
  "bing.com",
  "duckduckgo.com",
  "amazon.com",
  "ebay.com",
  "shopify.com",
  "paypal.com",
  "wellsfargo.com",
  "chase.com",
  "bankofamerica.com",
  "citi.com",
  "1password.com",
  "proton.me",
  "protonmail.com",
  "anthropic.com",
  "openai.com",
  "cloudflare.com",
  "vercel.com",
  "netlify.com",
  "npmjs.com",
];

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
