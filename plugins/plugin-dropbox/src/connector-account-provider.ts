/**
 * Dropbox ConnectorAccountManager provider. Bridges plugin-dropbox to the core
 * ConnectorAccountManager so the generic HTTP CRUD + OAuth surface can list,
 * create, patch, delete, and run the OAuth flow for Dropbox accounts.
 *
 * Dropbox OAuth uses PKCE and `token_access_type=offline`, so a completed
 * grant yields a short-lived access token plus a refresh token; the credential
 * resolver owns refresh. The default requested scopes are the read set plus
 * the explicit write escalation scope pair — callers may pass `scopes` to
 * narrow or widen, and the granted scope string is recorded on the account.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type ConnectorAccount,
  type ConnectorAccountManager,
  type ConnectorAccountPatch,
  type ConnectorAccountProvider,
  type ConnectorOAuthCallbackRequest,
  type ConnectorOAuthCallbackResult,
  type ConnectorOAuthStartRequest,
  type ConnectorOAuthStartResult,
  ElizaError,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import { persistConnectorCredentialRefs } from "@elizaos/plugin-google-workspace/connector-credential-refs";
import { DROPBOX_SERVICE_NAME } from "./types.js";

export const DROPBOX_AUTHORIZATION_ENDPOINT = "https://www.dropbox.com/oauth2/authorize";
export const DROPBOX_TOKEN_ENDPOINT = "https://api.dropboxapi.com/oauth2/token";
export const DROPBOX_CURRENT_ACCOUNT_ENDPOINT =
  "https://api.dropboxapi.com/2/users/get_current_account";
/** Maximum time allowed for one Dropbox OAuth or identity request. */
export const DROPBOX_OAUTH_FETCH_TIMEOUT_MS = 15_000;

/** Read-default scope set; write scopes are the explicit escalation. */
export const DROPBOX_READ_SCOPES = [
  "account_info.read",
  "files.metadata.read",
  "files.content.read",
] as const;
export const DROPBOX_WRITE_SCOPES = ["files.metadata.write", "files.content.write"] as const;

interface DropboxTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
  refresh_token?: string;
  scope?: string;
  account_id?: string;
  team_id?: string;
  uid?: string;
}

interface DropboxIdentity {
  account_id?: string;
  email?: string;
  name?: { display_name?: string };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readClientConfig(runtime: IAgentRuntime): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = nonEmptyString(runtime.getSetting?.("DROPBOX_CLIENT_ID"));
  const clientSecret = nonEmptyString(runtime.getSetting?.("DROPBOX_CLIENT_SECRET"));
  const redirectUri = nonEmptyString(runtime.getSetting?.("DROPBOX_REDIRECT_URI"));
  if (!clientId || !clientSecret || !redirectUri) {
    throw new ElizaError(
      "Dropbox OAuth requires DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET, and DROPBOX_REDIRECT_URI to be configured.",
      { code: "DROPBOX_OAUTH_NOT_CONFIGURED", severity: "fatal" }
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function normalizeRequestedScopes(scopes: readonly string[] | undefined): string[] {
  if (scopes === undefined) {
    return [...DROPBOX_READ_SCOPES, ...DROPBOX_WRITE_SCOPES];
  }
  const known = new Set<string>([...DROPBOX_READ_SCOPES, ...DROPBOX_WRITE_SCOPES]);
  const requested = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (!trimmed) continue;
    if (!known.has(trimmed)) {
      throw new ElizaError(`Dropbox OAuth scope is not recognized: ${trimmed}`, {
        code: "DROPBOX_OAUTH_SCOPE_UNRECOGNIZED",
        context: { scope: trimmed },
        severity: "fatal",
      });
    }
    requested.add(trimmed);
  }
  if (requested.size === 0) {
    throw new ElizaError("Dropbox OAuth requires at least one recognized scope.", {
      code: "DROPBOX_OAUTH_SCOPE_REQUIRED",
      context: { scopes: [...scopes] },
      severity: "fatal",
    });
  }
  requested.add("account_info.read");
  return [...requested];
}

export async function exchangeDropboxAuthorizationCode(
  args: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier?: string;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
  tokenEndpoint: string = DROPBOX_TOKEN_ENDPOINT,
  timeoutMs: number = DROPBOX_OAUTH_FETCH_TIMEOUT_MS
): Promise<DropboxTokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  if (args.codeVerifier) {
    params.set("code_verifier", args.codeVerifier);
  }
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new ElizaError(`Dropbox token exchange failed with ${response.status}.`, {
      code: "DROPBOX_OAUTH_TOKEN_EXCHANGE_FAILED",
      context: { status: response.status, body },
      severity: "fatal",
    });
  }
  const parsed = (await response.json()) as DropboxTokenResponse;
  if (!nonEmptyString(parsed?.access_token) || !Number.isFinite(parsed?.expires_in)) {
    throw new ElizaError("Dropbox token exchange returned an invalid payload.", {
      code: "DROPBOX_OAUTH_TOKEN_PAYLOAD_INVALID",
      severity: "fatal",
    });
  }
  return parsed;
}

