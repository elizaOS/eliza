/**
 * W2-F — Autofill whitelist default pack.
 *
 * The 49 brand domains used to live as a literal in
 * `src/lifeops/autofill-whitelist.ts:7-55` (HARDCODING_AUDIT.md flagged this
 * as an inline-list smell). This module owns the canonical list and exposes
 * it through `getDefaultAutofillWhitelist()` so callers (autofill action
 * effective-list builder, the autofill action's "already shipped" check)
 * read from the pack registration instead of an inline literal.
 *
 * The list is the agent-side first gate before a request hits the browser
 * companion — unsafe domains are rejected even if the companion is
 * unreachable. Adding a domain is a literal-edit here, not a change to the
 * autofill-whitelist module.
 */

const DEFAULT_AUTOFILL_WHITELIST_DOMAINS: readonly string[] = [
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

/**
 * Default-pack accessor. Consumers (autofill action, whitelist resolver)
 * call this instead of importing the literal array.
 */
export function getDefaultAutofillWhitelist(): readonly string[] {
  return DEFAULT_AUTOFILL_WHITELIST_DOMAINS;
}
