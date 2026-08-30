/**
 * Opens the account-native personal Eliza after Steward authentication.
 *
 * The stable identity begins on the rowless Shared service, but signed-in app
 * sessions may persist only its Dedicated runtime. The client owns activation,
 * readiness polling, and the atomic Shared history cutover.
 */

import type { DedicatedAdoptionConfirmationRequester } from "../../../api/client-cloud";

/** The slice of `ElizaClient` the join flow drives. */
export interface JoinFlowClient {
  ensurePersonalDedicatedEliza(options: {
    cloudApiBase: string;
    authToken: string;
    signal?: AbortSignal;
    onProgress?: (status: string, detail?: string) => void;
    requestDedicatedAdoptionConfirmation?: DedicatedAdoptionConfirmationRequester;
  }): Promise<{
    personalElizaId: string;
    agentId: string;
    activeAgentId: string;
    agentName: string;
    apiBase: string;
    runtime: "dedicated";
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
  }): void;
  savePersistedFirstRunComplete(complete: boolean): void;
}

export interface RunJoinFlowArgs {
  client: JoinFlowClient;
  effects: JoinFlowEffects;
  cloudApiBase: string;
  authToken: string;
  onProgress?: (status: string, detail?: string) => void;
  signal?: AbortSignal;
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

/** Resolve and persist the signed-in account's Dedicated personal Eliza. */
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
    requestDedicatedAdoptionConfirmation,
  } = args;
  signal?.throwIfAborted();
  onProgress?.("connecting", "Opening your personal Eliza…");

  const selected = await client.ensurePersonalDedicatedEliza({
    cloudApiBase,
    authToken,
    ...(onProgress ? { onProgress } : {}),
    ...(signal ? { signal } : {}),
    ...(requestDedicatedAdoptionConfirmation
      ? { requestDedicatedAdoptionConfirmation }
      : {}),
  });
  signal?.throwIfAborted();

  onProgress?.("connecting", "Connecting to your Dedicated agent…");

  if (
    !selected.personalElizaId ||
    selected.agentId !== selected.personalElizaId ||
    !selected.activeAgentId
  ) {
    throw new Error("Cloud did not return a personal Eliza to connect to.");
  }
  if (selected.runtime !== "dedicated") {
    throw new Error(
      "Cloud returned Shared for a signed-in app session; Dedicated is required.",
    );
  }

  client.setBaseUrl(selected.apiBase);
  client.setToken(authToken);

  onProgress?.("connecting", "Finishing setup…");

  effects.savePersistedActiveServer({
    id: `cloud:${selected.agentId}`,
    kind: "cloud",
    label: selected.agentName || "Eliza",
    apiBase: selected.apiBase,
    accessToken: authToken,
    cloudRuntimeAgentId: selected.activeAgentId,
    cloudRuntime: selected.runtime,
  });
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
