/** Authorizes registered apps through shared consent codes and revocable, explicitly scoped grants. */
import { randomBytes } from "node:crypto";
import {
  APP_DELEGATION_SCOPES,
  type AppDelegationBinding,
  type AppDelegationPrincipal,
  type AppDelegationResult,
  type AppDelegationScope,
} from "@elizaos/cloud-sdk/app-delegation";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  isRegisteredRedirectUri,
  parseOidcClientEntry,
  verifyOidcClientSecret,
} from "../oidc/clients";
import { sha256Hex } from "../oidc/crypto";
import type { AppAuthCodeRecord } from "./app-auth-codes";

export const appDelegationBindingSchema = z
  .object({
    clientId: z.string().uuid(),
    redirectUri: z.string().url(),
    scopes: z
      .array(z.enum(APP_DELEGATION_SCOPES))
      .min(1)
      .refine((scopes) => new Set(scopes).size === scopes.length && scopes.includes("identity")),
  })
  .strict()
  .refine(
    (binding) =>
      !binding.scopes.some((scope) => scope.startsWith("google.")) ||
      binding.scopes.includes("google.basic_identity"),
    "Google capabilities require explicit Google identity consent",
  );

export class AppDelegationError extends ElizaError {
  override readonly name = "AppDelegationError";
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    code: string,
    message: string,
  ) {
    super(message, { code, severity: "ephemeral" });
  }
}

export interface AppClientRegistration {
  billingEnvironment: "test" | "live";
  id: string;
  appId: string;
  appName: string;
  appOwnerOrganizationId: string;
  secretHashes: string[];
  redirectUris: string[];
  allowedScopes: AppDelegationScope[];
  revision: number;
}

export interface AppDelegationGrant {
  tokenHash: string;
  authorizationCodeHash: string;
  clientId: string;
  appId: string;
  userId: string;
  organizationId: string | null;
  consentId: string;
  registrationRevision: number;
  scopes: AppDelegationScope[];
  expiresAt: Date;
}

export interface AppDelegationStore {
  findRegistration(clientId: string): Promise<AppClientRegistration | null>;
  findPrincipal(
    appId: string,
    userId: string,
  ): Promise<{ user: AppDelegationPrincipal; consentId: string } | null>;
  saveGrant(grant: AppDelegationGrant): Promise<boolean>;
  findGrant(tokenHash: string): Promise<AppDelegationGrant | null>;
  revokeGrant(clientId: string, tokenHash: string, now: Date): Promise<void>;
}

function oidcClient(registration: AppClientRegistration) {
  return parseOidcClientEntry({
    client_id: registration.id,
    name: registration.appName,
    client_secret_sha256: registration.secretHashes,
    redirect_uris: registration.redirectUris,
    allowed_scopes: ["openid"],
    require_verified_email: false,
    claims_policy: { groups: false, roles: false, tenant_id: false, eliza_agents: false },
  });
}

export class AppDelegationService {
  constructor(
    readonly store: AppDelegationStore,
    readonly consumeCode: (code: string) => Promise<AppAuthCodeRecord | null>,
    readonly now: () => Date = () => new Date(),
  ) {}

  async registration(clientId: string): Promise<AppClientRegistration> {
    const registration = await this.store.findRegistration(clientId);
    if (!registration)
      throw new AppDelegationError(
        401,
        "APP_CLIENT_UNAVAILABLE",
        "The registered application client is inactive or unavailable",
      );
    return registration;
  }

  async requireClient(clientId: string, secret: string): Promise<AppClientRegistration> {
    const registration = await this.registration(clientId);
    if (!(await verifyOidcClientSecret(oidcClient(registration), secret)))
      throw new AppDelegationError(
        401,
        "APP_CLIENT_INVALID",
        "Invalid application client credentials",
      );
    return registration;
  }

  async validateConsent(
    appId: string,
    binding: AppDelegationBinding,
  ): Promise<AppClientRegistration> {
    const parsed = appDelegationBindingSchema.parse(binding);
    const registration = await this.registration(parsed.clientId);
    if (
      registration.appId !== appId ||
      !isRegisteredRedirectUri(oidcClient(registration), parsed.redirectUri)
    )
      throw new AppDelegationError(
        400,
        "APP_CLIENT_BINDING_INVALID",
        "The application or exact return URI does not match this registration",
      );
    if (parsed.scopes.some((scope) => !registration.allowedScopes.includes(scope)))
      throw new AppDelegationError(
        403,
        "APP_SCOPE_DENIED",
        "The requested capability is not registered for this application",
      );
    return registration;
  }

