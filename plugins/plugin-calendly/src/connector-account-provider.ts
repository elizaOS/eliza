/**
 * Calendly ConnectorAccountManager provider.
 *
 * Bridges plugin-calendly to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD + OAuth surface can list, create, patch, delete, and run
 * the OAuth flow for Calendly accounts. Personal access tokens remain
 * supported (legacy CALENDLY_ACCESS_TOKEN); OAuth flows are exposed via
 * startOAuth/completeOAuth.
 *
 * Account model:
 *   - role "OWNER" — Calendly user / organization owner
 *   - accountKey  — Calendly user URI (or organization URI when available)
 *   - purpose     — ["admin", "automation"]
 */

import {
  type ConnectorAccount,
  type ConnectorAccountManager,
  type ConnectorAccountPatch,
  type ConnectorAccountProvider,
  type ConnectorAccountPurpose,
  type ConnectorOAuthCallbackRequest,
  type ConnectorOAuthCallbackResult,
  type ConnectorOAuthStartRequest,
  type ConnectorOAuthStartResult,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import { readCalendlyAccounts, resolveCalendlyAccountId } from "./accounts.js";
import { persistConnectorCredentialRefs } from "./connector-credential-refs.js";

export const CALENDLY_PROVIDER_NAME = "calendly";

const CALENDLY_AUTHORIZATION_ENDPOINT =
  "https://auth.calendly.com/oauth/authorize";
const CALENDLY_TOKEN_ENDPOINT = "https://auth.calendly.com/oauth/token";
const CALENDLY_USER_ENDPOINT = "https://api.calendly.com/users/me";

const DEFAULT_PURPOSES: ConnectorAccountPurpose[] = [
  "admin" as ConnectorAccountPurpose,
  "automation" as ConnectorAccountPurpose,
];

interface CalendlyTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  owner?: string;
  organization?: string;
  error?: string;
  error_description?: string;
}

