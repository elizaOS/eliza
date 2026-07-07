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
 * password wall, when there is no cloud session, the wall stands.
 */

import { isDirectCloudSharedAgentBase } from "../api/client-cloud";
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
      /** Show the agent's internal password wall (no recovery available). */
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

const SHOW_WALL: AgentSessionRecoveryDecision = { action: "show-wall" };

/**
 * Extract the dedicated agent id from a persisted cloud runtime record. Prefers
 * the `cloud:<id>` id form written by `silentlyRepointToDedicated`, then falls
 * back to parsing the REST adapter base
 * (`<cloudApiBase>/api/v1/eliza/agents/<agentId>`), so older persisted records
 * without the id prefix still recover.
 */
export function resolveDedicatedAgentId(
  server: PersistedActiveServer,
): string | null {
  if (server.id.startsWith("cloud:")) {
    const id = server.id.slice("cloud:".length).trim();
    if (id) return id;
  }

  const base = server.apiBase?.trim();
  if (base) {
    const match = base.match(/\/api\/v1\/eliza\/agents\/([^/]+)(?:\/bridge)?\/?$/);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        // Malformed encoding, use the raw segment rather than dropping it.
        return match[1];
      }
    }
  }

  return null;
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
 * Otherwise the password wall is the honest, actionable state.
 */
export function resolveAgentSessionRecovery(
  input: AgentSessionRecoveryInput,
): AgentSessionRecoveryDecision {
  const { reason, activeServer, cloudToken, cloudApiBase, alreadyAttempted } =
    input;

  if (alreadyAttempted) return SHOW_WALL;

  // Only a rejected session/bearer is recoverable by re-pairing. When the host
  // never configured an owner password, re-pairing cannot manufacture one, so
  // keep the actionable setup wall.
  if (reason !== "remote_auth_required") return SHOW_WALL;

  if (!activeServer) return SHOW_WALL;

  // A cloud-managed dedicated agent: kind "cloud", OR a cloud REST adapter base.
  const isCloudManaged =
    activeServer.kind === "cloud" ||
    isDirectCloudSharedAgentBase(activeServer.apiBase);
  if (!isCloudManaged) return SHOW_WALL;

  // No cloud session means nothing to re-pair with, so the wall is honest.
  const token = cloudToken?.trim();
  if (!token) return SHOW_WALL;

  const agentId = resolveDedicatedAgentId(activeServer);
  if (!agentId) return SHOW_WALL;

  const base = cloudApiBase.trim();
  if (!base) return SHOW_WALL;

  return { action: "re-pair", agentId, cloudApiBase: base };
}
