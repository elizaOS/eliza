/**
 * Post-upgrade agent-session recovery (#15132).
 *
 * When a dedicated cloud agent's container is upgraded (blue/green recreate,
 * fleet-upgrade #15101), the browser's persisted agent credential belongs to
 * the OLD container. Every agent-subdomain call then 401s and the top-level
 * auth gate would render the agent runtime's internal "Sign in with your
 * password" wall, a credential no cloud user possesses. With a valid cloud
 * session sitting right there, that wall is a terminal dead-end.
 *
 * This module makes the ROUTING decision: given the 401 reason, the active
 * runtime, and whether a cloud session exists, should the client transparently
 * re-run the pairing/token-swap (the same flow first-pairing uses) to refresh
 * the persisted agent credential, or is the password wall the honest state
 * (self-hosted direct access with no cloud session to re-pair from)?
 *
 * SECURITY NOTE (auth-adjacent): this weakens nothing. Re-pairing exchanges an
 * EXISTING valid cloud session for a fresh agent credential via the same
 * server-side pairing exchange that first-pairing uses. It never bypasses the
 * authentication boundary: without a valid Cloud credential the managed
 * native app asks the user to reauthenticate with Cloud, while self-hosted
 * access keeps the owner-password wall.
 */

import { isDirectCloudSharedAgentBase } from "../api/client-cloud";
import {
  dedicatedCloudAgentIdFromBase,
  ELIZA_CLOUD_CONTROL_PLANE_HOSTS,
} from "../utils/cloud-agent-base";
import type { PersistedActiveServer } from "./persistence";

/**
 * A 401 reason from `/api/auth/me`. `remote_auth_required` means the session /
 * bearer was rejected (the stale-credential case we can recover). undefined is
 * the generic unauthenticated state.
 */
export type AgentSessionUnauthReason =
  | "remote_auth_required"
  | "remote_password_not_configured"
  | undefined;

export type ManagedCloudAgentRecoveryStatus =
  | "cloud-reauth-required"
  | "cloud-retry-required"
  | "cloud-manage-required";

export type AgentSessionRecoveryDecision =
  | {
      /** Re-run the cloud pairing exchange to refresh the stale credential. */
      action: "re-pair";
      /** The dedicated agent to re-pair with. */
      agentId: string;
      /** Cloud control-plane base the pairing-token endpoint lives on. */
      cloudApiBase: string;
    }
  | {
      /**
       * No transparent recovery is available. The caller maps this legacy
       * action to Cloud reauth for managed native targets or the owner-password
       * wall for self-hosted targets.
       */
      action: "show-wall";
    };

export interface AgentSessionRecoveryInput {
  /** The `/api/auth/me` 401 reason that triggered the unauthenticated state. */
  reason: AgentSessionUnauthReason;
  /** The currently-active runtime, or null when none is persisted. */
  activeServer: PersistedActiveServer | null;
  /**
   * The current cloud session token (Steward JWT), or null when the browser has
   * no cloud session. `getCloudAuthToken()` is the canonical resolver.
   */
  cloudToken: string | null;
  /** Cloud control-plane base URL (boot config `cloudApiBase`). */
  cloudApiBase: string;
  /**
   * True once a recovery attempt has already run this cycle. Prevents an
   * infinite re-pair/401 loop when re-pairing itself fails, fall through to
   * the wall so the user gets an actionable surface instead of a spinner.
   */
  alreadyAttempted: boolean;
}

function isManagedCloudSharedAgentBase(
  apiBase: string | null | undefined,
): boolean {
  const normalized = apiBase?.trim();
  if (!normalized || !isDirectCloudSharedAgentBase(normalized)) return false;
  try {
    const url = new URL(normalized);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    // error-policy:J3 malformed persisted URLs fail closed as self-hosted.
    return false;
  }
}

/** Whether a persisted runtime is owned by managed Eliza Cloud. */
export function isManagedCloudAgentServer(
  activeServer: PersistedActiveServer | null,
): boolean {
  return Boolean(
    activeServer &&
      (activeServer.kind === "cloud" ||
        isManagedCloudSharedAgentBase(activeServer.apiBase)),
  );
}

/**
 * Managed native Cloud targets must recover through Cloud; they never expose
 * the dedicated runtime's owner-password wall, which Cloud users cannot use.
 */
export function shouldShowCloudAgentReauthNotice(input: {
  isHostedLocation: boolean;
  isNative: boolean;
  activeServer: PersistedActiveServer | null;
  recoveryStatus?: ManagedCloudAgentRecoveryStatus | null;
}): boolean {
  return (
    input.isHostedLocation ||
    Boolean(input.recoveryStatus) ||
    isManagedCloudAgentServer(input.activeServer)
  );
}

const SHOW_WALL: AgentSessionRecoveryDecision = { action: "show-wall" };

/**
 * Extract the dedicated agent id from an API base alone: the
 * `<agentId>.cloud.eliza.app` subdomain form first, then the REST adapter base
 * (`<cloudApiBase>/api/v1/eliza/agents/<agentId>`). Shared by the persisted
 * active-server resolver below and the credential-scoped purge
 * (cloud-pair-token), which must match agent profiles that carry only a base.
 */
