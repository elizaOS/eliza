/**
 * The join flow's core controller — pure(ish) async logic, decoupled from React
 * so it is unit-testable.
 *
 * Flow: after Steward login
 * the backend's `syncUserFromSteward` has already created user + org + credits +
 * a default character. The join flow:
 *
 *   1. selectOrProvisionCloudAgent — reuse the user's existing Cloud agent, or
 *      provision one (shared tier = instant). Returns a per-agent REST base.
 *   2. choose the connection base — prefer the dedicated container subdomain
 *      (`https://<agentId>.cloud.eliza.app`) for the full runtime (real /ws,
 *      /api/conversations) when the agent reports one; else the shared-tier REST
 *      adapter base.
 *   3. point the live client at it (setBaseUrl + setToken) AND persist the
 *      `cloud:<agentId>` active server so the next boot's startup-restore
 *      reconnects to it.
 *   4. mark first-run complete so the app lands in CHAT, not the setup wizard.
 *
 * A remembered binding whose agent was deleted server-side answers step 1 with
 * the structural agent-gone shape; the flow then clears the stale binding and
 * re-runs selection from the fresh-visit state instead of dead-ending.
 *
 * The caller (JoinPage) then navigates to `/` — the tab/view app, where chat is
 * home. There is no "No agents yet" empty table: a brand-new user is talking to
 * an agent within seconds.
 */

import { isElizaDedicatedAgentHostname } from "@elizaos/shared/elizacloud";
import { isCloudAgentGoneError } from "../../../api/client-types-core";
import {
  buildCloudSharedAgentApiBase,
  ELIZA_CLOUD_CONTROL_PLANE_HOSTS,
} from "../../../utils/cloud-agent-base";

type CloudAgentExecutionTier =
  | "shared"
  | "dedicated-lazy"
  | "dedicated-always"
  | "custom";

interface CloudAgentDeleteCondition {
  expectedAgentName: string;
  expectedCreatedAt: string;
  expectedExecutionTier: CloudAgentExecutionTier;
}

interface CloudAgentCleanupReceipt {
  deleteCondition: CloudAgentDeleteCondition;
}

/** The slice of `ElizaClient` the join flow drives. */
export interface JoinFlowClient {
  selectOrProvisionCloudAgent(options: {
    cloudApiBase: string;
    authToken: string;
    name: string;
    bio?: string[];
    preferAgentId?: string | null;
    preferSharedTier?: boolean;
    forceCreate?: boolean;
    onProgress?: (status: string, detail?: string) => void;
    signal?: AbortSignal;
  }): Promise<{
    agentId: string;
    agentName: string;
    apiBase: string;
    bridgeUrl: string | null;
    created: boolean;
    cleanupReceipt?: CloudAgentCleanupReceipt;
  }>;
  setBaseUrl(baseUrl: string | null): void;
  setToken(token: string | null): void;
  deleteCloudCompatAgent?(
    agentId: string,
    condition?: CloudAgentDeleteCondition,
  ): Promise<{
    success: boolean;
    error?: string;
    data?: { jobId?: string; status?: string; message?: string };
  }>;
}

/** Persistence + lifecycle seams, injected so the controller stays testable. */
export interface JoinFlowEffects {
  savePersistedActiveServer(server: {
    id: string;
    kind: "cloud";
    label: string;
    apiBase?: string;
    accessToken?: string;
  }): void;
  clearPersistedActiveServer(): void;
  savePersistedFirstRunComplete(complete: boolean): void;
}

export interface RunJoinFlowArgs {
  client: JoinFlowClient;
  effects: JoinFlowEffects;
  cloudApiBase: string;
  authToken: string;
  /** Display name for a freshly provisioned agent. */
  agentName: string;
  /** Bio lines for a freshly provisioned agent. */
  bio?: string[];
  /** Reuse this agent id when it still exists (e.g. last-active). */
  preferAgentId?: string | null;
  /** Prefer the shared tier when provisioning (prevents billed dedicated). */
  preferSharedTier?: boolean;
  /** Always create a new agent ("Create new" gesture). */
  forceCreate?: boolean;
  onProgress?: (status: string, detail?: string) => void;
  /** Cancels selection/wake work and compensates a newly accepted create. */
  signal?: AbortSignal;
}

export interface JoinFlowResult {
  agentId: string;
  agentName: string;
  /** The base the live client + persisted active server were pointed at. */
  apiBase: string;
  /** True when this agent was newly provisioned (vs reused). */
  created: boolean;
  /** True when the dedicated container subdomain was selected. */
  dedicated: boolean;
}

async function compensateCreatedAgent(
  client: JoinFlowClient,
  selected: Awaited<ReturnType<JoinFlowClient["selectOrProvisionCloudAgent"]>>,
): Promise<void> {
  if (!client.deleteCloudCompatAgent) {
    throw new Error("Join client cannot compensate a created agent");
  }
  if (!selected.cleanupReceipt) {
    throw new Error(
      "Eliza Cloud did not return the authoritative create identity required for cleanup",
    );
  }
  // Conditional DELETE is the server-owned delete-wins transaction: it accepts
  // an exact provisioning identity, retires conflicting lifecycle work,
  // suspends billing, frees quota, and queues recoverable teardown atomically.
  // Its durable acceptance—not eventual infrastructure teardown—is the browser
  // compensation boundary, so sign-out never waits on background cleanup.
  const cleanup = await client.deleteCloudCompatAgent(
    selected.agentId,
    selected.cleanupReceipt.deleteCondition,
  );
  if (!cleanup.success) {
    throw new Error(
      cleanup.error ??
        cleanup.data?.message ??
        "Compensating cloud agent deletion failed",
    );
  }
  const jobId = cleanup.data?.jobId?.trim() ?? "";
  const status = cleanup.data?.status?.trim().toLowerCase() ?? "";
  if (!jobId && status !== "deleted") {
    throw new Error(
      "Eliza Cloud did not return a durable agent deletion receipt",
    );
  }
}