interface CalendlyUserPayload {
  resource?: {
    uri?: string;
    name?: string;
    email?: string;
    scheduling_url?: string;
    timezone?: string;
    current_organization?: string;
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  return nonEmptyString(runtime.getSetting?.(key));
}

function readClientConfig(runtime: IAgentRuntime): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = readSetting(runtime, "CALENDLY_OAUTH_CLIENT_ID");
  const clientSecret = readSetting(runtime, "CALENDLY_OAUTH_CLIENT_SECRET");
  const redirectUri = readSetting(runtime, "CALENDLY_OAUTH_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Calendly OAuth requires CALENDLY_OAUTH_CLIENT_ID, CALENDLY_OAUTH_CLIENT_SECRET, and CALENDLY_OAUTH_REDIRECT_URI to be configured.",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

async function exchangeCodeForToken(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<CalendlyTokenResponse> {
  const response = await fetch(CALENDLY_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Calendly token exchange failed with ${response.status}: ${body}`,
    );
  }
  const parsed = (await response.json()) as CalendlyTokenResponse;
  if (parsed.error) {
    throw new Error(
      `Calendly token exchange returned error ${parsed.error}: ${parsed.error_description ?? "no description"}`,
    );
  }
  if (!parsed.access_token) {
    throw new Error("Calendly token exchange returned no access_token.");
  }
  return parsed;
}

async function fetchCalendlyUser(
  accessToken: string,
): Promise<CalendlyUserPayload> {
  const response = await fetch(CALENDLY_USER_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Calendly /users/me request failed with ${response.status}`,
    );
  }
  return (await response.json()) as CalendlyUserPayload;
}

function synthesizeEnvAccounts(runtime: IAgentRuntime): ConnectorAccount[] {
  const now = Date.now();
  const defaultAccountId = resolveCalendlyAccountId(runtime);
  return readCalendlyAccounts(runtime).map((account) => ({
    id: account.accountId,
    provider: CALENDLY_PROVIDER_NAME,
    label: account.label ?? `Calendly (${account.accountId})`,
    role: "OWNER" as const,
    purpose: DEFAULT_PURPOSES,
    accessGate: "open" as const,
    status: "connected" as const,
    displayHandle: account.accountId,
    createdAt: now,
    updatedAt: now,
    metadata: {
      authMethod: "personal_access_token",
      source: "legacy",
      isDefault: account.accountId === defaultAccountId,
    },
  }));
}

function normalizePurposes(
  purpose: ConnectorAccountPatch["purpose"] | undefined,
  fallback: ConnectorAccountPurpose[],
): ConnectorAccountPurpose[] {
  if (Array.isArray(purpose)) return purpose;
  if (typeof purpose === "string" && purpose.trim()) return [purpose];
  return fallback;
}

function mergeStoredAccountPatch(
  account: ConnectorAccount,
  patch: ConnectorAccountPatch,
): ConnectorAccount {
  return {
    ...account,
    ...patch,
    provider: CALENDLY_PROVIDER_NAME,
    id: account.id,
    purpose: normalizePurposes(patch.purpose, account.purpose),
    externalId:
      patch.externalId === undefined
        ? account.externalId
        : (patch.externalId ?? undefined),
    displayHandle:
      patch.displayHandle === undefined
        ? account.displayHandle
        : (patch.displayHandle ?? undefined),
    ownerBindingId:
      patch.ownerBindingId === undefined
        ? account.ownerBindingId
        : (patch.ownerBindingId ?? undefined),
    ownerIdentityId:
      patch.ownerIdentityId === undefined
        ? account.ownerIdentityId
        : (patch.ownerIdentityId ?? undefined),
    metadata: patch.metadata ?? account.metadata,
    createdAt: account.createdAt,
  };
}

/**
 * Build the Calendly ConnectorAccountManager provider.
 */
export function createCalendlyConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: CALENDLY_PROVIDER_NAME,
    label: "Calendly",

    listAccounts: async (
      manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      const stored = await manager
        .getStorage()
        .listAccounts(CALENDLY_PROVIDER_NAME);
      const storedById = new Set(stored.map((account) => account.id));
      const synthesized = synthesizeEnvAccounts(runtime).filter(
        (account) => !storedById.has(account.id),
      );
      return [...stored, ...synthesized];
    },

    createAccount: async (
      input: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return {
        ...input,
        provider: CALENDLY_PROVIDER_NAME,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? DEFAULT_PURPOSES,
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },

    patchAccount: async (
      accountId: string,
      patch: ConnectorAccountPatch,
      manager: ConnectorAccountManager,
    ) => {
      const existing = await manager
        .getStorage()
        .getAccount(CALENDLY_PROVIDER_NAME, accountId);
      if (existing) {
        return mergeStoredAccountPatch(existing, patch);
      }
      return { ...patch, provider: CALENDLY_PROVIDER_NAME };
    },

    deleteAccount: async (
      _accountId: string,
      _manager: ConnectorAccountManager,
    ): Promise<void> => {
      // Credential cleanup is the credential store's responsibility.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorOAuthStartResult> => {
      const config = readClientConfig(runtime);
      const redirectUri = request.redirectUri ?? config.redirectUri;

      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state: request.flow.state,
      });

      return {
        authUrl: `${CALENDLY_AUTHORIZATION_ENDPOINT}?${params.toString()}`,
        metadata: {
          ...request.metadata,
          redirectUri,
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
      manager: ConnectorAccountManager,
    ): Promise<ConnectorOAuthCallbackResult> => {
      const code = nonEmptyString(request.code);
      if (!code) {
        throw new Error(
          "Calendly OAuth callback is missing an authorization code.",
        );
      }

      const config = readClientConfig(runtime);
      const redirectUri =
        nonEmptyString(request.flow.redirectUri) ?? config.redirectUri;

      const tokens = await exchangeCodeForToken({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri,
        code,
      });

      if (!tokens.access_token) {
        throw new Error("Calendly token exchange returned no access_token.");
      }

      const userPayload = await fetchCalendlyUser(tokens.access_token);
      const user = userPayload.resource;
      const externalId =
        nonEmptyString(user?.uri) ??
        nonEmptyString(tokens.owner) ??
        nonEmptyString(tokens.organization);
      if (!externalId) {
        throw new Error(
          "Calendly /users/me payload did not include a usable URI.",
        );
      }
      const expiresAt =
        typeof tokens.expires_in === "number"
          ? Date.now() + tokens.expires_in * 1000
          : undefined;
      const oauthCredentialVersion = String(Date.now());
      const accountMetadata = {
        authMethod: "oauth",
        userUri: nonEmptyString(user?.uri) ?? null,
        email: nonEmptyString(user?.email) ?? null,
        name: nonEmptyString(user?.name) ?? null,
        schedulingUrl: nonEmptyString(user?.scheduling_url) ?? null,
        timezone: nonEmptyString(user?.timezone) ?? null,
        organizationUri: nonEmptyString(user?.current_organization) ?? null,
        tokenType: nonEmptyString(tokens.token_type) ?? "bearer",
        hasRefreshToken: Boolean(tokens.refresh_token),
        expiresAt,
        oauthCredentialVersion,
      };
      const pendingAccount = await manager.upsertAccount(
        CALENDLY_PROVIDER_NAME,
        {
          provider: CALENDLY_PROVIDER_NAME,
          role: "OWNER",
          purpose: DEFAULT_PURPOSES,
          accessGate: "open",
          status: "pending",
          externalId,
          displayHandle:
            nonEmptyString(user?.email) ??
            nonEmptyString(user?.name) ??
            externalId,
          label: nonEmptyString(user?.name) ?? "Calendly",
          metadata: accountMetadata,
        },
        request.flow.accountId,
      );
      const credentialPersist = await persistConnectorCredentialRefs({
        runtime,
        manager,
        provider: CALENDLY_PROVIDER_NAME,
        accountIdForRef: pendingAccount.id,
        storageAccountId: pendingAccount.id,
        caller: "plugin-calendly",
        credentials: [
          {
            credentialType: "oauth.tokens",
            value: JSON.stringify({
              access_token: tokens.access_token,
              ...(tokens.refresh_token
                ? { refresh_token: tokens.refresh_token }
                : {}),
              token_type: nonEmptyString(tokens.token_type) ?? "bearer",
              ...(tokens.scope ? { scope: tokens.scope } : {}),
              ...(tokens.owner ? { owner: tokens.owner } : {}),
              ...(tokens.organization
                ? { organization: tokens.organization }
                : {}),
              ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
            }),
            ...(expiresAt !== undefined ? { expiresAt } : {}),
            metadata: {
              provider: CALENDLY_PROVIDER_NAME,
              hasRefreshToken: Boolean(tokens.refresh_token),
            },
          },
        ],
      });

      const accountPatch: ConnectorAccountPatch & {
        provider: string;
        id: string;
      } = {
        ...pendingAccount,
        id: pendingAccount.id,
        provider: CALENDLY_PROVIDER_NAME,
        status: "connected",
        metadata: {
          ...accountMetadata,
          credentialRefs: credentialPersist.refs,
          credentialRefStorage: {
            vaultAvailable: credentialPersist.vaultAvailable,
            storageAvailable: credentialPersist.storageAvailable,
          },
        },
      };

      logger.info(
        {
          src: "plugin:calendly:connector",
          userUri: user?.uri ?? null,
        },
        "Calendly OAuth completed",
      );

      return {
        account: accountPatch,
        flow: { status: "completed" },
      };
    },
  };
}
