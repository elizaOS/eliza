/**
 * App-mode: hostname detection and entry-routing decisions for the Eliza app
 * hosts (cloud.eliza.app / cloud-staging.eliza.app). The same packages/app
 * bundle serves the apex console AND the app hosts; on the app hosts the
 * same-origin chat app IS the product, so entry always lands there (the
 * "chat floor"): signed-in visitors get the chat app immediately, and the only
 * entry navigation left is the `/join` deploy-first-agent flow for an org with
 * no agents at all.
 *
 * Entry deliberately performs NO pairing redirect into a per-agent web UI.
 * The previous entry gate minted a one-time pairing token (60s TTL) and
 * full-page-redirected into `<agentId>.cloud.eliza.app/pair?token=…` whenever the
 * org had a running dedicated agent. A dedicated container that is cold
 * starting (or `running` in the DB but not yet serving) cannot consume the
 * token inside its TTL, so entry dead-ended on the agent's "Sign-in link
 * expired" page — a guaranteed trap on every cold start. Until pairing is
 * re-introduced as a health-gated background hop (probe the agent, mint the
 * token only once the agent is confirmed consuming), entering a dedicated
 * agent's own web UI stays an explicit user action (the Instances console's
 * "Open Web UI"), never an entry-time redirect.
 *
 * Every app-mode hostname check lives here (mirroring `../shell/apex-host.ts`
 * for the apex set); never scatter `window.location.hostname` comparisons —
 * import {@link isAppModeHost}. Consumed by the cloud router shell's catch-all
 * (`AppCatchAllRoute`) and the {@link AppModeEntryRoute} gate; the apex check
 * runs first there, so apex behavior can never be affected by this module.
 */

import {
  classifyElizaHostname,
  ELIZA_DOMAIN_CONTRACTS,
  LEGACY_ELIZA_DOMAIN_CONTRACTS,
} from "@elizaos/shared";

/** Production + staging Eliza app hosts (the staging Pages deploy serves the
 * identical bundle on `app-staging.*`, so staging must mirror prod behavior). */
export const APP_MODE_HOSTNAMES: ReadonlySet<string> = new Set([
  new URL(ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin).hostname,
  new URL(ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin).hostname,
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.cloudAppHostnames,
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.cloudAppHostnames,
]);

/** Trusted apex-console → app-host pairing for cross-origin product entry. */
export function appModeOriginForApexHostname(hostname: string): string | null {
  const classified = classifyElizaHostname(hostname);
  if (
    classified.role !== "marketing" &&
    classified.role !== "legacy-marketing"
  ) {
    return null;
  }
  return classified.environment
    ? ELIZA_DOMAIN_CONTRACTS[classified.environment].cloudAppOrigin
    : null;
}

/** Dev-only app-mode emulation: the app hosts are never `localhost`, so the
 * entry routing is otherwise untestable in `vite dev`. Vite inlines the env
 * read on literal access, and production-mode packages/app builds REFUSE to
 * bake the flag (`packages/app/scripts/forced-host-mode-guard.mjs` throws at
 * build time), so it can never reach a deployed bundle. Mirrors
 * `VITE_FORCE_APEX_CONSOLE` in `../shell/apex-host.ts`. */
function readAppModeDevFlag(): boolean {
  return import.meta.env?.VITE_FORCE_APP_MODE === "true";
}

/**
 * Pure hostname decision, exposed for the test matrix. `devFlag` defaults to
 * the Vite env escape hatch; tests inject it explicitly.
 *
 * Normalizes here rather than at the call sites: a browser may report the
 * hostname with a fully-qualified trailing dot or mixed case, and both are the
 * same host. Callers pass `window.location.hostname` (or a URL hostname)
 * straight through — this module owns the comparison so no caller has to
 * remember the normalization.
 */
export function isAppModeHostname(
  hostname: string,
  devFlag: boolean = readAppModeDevFlag(),
): boolean {
  if (devFlag) return true;
  return APP_MODE_HOSTNAMES.has(
    hostname.trim().toLowerCase().replace(/\.$/, ""),
  );
}

/** True when the current document is served in app-mode. No-DOM (SSR /
 * prerender / native) → false, so server and native builds never branch. */
export function isAppModeHost(): boolean {
  if (typeof window === "undefined") return false;
  return isAppModeHostname(window.location.hostname);
}

/** Minimal structural slice of `AgentListItemDto` the routing decision needs
 * (assignable from the full DTO; test fixtures stay small). The lifecycle
 * fields are retained for the planned health-gated background pairing layer;
 * the entry decision itself only branches on org emptiness. */
export interface AppModeAgent {
  id: string;
  agentName: string | null;
  status: string;
  executionTier: string;
  lastHeartbeatAt: string | null;
  updatedAt: string;
}

/** The deploy-first-agent flow: `/join` select-or-provisions a Cloud agent and
 * drops the user straight into chat. */
export const APP_MODE_CREATE_PATH = "/join";

export type AppModeRoute =
  /** No agents at all — the `/join` deploy-first-agent flow. */
  | { kind: "create"; to: string }
  /** The org has agents (any tier, any lifecycle state) — the same-origin
   * chat app is home. This is the chat floor: entry never bounces to the
   * console and never pairing-redirects into a per-agent web UI, because a
   * cold-starting agent cannot consume a 60s one-time pairing token and the
   * redirect dead-ends on "Sign-in link expired" (the app-staging cold-start
   * regression this floor exists for). */
  | { kind: "chat-home" };

/**
 * Given the org's agents (GET /api/v1/eliza/agents), decide where app-mode
 * entry lands: any agents → the same-origin chat app; none → `/join`.
 *
 * The chat app serves every tier the same way at entry. Shared-tier agents
 * chat through the control-plane REST adapter; dedicated agents chat through
 * the same-origin surface too, regardless of whether their container is
 * running, starting, stopped, or errored — a non-running container has no
 * reachable web UI, and a "running" one may still be cold, so no lifecycle
 * state makes an entry-time redirect safe. Entering the per-agent web UI is
 * an explicit user action from the Instances console.
 */
export function decideAppModeRoute(
  agents: readonly AppModeAgent[],
): AppModeRoute {
  if (agents.length > 0) return { kind: "chat-home" };
  return { kind: "create", to: APP_MODE_CREATE_PATH };
}

/**
 * Indirection over `window.location.assign` so tests can observe redirects
 * (jsdom forbids stubbing `location.assign` directly). Used by the SSO bridge
 * (`../sso-bridge/sso-bridge`) for its full-page bounce.
 */
export const appModeNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
  replace(url: string): void {
    window.location.replace(url);
  },
};
