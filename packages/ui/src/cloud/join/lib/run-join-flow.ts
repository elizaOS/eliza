/**
 * Opens the account-native personal Eliza after Steward authentication.
 *
 * The stable identity begins on the rowless Shared service. Existing Dedicated
 * cutovers keep their server-owned destination.
 * Opening chat never creates or upgrades paid compute.
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
  } = args;
  signal?.throwIfAborted();
  onProgress?.("connecting", "Opening your personal Eliza…");

  signal?.throwIfAborted();
  const selected = await client.getPersonalSharedEliza({
    cloudApiBase,
    authToken,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();

  onProgress?.(
    "connecting",
    `Connecting to your ${selected.runtime === "shared" ? "Shared" : "Dedicated"} agent…`,
  );

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
  if (
    selected.runtime === "shared" &&
    selected.activeAgentId !== selected.personalElizaId
  ) {
    throw new Error("Cloud returned a different Shared conversation identity.");
  }

  onProgress?.("connecting", "Finishing setup…");
  // Progress callbacks may synchronously detect a session change. Finish all
  // abort checks before installing either in-memory or persisted authority.
  signal?.throwIfAborted();
  client.setBaseUrl(selected.apiBase);
  client.setToken(authToken);

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