/**
 * The dedicated container subdomain for an agent, when `apiBase` already points
 * at one (`https://<agentId>.cloud.eliza.app`). Shared-tier agents serve at the
 * control-plane REST adapter (`api.eliza.app/api/v1/eliza/agents/<id>`), so
 * those return `null`. The Cloud only returns a reachable dedicated `web_ui_url`
 * once the per-agent ingress is live; until then this is naturally `null` and we
 * fall back to the shared-tier REST base (instant chat).
 */
export function dedicatedSubdomainBase(apiBase: string): string | null {
  try {
    const url = new URL(apiBase);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(host)) return null;
    if (!isElizaDedicatedAgentHostname(host)) return null;
    // The dedicated container's apex (`https://<id>.cloud.eliza.app`), no REST
    // adapter path — that is the full-runtime origin.
    return `${url.protocol}//${url.host}`;
  } catch {
    // error-policy:J3 unparseable api base cannot be proven a dedicated
    // subdomain — fall back to the control-plane origin (fail-closed).
    return null;
  }
}

/**
 * Run the full join flow. Returns the resolved connection so the caller can land
 * the user in chat. Throws on provisioning failure (no agent could be reused or
 * created) — the caller surfaces the error and offers retry.
 */
export async function runJoinFlow(
  args: RunJoinFlowArgs,
): Promise<JoinFlowResult> {
  const {
    client,
    effects,
    cloudApiBase,
    authToken,
    agentName,
    bio,
    preferAgentId,
    preferSharedTier,
    forceCreate,
    onProgress,
    signal,
  } = args;

  signal?.throwIfAborted();

  const selectionOptions = {
    cloudApiBase,
    authToken,
    name: agentName,
    ...(bio?.length ? { bio } : {}),
    ...(preferSharedTier ? { preferSharedTier } : {}),
    ...(forceCreate ? { forceCreate } : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(signal ? { signal } : {}),
  };

  let selected: Awaited<
    ReturnType<JoinFlowClient["selectOrProvisionCloudAgent"]>
  >;
  try {
    selected = await client.selectOrProvisionCloudAgent({
      ...selectionOptions,
      ...(preferAgentId ? { preferAgentId } : {}),
    });
  } catch (error) {
    // error-policy:J4 only the structural agent-gone shape (404 +
    // `agent_not_found` code) from a remembered binding is recovered here.
    // Code-less legacy 404 bodies are intentionally excluded: older routers
    // used the same message for stopped/cold rows. A stale persisted binding
    // keeps the live client pointed at a DELETED agent's origin, so the
    // selection lookup misroutes through that dead origin and 404s forever —
    // retrying can never succeed. Drop the binding, reset the client to the
    // fresh-visit state (empty base → control-plane resolution), and re-run
    // selection: existing agents are picked normally, zero agents fall
    // through to the provisioning path. Transport failures of a valid binding
    // (and every other shape) still rethrow into the terminal error state.
    if (!preferAgentId || !isCloudAgentGoneError(error)) throw error;
    effects.clearPersistedActiveServer();
    client.setBaseUrl(null);
    selected = await client.selectOrProvisionCloudAgent(selectionOptions);
  }

  if (signal?.aborted) {
    if (selected.created && selected.agentId) {
      try {
        await compensateCreatedAgent(client, selected);
      } catch (cleanupError) {
        // error-policy:J2 preserve both the user's cancellation and the
        // compensation failure so the page can refuse to destroy auth.
        throw new AggregateError(
          [signal.reason, cleanupError],
          "Join was cancelled after create, and compensating deletion failed",
        );
      }
    }
    signal.throwIfAborted();
  }

  if (!selected.agentId) {
    throw new Error("Cloud did not return an agent to connect to.");
  }

  // Prefer the dedicated container subdomain (full runtime) when the agent
  // reports one; otherwise the shared-tier REST adapter base (instant chat).
  // A blank apiBase falls back to a derived per-agent REST base so the client is
  // never pointed at the unusable agent-id-less collection URL.
  const dedicated = dedicatedSubdomainBase(selected.apiBase);
  const connectionBase =
    dedicated ??
    (selected.apiBase ||
      buildCloudSharedAgentApiBase(cloudApiBase, selected.agentId));

  client.setBaseUrl(connectionBase);
  client.setToken(authToken);

  effects.savePersistedActiveServer({
    id: `cloud:${selected.agentId}`,
    kind: "cloud",
    label: selected.agentName || agentName || "Eliza Cloud",
    apiBase: connectionBase,
    accessToken: authToken,
  });
  // The Cloud backend already provisioned user + org + credits + default
  // character on sign-in, and we just connected to the agent — first-run is
  // complete, so the app boots straight into chat (not the setup wizard).
  effects.savePersistedFirstRunComplete(true);

  return {
    agentId: selected.agentId,
    agentName: selected.agentName || agentName,
    apiBase: connectionBase,
    created: selected.created,
    dedicated: dedicated !== null,
  };
}
