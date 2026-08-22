/**
 * Converts a direct Cloud account login into the durable personal-agent target
 * used by desktop startup and chat routing.
 */

import { setStorageValue } from "../bridge/storage-bridge";
import { upsertAndActivateAgentProfile } from "./agent-profiles";
import {
  createPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";

interface DirectCloudBindingClient {
  getPersonalSharedEliza(options: {
    cloudApiBase: string;
    authToken: string;
  }): Promise<{
    personalElizaId: string;
    activeAgentId: string;
    agentName: string;
    apiBase: string;
    runtime: "shared" | "dedicated";
  }>;
  setBaseUrl(base: string, options?: { persist?: boolean }): void;
  setToken(token: string): void;
}

export async function bindDirectCloudLoginToPersonalAgent(options: {
  client: DirectCloudBindingClient;
  cloudApiBase: string;
  token: string;
}): Promise<void> {
  const personal = await options.client.getPersonalSharedEliza({
    cloudApiBase: options.cloudApiBase,
    authToken: options.token,
  });
  const server = createPersistedActiveServer({
    kind: "cloud",
    id: `cloud:${personal.personalElizaId}`,
    label: personal.agentName,
    apiBase: personal.apiBase,
    accessToken: options.token,
    cloudRuntimeAgentId: personal.activeAgentId,
    cloudRuntime: personal.runtime,
  });
  if (!server.apiBase || !savePersistedActiveServer(server)) {
    throw new Error("The production Cloud agent target could not be saved.");
  }
  await setStorageValue(ACTIVE_SERVER_STORAGE_KEY, JSON.stringify(server));
  upsertAndActivateAgentProfile({
    kind: "cloud",
    label: server.label,
    cloudAgentId: personal.personalElizaId,
    cloudRuntimeAgentId: personal.activeAgentId,
    cloudRuntime: personal.runtime,
    apiBase: server.apiBase,
    accessToken: options.token,
  });
  options.client.setBaseUrl(server.apiBase, { persist: false });
  options.client.setToken(options.token);
}
