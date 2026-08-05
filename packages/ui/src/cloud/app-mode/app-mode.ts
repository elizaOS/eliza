/**
 * App-mode: hostname detection and entry-routing decisions for the Eliza app
 * hosts (app.elizacloud.ai / app-staging.elizacloud.ai). The same packages/app
 * bundle serves the apex console AND the app hosts; on the app hosts the entry
 * must BECOME the product — a signed-in visitor is routed straight into their
 * dedicated agent's own web UI via the pairing-token flow instead of landing in
 * the generic same-origin shell.
 *
 * Every app-mode hostname check lives here (mirroring `../shell/apex-host.ts`
 * for the apex set); never scatter `window.location.hostname` comparisons —
 * import {@link isAppModeHost}. Consumed by the cloud router shell's catch-all
 * (`AppCatchAllRoute`) and the {@link AppModeEntryRoute} gate; the apex check
 * runs first there, so apex behavior can never be affected by this module.
 */

import type {
  AgentExecutionTier,
  AgentSandboxStatus,
  IsoDateString,
} from "@elizaos/cloud-shared/lib/types/cloud-api";
import { apiWithStatus } from "../lib/api-client";

/** Production + staging Eliza app hosts (the staging Pages deploy serves the
 * identical bundle on `app-staging.*`, so staging must mirror prod behavior). */
export const APP_MODE_HOSTNAMES: ReadonlySet<string> = new Set([
  "app.elizacloud.ai",
  "app-staging.elizacloud.ai",
]);

/** Dev-only app-mode emulation: the app hosts are never `localhost`, so the
 * entry routing is otherwise untestable in `vite dev`. Vite inlines the env
 * read on literal access; production builds ship without the flag. Mirrors
 * `VITE_FORCE_APEX_CONSOLE` in `../shell/apex-host.ts`. */
function readAppModeDevFlag(): boolean {
  return import.meta.env?.VITE_FORCE_APP_MODE === "true";
}

/**
 * Pure hostname decision, exposed for the test matrix. `devFlag` defaults to
 * the Vite env escape hatch; tests inject it explicitly.
 */
export function isAppModeHostname(
  hostname: string,
  devFlag: boolean = readAppModeDevFlag(),
): boolean {
  if (devFlag) return true;
  return APP_MODE_HOSTNAMES.has(hostname.toLowerCase());
}

/** True when the current document is served in app-mode. No-DOM (SSR /
 * prerender / native) → false, so server and native builds never branch. */
export function isAppModeHost(): boolean {
  if (typeof window === "undefined") return false;
  return isAppModeHostname(window.location.hostname);
}

/** Minimal structural slice of `AgentListItemDto` the routing decision needs
 * (assignable from the full DTO; test fixtures stay small). */
export interface AppModeAgent {
  id: string;
  agentName: string | null;
  status: AgentSandboxStatus;
  executionTier: AgentExecutionTier;
  lastHeartbeatAt: IsoDateString | null;
  updatedAt: IsoDateString;
}

/** Where the instances console lives — the resume / manage surface. A
 * registered cloud route, reachable on every host. */
export const APP_MODE_INSTANCES_PATH = "/dashboard/agents";
/** The deploy-first-agent flow: `/join` select-or-provisions a Cloud agent and
 * drops the user straight into chat. */
export const APP_MODE_CREATE_PATH = "/join";

export type AppModeRoute =
  /** Exactly one running dedicated agent — straight into its web UI via pairing. */
  | { kind: "enter-agent"; agent: AppModeAgent }
  /** Several running dedicated agents — minimal chooser, most recent first. */
  | { kind: "choose-agent"; running: AppModeAgent[] }
  /** Dedicated agents exist but none running — Instances, resume from there. */
  | { kind: "resume"; to: string }
  /** No agents at all — the `/join` deploy-first-agent flow. */
  | { kind: "create"; to: string }
  /** Only shared-tier agents (no per-agent web UI to pair into) — the existing
   * same-origin chat app stays their home, exactly as before app-mode. */
  | { kind: "chat-home" };

