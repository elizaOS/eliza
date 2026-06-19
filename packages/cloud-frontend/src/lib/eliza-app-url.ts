/**
 * Canonical URL of the Eliza agent app — the chat / agent experience deployed
 * as a SEPARATE Cloudflare Pages project (`eliza-app`) at its own subdomain
 * (app.elizacloud.ai in prod, app-staging.elizacloud.ai in staging). This
 * console (the lander + dashboard at the apex) links OUT to it for "open / talk
 * to your agent". The Steward session cookie is scoped to the parent
 * `.elizacloud.ai` zone (see cloud-shared `auth/cookie-domain.ts`), so the user
 * lands on the app already authenticated.
 *
 * Read env vars by their LITERAL name — Vite only inlines `import.meta.env.X`
 * for literal accesses; dynamic `env[name]` lookups return undefined in prod
 * builds (see cloud-frontend AGENTS.md).
 */
export function getElizaAppUrl(): string {
  const explicit = import.meta.env.VITE_ELIZA_APP_URL;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit.replace(/\/$/, "");
  }
  // Fall back to the per-environment default so the link is correct even if the
  // build forgot to pass VITE_ELIZA_APP_URL.
  return import.meta.env.VITE_ENVIRONMENT === "staging"
    ? "https://app-staging.elizacloud.ai"
    : "https://app.elizacloud.ai";
}
