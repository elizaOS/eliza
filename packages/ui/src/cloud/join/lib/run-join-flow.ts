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
  personalElizaId: string;
  agentId: string;
  activeAgentId: string;
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

  onProgress?.(
    "connecting",
    selected.runtime === "dedicated"
      ? "Connecting to your Dedicated agent…"
      : "Connecting to Shared…",
  );

  if (
    !selected.personalElizaId ||
    selected.agentId !== selected.personalElizaId ||
    !selected.activeAgentId
  ) {
    throw new Error("Cloud did not return a personal Eliza to connect to.");
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
