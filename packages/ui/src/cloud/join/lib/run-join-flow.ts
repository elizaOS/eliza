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
 *      (`https://<agentId>.elizacloud.ai`) for the full runtime (real /ws,
 *      /api/conversations) when the agent reports one; else the shared-tier REST
 *      adapter base.
 *   3. point the live client at it (setBaseUrl + setToken) AND persist the
 *      `cloud:<agentId>` active server so the next boot's startup-restore
 *      reconnects to it.
 *   4. mark first-run complete so the app lands in CHAT, not the setup wizard.
 *
 * The caller (JoinPage) then navigates to `/` — the tab/view app, where chat is
 * home. There is no "No agents yet" empty table: a brand-new user is talking to
 * an agent within seconds.
 */

import {
  buildCloudSharedAgentApiBase,
  ELIZA_CLOUD_CONTROL_PLANE_HOSTS,
} from "../../../utils/cloud-agent-base";

/** The slice of `ElizaClient` the join flow drives. */
export interface JoinFlowClient {
  selectOrProvisionCloudAgent(options: {
    cloudApiBase: string;
    authToken: string;
    name: string;
    bio?: string[];
    preferAgentId?: string | null;
    forceCreate?: boolean;
    onProgress?: (status: string, detail?: string) => void;
  }): Promise<{
    agentId: string;
    agentName: string;
    apiBase: string;
    bridgeUrl: string | null;
    created: boolean;
  }>;
  setBaseUrl(baseUrl: string | null): void;
  setToken(token: string | null): void;
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
  /** Always create a new agent ("Create new" gesture). */
  forceCreate?: boolean;
  onProgress?: (status: string, detail?: string) => void;
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

/**
 * The dedicated container subdomain for an agent, when `apiBase` already points
 * at one (`https://<agentId>.elizacloud.ai`). Shared-tier agents serve at the
 * control-plane REST adapter (`api.elizacloud.ai/api/v1/eliza/agents/<id>`), so
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
    if (!host.endsWith(".elizacloud.ai")) return null;
    // The dedicated container's apex (`https://<id>.elizacloud.ai`), no REST
    // adapter path — that is the full-runtime origin.
    return `${url.protocol}//${url.host}`;
  } catch {
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
    forceCreate,
    onProgress,
  } = args;

  const selected = await client.selectOrProvisionCloudAgent({
    cloudApiBase,
    authToken,
    name: agentName,
    ...(bio?.length ? { bio } : {}),
    ...(preferAgentId ? { preferAgentId } : {}),
    ...(forceCreate ? { forceCreate } : {}),
    ...(onProgress ? { onProgress } : {}),
  });

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
