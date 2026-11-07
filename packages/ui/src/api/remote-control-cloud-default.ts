/** Lazily composed owner client, kept separate from transport code to avoid an ElizaClient import cycle. */

import { DEFAULT_DIRECT_CLOUD_API_BASE_URL } from "@elizaos/plugin-browser/remote-control/cloud-endpoints";
import { getBootConfig } from "../config/boot-config-store";
import { client } from "./client";
import { getCloudAuthToken } from "./client-cloud";
import {
  RemoteControlAuthenticationRequiredError,
  RemoteControlCloudClient,
} from "./remote-control-cloud-client";

export function createDefaultRemoteControlCloudClient(): RemoteControlCloudClient {
  const { authToken, baseUrl } = getDefaultRemoteControlCloudConnection();
  return new RemoteControlCloudClient({ baseUrl, authToken });
}

export function getDefaultRemoteControlCloudConnection(): {
  baseUrl: string;
  authToken: string;
} {
  const authToken = getCloudAuthToken(client);
  if (!authToken) throw new RemoteControlAuthenticationRequiredError();
  return {
    baseUrl: getBootConfig().cloudApiBase || DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    authToken,
  };
}
