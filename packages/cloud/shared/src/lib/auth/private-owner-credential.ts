/** Extra admission for an already authenticated owner; this never authenticates request claims. */
import {
  readPrivateOwnerAccountAuthority,
  readPrivateOwnerApiKeyAuthority,
} from "../../db/repositories/private-owner-credential";
import type { Variables } from "../../types/cloud-worker-env";
import { ForbiddenError } from "../api/cloud-worker-errors";
import type { MobileAppAuthRuntimeEnv } from "../services/mobile-app-auth";

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
  const { resolveMobileAppAuthRegistration, MobileAppAuthProtocolError } = await import(
    "../services/mobile-app-auth"
  );
  let registration: ReturnType<typeof resolveMobileAppAuthRegistration>;
  try {
    registration = resolveMobileAppAuthRegistration(args.env, grant.clientId);
  } catch (error) {
    if (error instanceof MobileAppAuthProtocolError) throw refuse();
    throw error;
  }
  if (
    registration.appId !== grant.appId ||
    registration.environment !== grant.environment ||
    registration.redirectUri !== grant.redirectUri ||
    !Array.isArray(grant.scopes) ||
    grant.scopes.length !== registration.scopes.length ||
    !registration.scopes.every((scope) => grant.scopes.includes(scope))
  )
    throw refuse();
}
