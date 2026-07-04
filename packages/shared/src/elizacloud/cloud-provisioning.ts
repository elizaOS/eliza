/**
 * Pure env-var detector for platform-managed cloud containers. Lives in
 * `@elizaos/shared` so that `@elizaos/agent` (and other host-layer code) can
 * make this decision without dynamically importing `@elizaos/plugin-elizacloud`
 * at module scope — that pattern previously forced the cloud plugin to load
 * during container boot.
 */

import { readAliasedEnv } from "../utils/env.js";

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function hasCompatApiToken(): boolean {
  return hasValue(readAliasedEnv("ELIZA_API_TOKEN"));
}

function hasCloudApiKeyProvisioning(): boolean {
  return (
    readAliasedEnv("ELIZAOS_CLOUD_ENABLED") === "true" &&
    hasValue(readAliasedEnv("ELIZAOS_CLOUD_API_KEY"))
  );
}

export function isCloudProvisionedContainer(): boolean {
  const hasCloudFlag = readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1";

  return (
    hasCloudFlag &&
    (hasValue(process.env.STEWARD_AGENT_TOKEN) ||
      hasCompatApiToken() ||
      hasCloudApiKeyProvisioning())
  );
}
