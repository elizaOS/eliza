/**
 * Opens the account-native personal Eliza after Steward authentication.
 *
 * The identity is a rowless Shared service, so this controller only resolves
 * and persists its connection. It never provisions an agent or starts paid
 * compute. The caller owns cancellation and the final navigation into chat.
 */

/** The slice of `ElizaClient` the join flow drives. */
export interface JoinFlowClient {
  getPersonalSharedEliza(options: {
    cloudApiBase: string;
    authToken: string;
    signal?: AbortSignal;
  }): Promise<{
    agentId: string;
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
}

export interface JoinFlowResult {
  agentId: string;
  agentName: string;
  apiBase: string;
  runtime: "shared" | "dedicated";
}

/** Resolve and persist the signed-in account's rowless personal Eliza. */
export async function runJoinFlow(
  args: RunJoinFlowArgs,
): Promise<JoinFlowResult> {
  const { client, effects, cloudApiBase, authToken, onProgress, signal } = args;
  signal?.throwIfAborted();
  onProgress?.("connecting", "Opening your personal Eliza…");

  const selected = await client.getPersonalSharedEliza({
    cloudApiBase,
    authToken,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();

  if (!selected.agentId) {
    throw new Error("Cloud did not return a personal Eliza to connect to.");
  }

  client.setBaseUrl(selected.apiBase);
  client.setToken(authToken);

  effects.savePersistedActiveServer({
    id: `cloud:${selected.agentId}`,
    kind: "cloud",
    label: selected.agentName || "Eliza",
    apiBase: selected.apiBase,
    accessToken: authToken,
  });
  effects.savePersistedFirstRunComplete(true);

  return {
    agentId: selected.agentId,
    agentName: selected.agentName || "Eliza",
    apiBase: selected.apiBase,
    runtime: selected.runtime,
  };
}
