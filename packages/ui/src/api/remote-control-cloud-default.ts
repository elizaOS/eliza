/** Lazily composed owner client, kept separate from transport code to avoid an ElizaClient import cycle. */
import { getBootConfig } from "../config/boot-config";
import { client } from "./client";
import { getCloudAuthToken } from "./client-cloud";
import { DEFAULT_DIRECT_CLOUD_API_BASE_URL } from "./direct-cloud-endpoints";
import { RemoteControlCloudClient } from "./remote-control-cloud-client";

export function createDefaultRemoteControlCloudClient(): RemoteControlCloudClient {
  const { authToken, baseUrl } = getDefaultRemoteControlCloudConnection();
  return new RemoteControlCloudClient({ baseUrl, authToken });
}

export function getDefaultRemoteControlCloudConnection(): {
  baseUrl: string;
  authToken: string;
} {
  const authToken = getCloudAuthToken(client);
  if (!authToken) throw new Error("Sign in to Eliza Cloud to manage devices.");
  return {
    baseUrl: getBootConfig().cloudApiBase || DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    authToken,
  };
}
