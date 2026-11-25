/** Extra admission for an already authenticated owner; this never authenticates request claims. */
import {
  readPrivateOwnerAccountAuthority,
  readPrivateOwnerApiKeyAuthority,
} from "../../db/repositories/private-owner-credential";
import type { Variables } from "../../types/cloud-worker-env";
import { ForbiddenError } from "../api/cloud-worker-errors";
import {
  admitMobileAppAuthRegistration,
  MobileAppAuthProtocolError,
  type MobileAppAuthRuntimeEnv,
} from "../services/mobile-app-auth";

export async function requirePrivateOwnerCredential(args: {
  userId: string;
  organizationId: string;
  authMethod: Variables["authMethod"];
  apiKeyId?: string;
  apiKeyHash?: string;
  env: MobileAppAuthRuntimeEnv;
}): Promise<void> {
  const refuse = () => ForbiddenError("This credential cannot access private owner data");
  if (args.authMethod === "session" || args.authMethod === "wallet_signature") {
    if (!(await readPrivateOwnerAccountAuthority(args))) throw refuse();
    return;
  }
  // An unproven anonymous-method principal is not an owner credential.
  // Signed-in anonymous account rows still use the legitimate session branch.
  if (args.authMethod !== "api_key" || !args.apiKeyId || !args.apiKeyHash) throw refuse();
  const rows = await readPrivateOwnerApiKeyAuthority({
    apiKeyId: args.apiKeyId,
    apiKeyHash: args.apiKeyHash,
    userId: args.userId,
    organizationId: args.organizationId,
  });
  if (rows.length !== 1) throw refuse();
  const row = rows[0]!;
  if (
    !row.key.active ||
    row.key.deletedAt ||
    (row.key.expiresAt && row.key.expiresAt <= new Date()) ||
    row.backendAppId
  )
    throw refuse();
  if (!row.key.sourceAppId) {
    if (row.grant) throw refuse();
    return;
  }
  // A creator-held app backend key is not the user's browser-consented PKCE login.
  // Acknowledged grants outlive their five-minute authorization code: current key
  // lifetime, exact primary lineage and the server registration govern this path.
  const grant = row.grant;
  if (
    !grant ||
    grant.status !== "acknowledged" ||
    !grant.acknowledgedAt ||
    grant.credentialId !== row.key.id ||
    grant.appId !== row.key.sourceAppId ||
    grant.userId !== args.userId ||
    grant.organizationId !== args.organizationId ||
    !row.key.expiresAt ||
    !row.mobileApp?.active ||
    !row.mobileApp.approved
  )
    throw refuse();
  if (!row.mobileClient || !row.mobileClient.clientId || !row.mobileClient.enabled) {
    throw refuse();
  }
  let registration;
  try {
    registration = await admitMobileAppAuthRegistration(args.env, {
      client: {
        client_id: row.mobileClient.clientId,
        app_id: row.mobileClient.appId,
        redirect_uri: row.mobileClient.redirectUri,
        enabled: row.mobileClient.enabled,
        credential_ttl_seconds: row.mobileClient.credentialTtlSeconds,
      },
      app: {
        id: row.mobileApp.id,
        is_active: row.mobileApp.active,
        is_approved: row.mobileApp.approved,
        app_url: row.mobileApp.appUrl,
        allowed_origins: row.mobileApp.allowedOrigins,
      },
    });
  } catch (error) {
    if (error instanceof MobileAppAuthProtocolError) throw refuse();
    throw error;
  }
  if (
    registration.appId !== grant.appId ||
    registration.clientId !== grant.clientId ||
    registration.redirectUri !== grant.redirectUri ||
    registration.environment !== grant.environment ||
    !Array.isArray(grant.scopes) ||
    grant.scopes.length !== registration.scopes.length ||
    !registration.scopes.every((scope) => grant.scopes.includes(scope))
  )
    throw refuse();
}
