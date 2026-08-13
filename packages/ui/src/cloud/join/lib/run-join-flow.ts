/**
 * The join flow's core controller — pure(ish) async logic, decoupled from React
 * so it is unit-testable.
 *
 * Flow: after Steward login the backend has already created the account. The
 * join flow:
 *
 *   1. resolve the account-native personal Eliza identity from the Cloud API;
 *      this is a rowless service and never creates an agent sandbox.
 *   2. point the live client at its REST adapter and persist the
 *      `cloud:<agentId>` active server so the next boot reconnects to it;
 *   3. mark first-run complete so the app lands in chat, not setup.
 *
 * The caller (JoinPage) then navigates to `/` — the tab/view app, where chat is
 * home. No signup, sign-in, or join action starts paid compute.
 */

/** The slice of `ElizaClient` the join flow drives. */
export interface JoinFlowClient {
  getPersonalSharedEliza(options: {
    cloudApiBase: string;
    authToken: string;
  }): Promise<{
    agentId: string;
    agentName: string;
    apiBase: string;
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
}

export interface JoinFlowResult {
  agentId: string;
  agentName: string;
  /** The base the live client + persisted active server were pointed at. */
  apiBase: string;
}

/**
 * Run the full join flow. Returns the resolved connection so the caller can land
 * the user in chat. Throws when identity resolution fails; the caller surfaces
 * the error and offers retry without creating compute as a fallback.
 */
export async function runJoinFlow(
  args: RunJoinFlowArgs,
): Promise<JoinFlowResult> {
  const { client, effects, cloudApiBase, authToken, onProgress } = args;
  onProgress?.("connecting", "Opening your personal Eliza…");
  const selected = await client.getPersonalSharedEliza({
    cloudApiBase,
    authToken,
  });

  if (!selected.agentId) {
    throw new Error("Cloud did not return an agent to connect to.");
  }

  const connectionBase = selected.apiBase;

  client.setBaseUrl(connectionBase);
  client.setToken(authToken);

  effects.savePersistedActiveServer({
    id: `cloud:${selected.agentId}`,
    kind: "cloud",
    label: selected.agentName || "Eliza",
    apiBase: connectionBase,
    accessToken: authToken,
  });
  // The account and personal Shared identity already exist; completing first
  // run only changes navigation and never starts a container.
  effects.savePersistedFirstRunComplete(true);

  return {
    agentId: selected.agentId,
    agentName: selected.agentName || "Eliza",
    apiBase: connectionBase,
  };
}