  async consentBinding(
    appId: string,
    userId: string,
    binding: AppDelegationBinding,
  ): Promise<NonNullable<AppAuthCodeRecord["delegation"]>> {
    const registration = await this.validateConsent(appId, binding);
    const principal = await this.store.findPrincipal(appId, userId);
    if (!principal)
      throw new AppDelegationError(
        403,
        "APP_CONSENT_REQUIRED",
        "A current account and application consent are required",
      );
    return {
      ...binding,
      registrationRevision: registration.revision,
      consentId: principal.consentId,
    };
  }

  async exchange(
    clientId: string,
    secret: string,
    code: string,
    redirectUri: string,
  ): Promise<AppDelegationResult> {
    const registration = await this.requireClient(clientId, secret);
    const authorization = await this.consumeCode(code);
    const binding = authorization?.delegation;
    if (
      !authorization ||
      !binding ||
      authorization.expiresAt <= this.now().getTime() ||
      authorization.appId !== registration.appId ||
      binding.clientId !== clientId ||
      binding.registrationRevision !== registration.revision ||
      binding.redirectUri !== redirectUri
    )
      throw new AppDelegationError(
        401,
        "APP_AUTH_CODE_INVALID",
        "Authorization code is expired, used, or bound to another application registration",
      );
    await this.validateConsent(authorization.appId, {
      clientId: binding.clientId,
      redirectUri: binding.redirectUri,
      scopes: binding.scopes,
    });
    const principal = await this.store.findPrincipal(registration.appId, authorization.userId);
    if (!principal || principal.consentId !== binding.consentId)
      throw new AppDelegationError(
        403,
        "APP_CONSENT_REVOKED",
        "Application consent or account access changed; authorize again",
      );
    const token = `ead_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(this.now().getTime() + 7 * 24 * 60 * 60 * 1000);
    const stored = await this.store.saveGrant({
      tokenHash: await sha256Hex(token),
      authorizationCodeHash: await sha256Hex(code),
      clientId,
      appId: registration.appId,
      userId: principal.user.id,
      organizationId: principal.user.organizationId,
      consentId: principal.consentId,
      registrationRevision: registration.revision,
      scopes: binding.scopes,
      expiresAt,
    });
    if (!stored)
      throw new AppDelegationError(
        409,
        "APP_AUTH_CODE_REPLAY",
        "This authorization code has already issued a delegated credential",
      );
    return {
      token,
      billingEnvironment: registration.billingEnvironment,
      expiresAt: expiresAt.toISOString(),
      appId: registration.appId,
      scopes: binding.scopes,
      user: principal.user,
    };
  }

  async authorize(clientId: string, secret: string, token: string, scope: AppDelegationScope) {
    const registration = await this.requireClient(clientId, secret);
    if (!/^ead_[A-Za-z0-9_-]{43}$/.test(token))
      throw new AppDelegationError(401, "APP_GRANT_INVALID", "Invalid delegated credential");
    const grant = await this.store.findGrant(await sha256Hex(token));
    if (
      !grant ||
      grant.clientId !== clientId ||
      grant.appId !== registration.appId ||
      grant.registrationRevision !== registration.revision ||
      grant.expiresAt <= this.now()
    )
      throw new AppDelegationError(
        401,
        "APP_GRANT_REVOKED",
        "Delegated access has expired or was revoked",
      );
    if (!grant.scopes.includes(scope) || !registration.allowedScopes.includes(scope))
      throw new AppDelegationError(
        403,
        "APP_SCOPE_DENIED",
        "The user did not authorize this application capability",
      );
    const principal = await this.store.findPrincipal(registration.appId, grant.userId);
    if (
      !principal ||
      principal.consentId !== grant.consentId ||
      principal.user.organizationId !== grant.organizationId
    )
      throw new AppDelegationError(
        401,
        "APP_PRINCIPAL_CHANGED",
        "Account membership or app consent changed; authorize again",
      );
    return { registration, user: principal.user, scopes: grant.scopes };
  }

  async revoke(clientId: string, secret: string, token: string): Promise<void> {
    await this.requireClient(clientId, secret);
    if (!/^ead_[A-Za-z0-9_-]{43}$/.test(token))
      throw new AppDelegationError(400, "APP_GRANT_INVALID", "Invalid delegated credential");
    await this.store.revokeGrant(clientId, await sha256Hex(token), this.now());
  }
}
