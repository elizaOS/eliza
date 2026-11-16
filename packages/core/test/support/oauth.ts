// spec/core/index.md, "Each boundary operation has one owning layer"
import { createHash, randomBytes } from "node:crypto";
import {
  type ConnectorAccount,
  type ConnectorAccountProvider,
  type ConnectorOAuthCallbackRequest,
  type ConnectorOAuthCallbackResult,
  type ConnectorOAuthCompletionInput,
  type ConnectorOAuthStartRequest,
  type ConnectorOAuthStartResult,
} from "../../src/connectors/account-manager.vibe";

export class OAuthProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OAuthProviderError";
  }
}

export interface OAuthGrant {
  accountId: string;
  externalId: string;
  scopes: string[];
  label?: string;
  accessToken: string;
  refreshToken: string;
  issuedAt: number;
}

export interface ScriptedOAuthOptions {
  name?: string;
  ttlMs?: number;
  inventory?: boolean;
}

export interface ScriptedOAuth {
  provider: ConnectorAccountProvider;
  seen: Array<{ step: string; args: unknown }>;
  grants: ReadonlyMap<string, OAuthGrant>;
  consent(authUrl: string, externalId?: string): ConnectorOAuthCompletionInput;
  deny(authUrl: string): ConnectorOAuthCompletionInput;
  refresh(refreshToken: string): { accessToken: string; refreshToken: string };
}

interface Authorization {
  challenge: string;
  scopes: string[];
  label?: string;
}

interface IssuedCode {
  state: string;
  externalId: string;
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function stateOf(authUrl: string): string {
  return new URL(authUrl).searchParams.get("state") ?? "";
}

function grantAccount(provider: string, grant: OAuthGrant): ConnectorAccount {
  return {
    id: grant.accountId,
    provider,
    label: grant.label,
    role: "OWNER",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    externalId: grant.externalId,
    displayHandle: `@${grant.externalId}`,
    createdAt: grant.issuedAt,
    updatedAt: grant.issuedAt,
    metadata: { scopes: grant.scopes, grant: { issuedAt: grant.issuedAt, tokenType: "Bearer" } },
  };
}

export function scriptedOAuthProvider(options: ScriptedOAuthOptions = {}): ScriptedOAuth {
  const name = options.name ?? "google";
  const providerId = name.trim().toLowerCase();
  const host = `accounts.${providerId}.test`;
  const seen: Array<{ step: string; args: unknown }> = [];
  const authorizations = new Map<string, Authorization>();
  const codes = new Map<string, IssuedCode>();
  const grants = new Map<string, OAuthGrant>();

  const startOAuth = (request: ConnectorOAuthStartRequest): Promise<ConnectorOAuthStartResult> => {
    seen.push({ step: "startOAuth", args: request });
    const codeVerifier = secret();
    const scopes = request.scopes ?? ["openid"];
    const challenge = s256(codeVerifier);
    authorizations.set(request.flow.state, { challenge, scopes, label: request.label });
    const authUrl = new URL(`https://${host}/o/oauth2/auth`);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: "eliza-core-test",
      ...(request.redirectUri === undefined ? {} : { redirect_uri: request.redirectUri }),
      scope: scopes.join(" "),
      state: request.flow.state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return Promise.resolve({
      authUrl: authUrl.toString(),
      codeVerifier,
      ...(options.ttlMs === undefined ? {} : { expiresAt: Date.now() + options.ttlMs }),
    });
  };

  const completeOAuth = (request: ConnectorOAuthCallbackRequest): Promise<ConnectorOAuthCallbackResult> => {
    seen.push({ step: "completeOAuth", args: request });
    const issued = request.code === undefined ? undefined : codes.get(request.code);
    if (request.code !== undefined) codes.delete(request.code);
    const authorization = authorizations.get(request.flow.state);
    if (!issued || !authorization || issued.state !== request.flow.state) {
      return Promise.reject(new OAuthProviderError("invalid_grant", "The authorization code is invalid or was already used"));
    }
    if (request.flow.codeVerifier === undefined || s256(request.flow.codeVerifier) !== authorization.challenge) {
      return Promise.reject(new OAuthProviderError("invalid_grant", "The code verifier does not match the code challenge"));
    }
    authorizations.delete(request.flow.state);
    const grant: OAuthGrant = {
      accountId: request.flow.accountId ?? `${request.provider}-${issued.externalId}`,
      externalId: issued.externalId,
      scopes: authorization.scopes,
      label: authorization.label,
      accessToken: secret(),
      refreshToken: secret(),
      issuedAt: Date.now(),
    };
    grants.set(grant.accountId, grant);
    return Promise.resolve({ account: grantAccount(request.provider, grant) });
  };

  const listAccounts = (): Promise<ConnectorAccount[]> => {
    seen.push({ step: "listAccounts", args: [...grants.keys()] });
    return Promise.resolve([...grants.values()].map((grant) => grantAccount(providerId, grant)));
  };

  const provider: ConnectorAccountProvider = {
    provider: name,
    label: `Scripted ${name.trim()} OAuth`,
    startOAuth,
    completeOAuth,
    ...(options.inventory ? { statusAuthority: "provider" as const, listAccounts } : {}),
  };

  return {
    provider,
    seen,
    grants,
    consent(authUrl, externalId = "user-1") {
      const state = stateOf(authUrl);
      if (!authorizations.has(state)) {
        throw new OAuthProviderError("invalid_request", `No pending authorization for state ${state}`);
      }
      const code = secret();
      codes.set(code, { state, externalId });
      seen.push({ step: "consent", args: { state, externalId } });
      return { state, code, query: { state, code } };
    },
    deny(authUrl) {
      const state = stateOf(authUrl);
      const errorDescription = "The user denied access";
      authorizations.delete(state);
      seen.push({ step: "deny", args: { state } });
      return {
        state,
        error: "access_denied",
        errorDescription,
        query: { state, error: "access_denied", error_description: errorDescription },
      };
    },
    refresh(refreshToken) {
      const grant = [...grants.values()].find((candidate) => candidate.refreshToken === refreshToken);
      seen.push({ step: "refresh", args: { found: grant !== undefined } });
      if (!grant) throw new OAuthProviderError("invalid_grant", "The refresh token is invalid or was rotated");
      grant.accessToken = secret();
      grant.refreshToken = secret();
      return { accessToken: grant.accessToken, refreshToken: grant.refreshToken };
    },
  };
}
