/**
 * Auth helper for compat routes.
 *
 * Auth priority:
 *   1. X-Service-Key header (existing S2S auth for eliza-cloud)
 *   2. Service JWT in Authorization header (waifu-core bridge)
 *   3. Standard Steward/API-key auth (dashboard users)
 */

import type { Organization } from "@/db/repositories/organizations";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { requireServiceKey, ServiceKeyAuthError } from "@/lib/auth/service-key";
import { authenticateWaifuBridge } from "@/lib/auth/waifu-bridge";

export interface CompatAuthResult {
  user: {
    id: string;
    organization_id: string;
    organization?: Organization;
  };
  authMethod: "service_key" | "service_jwt" | "standard";
}

/**
 * Authenticate a compat route request.
 */
export async function requireCompatAuth(request: Request): Promise<CompatAuthResult> {
  // 1. X-Service-Key (eliza-cloud S2S)
  const serviceKeyHeader = request.headers.get("X-Service-Key");
  if (serviceKeyHeader !== null) {
    let serviceKeyIdentity;
    try {
      serviceKeyIdentity = requireServiceKey(request);
    } catch (err) {
      // Preserve 500-level errors for server misconfiguration (e.g.
      // WAIFU_SERVICE_ORG_ID / WAIFU_SERVICE_USER_ID not set) — only
      // auth failures should become ServiceKeyAuthError (→ 401).
      if (err instanceof ServiceKeyAuthError) throw err;
      if (err instanceof Error) throw err;
      throw new ServiceKeyAuthError("Invalid service key");
    }
    return {
      user: {
        id: serviceKeyIdentity.userId,
        organization_id: serviceKeyIdentity.organizationId,
      },
      authMethod: "service_key",
    };
  }

  // 2. Service JWT (waifu-core bridge)
  const bridge = await authenticateWaifuBridge(request);
  if (bridge) {
    return {
      user: bridge.user,
      authMethod: "service_jwt",
    };
  }

  // 3. Standard auth (Steward / API key)
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  return {
    user,
    authMethod: "standard",
  };
}
