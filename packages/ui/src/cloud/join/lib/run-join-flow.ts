/**
 * Opens the account-native personal Eliza after Steward authentication.
 *
 * Entry resolves the authoritative Shared or existing Dedicated binding without
 * activating, waking, adopting, or cutting over a runtime. Paid lifecycle
 * operations belong to a separate explicit-consent flow, never authentication.
 */

import type { DedicatedAdoptionConfirmationRequester } from "../../../api/client-cloud";

/** The slice of `ElizaClient` the join flow drives. */
export interface JoinFlowClient {
  getPersonalSharedEliza(options: {
    cloudApiBase: string;
    authToken: string;
    signal?: AbortSignal;
    revalidate?: () => void;
  }): Promise<{
    personalElizaId: string;
    agentId: string;
    activeAgentId: string;
    agentName: string;
    apiBase: string;
    runtime: "shared" | "dedicated";
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
    cloudRuntimeAgentId?: string;
    cloudRuntime?: "shared" | "dedicated";
  }): boolean | void | Promise<boolean | void>;
  savePersistedFirstRunComplete(complete: boolean): void;
}

export interface RunJoinFlowArgs {
  client: JoinFlowClient;
  effects: JoinFlowEffects;
  cloudApiBase: string;
  authToken: string;
  onProgress?: (status: string, detail?: string) => void;
  signal?: AbortSignal;
  /** Original account/target guard, checked by the request owner and at publication. */
  revalidate?: () => void;
  requestDedicatedAdoptionConfirmation?: DedicatedAdoptionConfirmationRequester;
}

export interface JoinFlowResult {
  personalElizaId: string;
  agentId: string;
  activeAgentId: string;
  agentName: string;
  apiBase: string;
  runtime: "shared" | "dedicated";
}

/** Resolve and persist the signed-in account's existing personal runtime. */
export async function runJoinFlow(
  args: RunJoinFlowArgs,
): Promise<JoinFlowResult> {
  const {
    client,
    effects,
    cloudApiBase,
    authToken,
    onProgress,
    signal,
    revalidate,
  } = args;
  signal?.throwIfAborted();
  revalidate?.();
  onProgress?.("connecting", "Opening your personal Eliza…");

  const selected = await client.getPersonalSharedEliza({
    cloudApiBase,
    authToken,
    ...(signal ? { signal } : {}),
    ...(revalidate ? { revalidate } : {}),
  });
  signal?.throwIfAborted();
  revalidate?.();

  onProgress?.("connecting", "Connecting to your agent…");

  if (
    !selected.personalElizaId ||
    selected.agentId !== selected.personalElizaId ||
    !selected.activeAgentId
  ) {
    throw new Error("Cloud did not return a personal Eliza to connect to.");
  }
  if (selected.runtime !== "shared" && selected.runtime !== "dedicated") {
    throw new Error("Cloud returned an unknown personal Eliza runtime.");
  }

  onProgress?.("connecting", "Finishing setup…");
  revalidate?.();
  const persisted = await effects.savePersistedActiveServer({
    id: `cloud:${selected.agentId}`,
    kind: "cloud",
    label: selected.agentName || "Eliza",
    apiBase: selected.apiBase,
    accessToken: authToken,
    cloudRuntimeAgentId: selected.activeAgentId,
    cloudRuntime: selected.runtime,
  });
  if (persisted === false)
    throw new Error("Could not persist the selected Cloud agent");
  signal?.throwIfAborted();
  revalidate?.();
  client.setBaseUrl(selected.apiBase);
  revalidate?.();
  client.setToken(authToken);
  revalidate?.();
  effects.savePersistedFirstRunComplete(true);

  return {
    personalElizaId: selected.personalElizaId,
    agentId: selected.agentId,
    activeAgentId: selected.activeAgentId,
    agentName: selected.agentName || "Eliza",
    apiBase: selected.apiBase,
    runtime: selected.runtime,
  };
}
