/** Trusted control-plane configuration only; never derived from user environment variables. */

import { getAgentBaseDomain, getConfiguredElizaAgentPublicWebUiUrl } from "../eliza-agent-web-ui";
import { resolveOidcConfig } from "../oidc/config";
import { getOidcSigner } from "../oidc/keys";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

export const MANAGED_CLOUD_OWNER_KEYS = [
  "ELIZA_CLOUD_OWNER_ISSUER",
  "ELIZA_CLOUD_OWNER_JWKS_URL",
  "ELIZA_CLOUD_OWNER_AUDIENCE",
  "ELIZA_CLOUD_OWNER_ALGORITHM",
  "ELIZA_CLOUD_OWNER_ID",
  "ELIZA_CLOUD_ORGANIZATION_ID",
  "ELIZA_CLOUD_DELEGATION_APP_ID",
  "ELIZA_CLOUD_DELEGATION_CLIENT_ID",
  "ELIZA_CLOUD_DELEGATION_CLIENT_SECRET",
  "ELIZA_CLOUD_DELEGATION_REDIRECT_URI",
  "ELIZA_CLOUD_DELEGATION_SITE_URL",
  "ELIZA_CLOUD_DELEGATION_API_URL",
  "ELIZA_CLOUD_DELEGATION_AGENT_ALLOWLIST",
] as const;
const delegationKeys = MANAGED_CLOUD_OWNER_KEYS.slice(6, 12);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface Owner {
  agentSandboxId: string;
  userId: string;
  organizationId: string;
}
function validOwner(owner: Owner) {
  return [owner.agentSandboxId, owner.userId, owner.organizationId].every((x) => uuid.test(x));
}

/** A triple allowlist prevents transfer or another agent from inheriting a confidential client. */
export function selectedManagedDelegation(
  owner: Owner,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const raw = env.ELIZA_CLOUD_DELEGATION_AGENT_ALLOWLIST;
  if (!raw) return {};
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw Error("Managed delegation allowlist is invalid");
  }
  if (
    !Array.isArray(entries) ||
    entries.length > 1000 ||
    entries.some(
      (x) =>
        !x ||
        typeof x !== "object" ||
        Object.keys(x).some((k) => !["agentId", "ownerId", "organizationId"].includes(k)) ||
        ![x.agentId, x.ownerId, x.organizationId].every(
          (v) => typeof v === "string" && uuid.test(v),
        ),
    )
  )
    throw Error("Managed delegation allowlist is invalid");
  if (
    !entries.some(
      (x) =>
        x.agentId === owner.agentSandboxId &&
        x.ownerId === owner.userId &&
        x.organizationId === owner.organizationId,
    )
  )
    return {};
  const result: Record<string, string> = {};
  for (const key of delegationKeys) {
    const value = env[key];
    if (typeof value !== "string" || !value.trim() || value.length > 16384)
      throw Error("Managed delegation configuration is incomplete");
    result[key] = value;
  }
  if (
    !uuid.test(result.ELIZA_CLOUD_DELEGATION_APP_ID) ||
    !uuid.test(result.ELIZA_CLOUD_DELEGATION_CLIENT_ID)
  )
    throw Error("Managed delegation registration is invalid");
  for (const key of [
    "ELIZA_CLOUD_DELEGATION_REDIRECT_URI",
    "ELIZA_CLOUD_DELEGATION_SITE_URL",
    "ELIZA_CLOUD_DELEGATION_API_URL",
  ]) {
    let u: URL;
    try {
      u = new URL(result[key]);
    } catch {
      throw Error("Managed delegation URL is invalid");
    }
    if (u.protocol !== "https:" || u.username || u.password || u.hash || u.search)
      throw Error("Managed delegation URL is invalid");
  }
  return result;
}

export async function prepareManagedCloudOwnerEnvironment(
  owner: Owner,
): Promise<Record<string, string>> {
  const env = getCloudAwareEnv(),
    config = resolveOidcConfig({
      OIDC_ENABLED: env.OIDC_ENABLED,
      OIDC_ISSUER_URL: env.OIDC_ISSUER_URL,
      ELIZA_ONBOARDING_LOGIN_APP_URL: env.ELIZA_ONBOARDING_LOGIN_APP_URL,
      ELIZA_CLOUD_URL: env.ELIZA_CLOUD_URL,
      NEXT_PUBLIC_APP_URL: env.NEXT_PUBLIC_APP_URL,
      OIDC_WALLET_EMAIL_DOMAIN: env.OIDC_WALLET_EMAIL_DOMAIN,
    });
  // An unconfigured issuer leaves proof authentication unavailable; no shared-key fallback.
  if (!config || !config.issuer.startsWith("https:") || !validOwner(owner)) return {};
  const audience = getConfiguredElizaAgentPublicWebUiUrl(
    { id: owner.agentSandboxId },
    env.ELIZA_CLOUD_AGENT_BASE_DOMAIN ?? getAgentBaseDomain(),
  );
  if (!audience || new URL(audience).protocol !== "https:") return {};
  let algorithm: string;
  try {
    algorithm = (await getOidcSigner()).alg;
  } catch {
    return {};
  }
  if (!["ES256", "RS256"].includes(algorithm)) return {};
  return {
    ELIZA_CLOUD_OWNER_ISSUER: config.issuer,
    ELIZA_CLOUD_OWNER_JWKS_URL: config.jwksUrl,
    ELIZA_CLOUD_OWNER_AUDIENCE: new URL(audience).origin,
    ELIZA_CLOUD_OWNER_ALGORITHM: algorithm,
    ELIZA_CLOUD_OWNER_ID: owner.userId,
    ELIZA_CLOUD_ORGANIZATION_ID: owner.organizationId,
    ...selectedManagedDelegation(owner, env),
  };
}