function activityStamp(agent: AppModeAgent): number {
  const stamp = Date.parse(agent.lastHeartbeatAt ?? agent.updatedAt);
  return Number.isNaN(stamp) ? 0 : stamp;
}

/**
 * Given the org's agents (GET /api/v1/eliza/agents), decide where app-mode
 * entry lands. Only dedicated-capable tiers (everything but `"shared"`) are
 * pairing candidates: shared-tier agents serve chat through the control-plane
 * REST adapter and have no per-agent subdomain to redirect into, so a
 * shared-only org keeps the same-origin chat app ({@link AppModeRoute}
 * `chat-home`) instead of a pairing call that cannot succeed.
 */
export function decideAppModeRoute(
  agents: readonly AppModeAgent[],
): AppModeRoute {
  const dedicated = agents.filter((a) => a.executionTier !== "shared");
  const running = dedicated
    .filter((a) => a.status === "running")
    .sort((a, b) => activityStamp(b) - activityStamp(a));

  if (running.length === 1) return { kind: "enter-agent", agent: running[0] };
  if (running.length > 1) return { kind: "choose-agent", running };
  if (dedicated.length > 0)
    return { kind: "resume", to: APP_MODE_INSTANCES_PATH };
  if (agents.length > 0) return { kind: "chat-home" };
  return { kind: "create", to: APP_MODE_CREATE_PATH };
}

/**
 * Indirection over `window.location.assign` so tests can observe the redirect
 * (jsdom forbids stubbing `location.assign` directly).
 */
export const appModeNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
  replace(url: string): void {
    window.location.replace(url);
  },
};

export type PairingRedirectResult =
  | { ok: true; redirectUrl: string }
  /** 202 — the agent must resume first; the server has queued the wake. */
  | { ok: false; starting: true }
  | { ok: false; starting: false; error: string };

function pairingErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null) {
    const body = payload as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
    if (typeof body.message === "string" && body.message) return body.message;
  }
  return `Failed to generate pairing token (HTTP ${status})`;
}

/**
 * Send the user INTO a dedicated agent's web UI with a FULL-PAGE redirect.
 *
 * Same pairing-token endpoint as `openWebUIWithPairing`
 * (`../instances/lib/open-web-ui.ts`) but via `window.location.assign` instead
 * of a popup: automatic entry runs outside a click handler, where popups are
 * blocked and full-page navigation is not. Rides {@link apiWithStatus} — the
 * canonical status-branching transport for endpoints whose HTTP status IS the
 * protocol (202 = "agent must resume first") — so auth (steward cookie +
 * Bearer) matches every other cloud call.
 */
export async function redirectToAgentWebUI(
  agentId: string,
  /**
   * Automatic entry replaces the gate in history: the gate page is a
   * transient "connecting" state, and leaving it in history traps the user
   * (Back from the agent UI re-enters the gate, which mints another one-time
   * pairing token and bounces forward again). An explicit chooser click is a
   * real navigation the user should be able to back out of.
   */
  navigation: "automatic" | "user-initiated" = "automatic",
): Promise<PairingRedirectResult> {
  try {
    const { status, data } = await apiWithStatus<unknown>(
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/pairing-token`,
      { method: "POST" },
    );

    if (status === 202) {
      return { ok: false, starting: true };
    }

    if (status < 200 || status >= 300) {
      return {
        ok: false,
        starting: false,
        error: pairingErrorMessage(data, status),
      };
    }

    const redirectUrl =
      typeof data === "object" && data !== null
        ? (data as { data?: { redirectUrl?: unknown } }).data?.redirectUrl
        : undefined;
    if (typeof redirectUrl !== "string" || !redirectUrl) {
      return {
        ok: false,
        starting: false,
        error: "No redirect URL returned from the pairing endpoint",
      };
    }

    if (navigation === "automatic") {
      appModeNavigation.replace(redirectUrl);
    } else {
      appModeNavigation.assign(redirectUrl);
    }
    return { ok: true, redirectUrl };
  } catch (err) {
    // error-policy:J4 network/transport failure becomes the gate's visibly
    // distinct "connection failed" state with an escape to Instances — the
    // entry must degrade to a navigable screen, never rethrow into a blank one.
    return {
      ok: false,
      starting: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
