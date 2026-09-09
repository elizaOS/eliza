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
    revalidate?: () => void;
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
    revalidate,
    requestDedicatedAdoptionConfirmation,
  } = args;
  signal?.throwIfAborted();
  revalidate?.();
  onProgress?.("connecting", "Opening your personal Eliza…");

  const selected = await client.ensurePersonalDedicatedEliza({
    cloudApiBase,
    authToken,
    ...(onProgress ? { onProgress } : {}),
    ...(signal ? { signal } : {}),
    ...(revalidate ? { revalidate } : {}),
    ...(requestDedicatedAdoptionConfirmation
      ? { requestDedicatedAdoptionConfirmation }
      : {}),
  });
  signal?.throwIfAborted();
  revalidate?.();

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
