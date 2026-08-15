/**
 * Silently repoints the app at a provisioned cloud runtime, preserving a
 * personal logical identity when the runtime is its Dedicated target.
 */
import { client } from "../../api";
import {
  createPersistedActiveServer,
  savePersistedActiveServer,
  upsertAndActivateAgentProfile,
} from "../../state";
import { clearPendingCloudHandoff } from "./pending-handoff-store";

/**
 * Silently re-point the live client from the shared bridge to the dedicated
 * agent — the handoff's "invisible switch".
 *
 * This is the handoff-ONLY alternative to `switchAgentProfile`. The global
 * profile switch (`AppContext.tsx`) intentionally:
 *   - `clearAllChatDrafts()` — wipes the composer (conversation ids are
 *     per-account, so a manual account switch can't carry a draft over), and
 *   - dispatches `SWITCH_AGENT` — which re-enters the startup coordinator
 *     (`ready → polling-backend`), a phase that is NOT shell-paintable, so
 *     `App.tsx` swaps the whole shell for `<StartupScreen/>` (the full-screen
 *     flash).
 * Both are correct for a manual switch but WRONG for the handoff: the dedicated
 * agent already holds the copied transcript on the SAME conversation id, the
 * user is mid-conversation, and the composer may hold an unsent draft. So the
 * handoff re-points in place instead:
 *   - persist the serving runtime on the same logical profile (so a reboot
 *     restores Dedicated without inventing a second personal identity),
 *   - re-point the API/WS base seamlessly via `client.repointBaseUrl` (which
 *     reconnects the WS in place — no visible drop, no coordinator re-entry),
 *   - set the bearer token,
 * and DELIBERATELY does NOT clear drafts and does NOT dispatch `SWITCH_AGENT`.
 * The chat surface stays mounted on the same conversation id throughout.
 */
export function silentlyRepointToDedicated(opts: {
  /** The dedicated agent's container base (REST + WS host). */
  containerBase: string;
  /** Bearer token (Steward JWT) — same one the shared bridge used. */
  authToken: string;
  /** The dedicated agent id — persisted so a reboot restores the dedicated. */
  dedicatedAgentId: string;
  /** Stable rowless identity retained while the active runtime changes. */
  personalElizaId?: string;
}): void {
  const { containerBase, authToken, dedicatedAgentId, personalElizaId } = opts;
  const logicalAgentId = personalElizaId ?? dedicatedAgentId;

  // Keep the account-native identity stable while storing the serving runtime
  // explicitly. A reboot restores Dedicated without turning its container UUID
  // into a second personal Eliza in the runtime chooser.
  const server = createPersistedActiveServer({
    kind: "cloud",
    id: `cloud:${logicalAgentId}`,
    apiBase: containerBase,
    accessToken: authToken,
    cloudRuntimeAgentId: dedicatedAgentId,
    cloudRuntime: "dedicated",
  });
  savePersistedActiveServer(server);

  // Register + activate the dedicated profile WITHOUT going through
  // switchAgentProfile (which would clear drafts + dispatch SWITCH_AGENT).
  // Identity-based upsert keeps the original personal profile rather than
  // accumulating one Shared row and one Dedicated row for the same Eliza.
  upsertAndActivateAgentProfile({
    kind: "cloud",
    label: server.label,
    cloudAgentId: logicalAgentId,
    cloudRuntimeAgentId: dedicatedAgentId,
    cloudRuntime: "dedicated",
    apiBase: containerBase,
    accessToken: authToken,
  });

  // Seamless in-place base swap: re-point the REST base AND reconnect the WS to
  // the dedicated host without a visible disconnect. The transcript was already
  // copied to the dedicated agent by the handoff supervisor, so the live chat
  // surface stays mounted on the same conversation id with no reload.
  client.setToken(authToken);
  client.repointBaseUrl(containerBase);

  // Repointed ⇒ nothing pending: the reload-resume marker must not survive a
  // completed switch (a later boot restores the dedicated server directly).
  clearPendingCloudHandoff();
}
