/**
 * Autofill whitelist default pack.
 *
 * Canonical source for the brand-domain whitelist. Exposes the list through
 * `getDefaultAutofillWhitelist()` so callers (autofill action effective-list
 * builder, the "already shipped" check) read from the pack registration.
 *
 * The list is the agent-side first gate before a request hits the browser
 * companion — unsafe domains are rejected even if the companion is
 * unreachable. Adding a domain is a literal-edit here.
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
