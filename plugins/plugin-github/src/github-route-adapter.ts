/**
 * Runtime adapter between plugin routes and agent-scoped GitHub state.
 * It supplies the shared encrypted vault, binds every request to its runtime's
 * agent id, updates only runtime-local settings, and refreshes dependent client
 * caches after credential changes.
 */

import { sharedVault } from "@elizaos/app-core/services/vault-mirror";
import {
  ElizaError,
  type IAgentRuntime,
  type LegacyRouteHandler,
  type Route,
  type Service,
} from "@elizaos/core";
import {
  type GitHubCredentialStore,
  VaultGitHubCredentialStore,
} from "./github-credentials.js";
import { handleGitHubRoutes } from "./routes/github-routes.js";
import { GitHubService } from "./services/github-service.js";

let credentialStore: GitHubCredentialStore | null = null;

function sharedGitHubCredentialStore(): GitHubCredentialStore {
  if (!credentialStore) {
    credentialStore = new VaultGitHubCredentialStore(sharedVault());
  }
  return credentialStore;
}

function clearRuntimeGitHubToken(runtime: IAgentRuntime): void {
  const secrets = runtime.character.secrets;
  if (secrets && "GITHUB_TOKEN" in secrets) delete secrets.GITHUB_TOKEN;
  const settings = runtime.character.settings;
  const nestedSecrets =
    settings &&
    typeof settings === "object" &&
    "secrets" in settings &&
    typeof settings.secrets === "object" &&
    settings.secrets !== null
      ? (settings.secrets as Record<string, unknown>)
      : undefined;
  if (nestedSecrets && "GITHUB_TOKEN" in nestedSecrets) {
    delete nestedSecrets.GITHUB_TOKEN;
  }
}

async function refreshRuntimeGitHubClients(
  runtime: IAgentRuntime,
): Promise<void> {
  const service = runtime.getService<GitHubService>(GitHubService.serviceType);
  if (!service) {
    throw new ElizaError(
      "GitHub service is unavailable after credential change",
      {
        code: "GITHUB_SERVICE_UNAVAILABLE",
        severity: "fatal",
      },
    );
  }
  await service.refreshCredentials();
  const workspaceService = runtime.getService<
    Service & { refreshGitHubCredential(): Promise<void> | void }
  >("CODING_WORKSPACE_SERVICE");
  await workspaceService?.refreshGitHubCredential();
}

function createGitHubRouteHandler(
  method: "GET" | "POST" | "DELETE",
  store: GitHubCredentialStore,
): LegacyRouteHandler {
  return async (req, res, agentRuntime): Promise<void> => {
    const url = new URL(req.url ?? "/api/github/token", "http://localhost");
    await handleGitHubRoutes({
      req,
      method,
      pathname: url.pathname,
      agentKey: String(agentRuntime.agentId),
      credentialStore: store,
      json: (status, body) => {
        res.status(status).json(body);
      },
      getOauthClientId: () => {
        const clientId = agentRuntime.getSetting("GITHUB_OAUTH_CLIENT_ID");
        return typeof clientId === "string" ? clientId : undefined;
      },
      applyRuntimeToken: async (token) => {
        agentRuntime.setSetting("GITHUB_TOKEN", token, true);
        await refreshRuntimeGitHubClients(agentRuntime);
      },
      clearRuntimeToken: async () => {
        clearRuntimeGitHubToken(agentRuntime);
        await refreshRuntimeGitHubClients(agentRuntime);
      },
    });
  };
}

/** Build the production route adapters around an injectable encrypted store. */
export function createGitHubRoutes(
  store: GitHubCredentialStore = sharedGitHubCredentialStore(),
): Route[] {
  const route = (type: "GET" | "POST" | "DELETE", path: string): Route => ({
    type,
    path,
    rawPath: true,
    handler: createGitHubRouteHandler(type, store),
  });
  return [
    route("GET", "/api/github/token"),
    route("POST", "/api/github/token"),
    route("DELETE", "/api/github/token"),
    route("POST", "/api/github/device/start"),
    route("POST", "/api/github/device/poll"),
    route("POST", "/api/github/device/cancel"),
    route("POST", "/api/github/device/reconnect"),
  ];
}

/** Hydrate only this runtime from its encrypted credential on plugin startup. */
export async function hydrateRuntimeGitHubCredential(
  runtime: Pick<IAgentRuntime, "agentId" | "setSetting">,
  store: GitHubCredentialStore = sharedGitHubCredentialStore(),
): Promise<void> {
  const stored = await store.load(String(runtime.agentId));
  if (stored) runtime.setSetting("GITHUB_TOKEN", stored.token, true);
}