async function fetchDropboxIdentity(
  accessToken: string,
  fetchImpl: typeof fetch,
  endpoint: string
): Promise<DropboxIdentity> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(DROPBOX_OAUTH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ElizaError(`Dropbox identity request failed with ${response.status}.`, {
      code: "DROPBOX_OAUTH_IDENTITY_FAILED",
      context: { status: response.status },
      severity: "fatal",
    });
  }
  const parsed = (await response.json()) as DropboxIdentity;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ElizaError("Dropbox identity returned an invalid payload.", {
      code: "DROPBOX_OAUTH_IDENTITY_INVALID",
      severity: "fatal",
    });
  }
  return parsed;
}

/**
 * Build the Dropbox ConnectorAccountProvider: account CRUD adapters plus the
 * PKCE offline OAuth flow that records account identity and granted scopes
 * and persists the token set (access + refresh) as a durable credential ref.
 */
export function createDropboxConnectorAccountProvider(
  runtime: IAgentRuntime,
  options: {
    fetchImpl?: typeof fetch;
    tokenEndpoint?: string;
    identityEndpoint?: string;
  } = {}
): ConnectorAccountProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const tokenEndpoint = options.tokenEndpoint ?? DROPBOX_TOKEN_ENDPOINT;
  const identityEndpoint = options.identityEndpoint ?? DROPBOX_CURRENT_ACCOUNT_ENDPOINT;
  return {
    provider: DROPBOX_SERVICE_NAME,
    label: "Dropbox",

    listAccounts: async (manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      return manager.getStorage().listAccounts(DROPBOX_SERVICE_NAME);
    },

    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: DROPBOX_SERVICE_NAME,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? ["drive"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },

    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager
    ) => {
      return { ...patch, provider: DROPBOX_SERVICE_NAME };
    },

    deleteAccount: async (_accountId: string, _manager: ConnectorAccountManager): Promise<void> => {
      // Credential cleanup is the credential store's responsibility; the
      // manager removes the account row after this resolves.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
      _manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthStartResult> => {
      const config = readClientConfig(runtime);
      const scopes = normalizeRequestedScopes(request.scopes);
      const codeVerifier = randomBytes(64).toString("base64url");
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        state: request.flow.state,
        token_access_type: "offline",
        scope: scopes.join(" "),
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return {
        authUrl: `${DROPBOX_AUTHORIZATION_ENDPOINT}?${params.toString()}`,
        redirectUri: config.redirectUri,
        codeVerifier,
        metadata: {
          ...request.metadata,
          requestedScopes: scopes,
          redirectUri: config.redirectUri,
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
      manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthCallbackResult> => {
      const code = nonEmptyString(request.code);
      if (!code) {
        throw new ElizaError("Dropbox OAuth callback is missing an authorization code.", {
          code: "DROPBOX_OAUTH_CODE_MISSING",
          severity: "fatal",
        });
      }
      const config = readClientConfig(runtime);
      const redirectUri =
        nonEmptyString(request.flow.redirectUri) ??
        nonEmptyString(
          (request.flow.metadata as Record<string, unknown> | undefined)?.redirectUri
        ) ??
        config.redirectUri;

      const tokens = await exchangeDropboxAuthorizationCode(
        {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri,
          code,
          codeVerifier: request.flow.codeVerifier,
        },
        fetchImpl,
        tokenEndpoint
      );

      let externalId = nonEmptyString(tokens.account_id);
      let identity: DropboxIdentity = {};
      // Identity enrichment is required when the token payload omits
      // account_id; otherwise it only adds display name/email.
      if (!externalId) {
        identity = await fetchDropboxIdentity(tokens.access_token, fetchImpl, identityEndpoint);
        externalId = nonEmptyString(identity.account_id);
      } else {
        // error-policy:J4 display metadata is optional; a failed identity call
        // degrades to an account labeled "Dropbox" while the grant stands.
        identity = await fetchDropboxIdentity(
          tokens.access_token,
          fetchImpl,
          identityEndpoint
        ).catch(() => ({}));
      }
      if (!externalId) {
        throw new ElizaError("Dropbox OAuth response did not include an account id.", {
          code: "DROPBOX_OAUTH_IDENTITY_MISSING",
          severity: "fatal",
        });
      }

      const grantedScopes = nonEmptyString(tokens.scope)?.split(/\s+/).filter(Boolean) ?? [];
      const displayName = nonEmptyString(identity.name?.display_name);
      const email = nonEmptyString(identity.email);
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      const oauthCredentialVersion = String(Date.now());
      const accountMetadata = {
        email: email ?? null,
        name: displayName ?? null,
        teamId: nonEmptyString(tokens.team_id) ?? null,
        grantedScopes,
        hasRefreshToken: Boolean(tokens.refresh_token),
        expiresAt,
        oauthCredentialVersion,
      };

      const pendingAccount = await manager.upsertAccount(
        DROPBOX_SERVICE_NAME,
        {
          provider: DROPBOX_SERVICE_NAME,
          role: "OWNER",
          purpose: ["drive"],
          accessGate: "open",
          status: "pending",
          externalId,
          displayHandle: email ?? displayName,
          label: displayName ?? email ?? "Dropbox",
          metadata: accountMetadata,
        },
        request.flow.accountId
      );

      const credentialPersist = await persistConnectorCredentialRefs({
        runtime,
        manager,
        provider: DROPBOX_SERVICE_NAME,
        accountIdForRef: pendingAccount.id,
        storageAccountId: pendingAccount.id,
        caller: "plugin-dropbox",
        credentials: [
          {
            credentialType: "oauth.tokens",
            value: JSON.stringify({
              access_token: tokens.access_token,
              ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
              token_type: tokens.token_type ?? "bearer",
              scope: grantedScopes.join(" "),
              account_id: externalId,
              expiry_date: expiresAt,
            }),
            expiresAt,
            metadata: {
              provider: DROPBOX_SERVICE_NAME,
              hasRefreshToken: Boolean(tokens.refresh_token),
            },
          },
        ],
      });

      logger.info(
        { src: "plugin:dropbox:connector", externalId, grantedScopes },
        "Dropbox OAuth completed"
      );

      return {
        account: {
          ...pendingAccount,
          id: pendingAccount.id,
          provider: DROPBOX_SERVICE_NAME,
          status: "connected",
          metadata: {
            ...accountMetadata,
            credentialRefs: credentialPersist.refs,
            credentialRefStorage: {
              vaultAvailable: credentialPersist.vaultAvailable,
              storageAvailable: credentialPersist.storageAvailable,
            },
          },
        },
        flow: { status: "completed" },
      };
    },
  };
}