export function dedicatedAgentIdFromApiBase(
  apiBase: string | null | undefined,
): string | null {
  const base = apiBase?.trim();
  if (!base) return null;

  const subdomainAgentId = dedicatedCloudAgentIdFromBase(base);
  if (subdomainAgentId) return subdomainAgentId;

  const match = base.match(
    /\/api\/v1\/eliza\/agents\/([^/]+)(?:\/bridge)?\/?$/,
  );
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      // error-policy:J3 malformed persisted encoding keeps the validated raw
      // path segment rather than dropping the recoverable agent identity.
      return match[1];
    }
  }

  return null;
}

/**
 * Extract the dedicated agent id from a persisted cloud runtime record. Prefers
 * the `cloud:<id>` id form written by `silentlyRepointToDedicated`, then falls
 * back to parsing the API base, so older persisted records without the id
 * prefix still recover.
 */
export function resolveDedicatedAgentId(
  server: PersistedActiveServer,
): string | null {
  if (server.id.startsWith("cloud:")) {
    const id = server.id.slice("cloud:".length).trim();
    if (id) return id;
  }

  return dedicatedAgentIdFromApiBase(server.apiBase);
}

/**
 * Decide how to handle an agent-subdomain 401 at the top-level auth gate.
 *
 * Re-pair ONLY when ALL hold:
 *   - the 401 is `remote_auth_required` (a rejected session/bearer, the
 *     stale-credential case; NOT `remote_password_not_configured`, which
 *     re-pairing cannot satisfy),
 *   - the active runtime is a cloud-managed dedicated agent,
 *   - a cloud session token exists to re-pair from, and
 *   - we have not already tried this cycle.
 *
 * Otherwise no transparent repair is available; the caller chooses the
 * platform-appropriate reauthentication surface.
 */
export function resolveAgentSessionRecovery(
  input: AgentSessionRecoveryInput,
): AgentSessionRecoveryDecision {
  const { reason, activeServer, cloudToken, cloudApiBase, alreadyAttempted } =
    input;

  if (alreadyAttempted) return SHOW_WALL;

  // Only a rejected session/bearer is recoverable by re-pairing. When the host
  // never configured an owner password, re-pairing cannot manufacture one;
  // callers keep the self-hosted setup wall or route managed native users to
  // Cloud management.
  if (reason !== "remote_auth_required") return SHOW_WALL;

  if (!activeServer) return SHOW_WALL;

  // A cloud-managed dedicated agent: kind "cloud", OR a cloud REST adapter base.
  if (!isManagedCloudAgentServer(activeServer)) return SHOW_WALL;

  // No cloud session means nothing to re-pair with transparently.
  const token = cloudToken?.trim();
  if (!token) return SHOW_WALL;

  const agentId = resolveDedicatedAgentId(activeServer);
  if (!agentId) return SHOW_WALL;

  const base = cloudApiBase.trim();
  if (!base) return SHOW_WALL;

  return { action: "re-pair", agentId, cloudApiBase: base };
}

/**
 * True when the unauthenticated state is re-pair-shaped in EVERY dimension
 * except the presence of an app-origin cloud token: a `remote_auth_required`
 * 401 on a cloud-managed dedicated agent with a resolvable agent id and cloud
 * base, but no cloud session token in this origin's mirror.
 *
 * This is the exact state a returning PWA user hits on a cold agent-subdomain
 * relaunch: they ARE signed in to Eliza Cloud (shared HttpOnly cookie) but the
 * app-origin localStorage mirror is empty, so `resolveAgentSessionRecovery`
 * reads `show-wall` and the user dead-ends at the "Re-open from Eliza Cloud"
 * notice. When this predicate holds, the caller should attempt a silent
 * cookie→session refresh and, if it yields a token, re-run the resolver, which
 * will then return `re-pair`. When it does NOT hold, no refresh can help and
 * the wall/notice is honest.
 *
 * SECURITY (auth-adjacent): a positive answer authorizes only a cookie-backed
 * session REFRESH (an existing server-validated session), never a bypass. The
 * refresh still fails closed when no cookie/valid session exists.
 */
export function agentSessionRepairNeedsCloudToken(
  input: AgentSessionRecoveryInput,
): boolean {
  const { reason, activeServer, cloudToken, cloudApiBase, alreadyAttempted } =
    input;

  if (alreadyAttempted) return false;
  if (reason !== "remote_auth_required") return false;
  if (!activeServer) return false;

  if (!isManagedCloudAgentServer(activeServer)) return false;

  // The token is the ONLY missing piece — a present token is already handled by
  // `resolveAgentSessionRecovery` returning `re-pair`, so this predicate is for
  // the missing-token case specifically.
  if (cloudToken?.trim()) return false;

  if (!resolveDedicatedAgentId(activeServer)) return false;
  if (!cloudApiBase.trim()) return false;

  return true;
}
