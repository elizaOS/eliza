/**
 * Pure env-var detector for platform-managed cloud containers. Lives in
 * `@elizaos/shared` so that `@elizaos/agent` (and other host-layer code) can
 * make this decision without dynamically importing `@elizaos/plugin-elizacloud`
 * at module scope — that pattern previously forced the cloud plugin to load
 * during container boot.
 */

import { readAliasedEnv } from "../utils/env.js";
import {
  type DevCloudEnvAuthority,
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority,
} from "./dev-cloud-env-authority.js";

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function readProvisioningEnv(
  key: string,
  authority: DevCloudEnvAuthority | null,
): string | undefined {
  return authority
    ? resolveDevCloudAuthorityEnvValue(key)
    : readAliasedEnv(key);
}

function hasCompatApiToken(authority: DevCloudEnvAuthority | null): boolean {
  return hasValue(readProvisioningEnv("ELIZA_API_TOKEN", authority));
}

function hasCloudApiKeyProvisioning(
  authority: DevCloudEnvAuthority | null,
): boolean {
  return (
    readProvisioningEnv("ELIZAOS_CLOUD_ENABLED", authority) === "true" &&
    hasValue(readProvisioningEnv("ELIZAOS_CLOUD_API_KEY", authority))
  );
}

export function isCloudProvisionedContainer(): boolean {
  const authority = resolveDevCloudEnvAuthority();
  if (authority === "staging-default" || authority === "offline") {
    return false;
  }

  const hasCloudFlag =
    readProvisioningEnv("ELIZA_CLOUD_PROVISIONED", authority) === "1";

  return (
    hasCloudFlag &&
    (hasValue(readProvisioningEnv("STEWARD_AGENT_TOKEN", authority)) ||
      hasCompatApiToken(authority) ||
      hasCloudApiKeyProvisioning(authority))
  );
}
