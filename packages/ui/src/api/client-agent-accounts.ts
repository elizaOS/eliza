/**
 * Multi-account contracts and HTTP methods for model-provider credentials.
 * Importing this module installs the methods on ElizaClient while keeping the
 * account transport family independently reviewable from agent lifecycle APIs.
 */

import type {
  LinkedAccountConfig,
  LinkedAccountProviderId,
  ServiceRouteAccountStrategy,
} from "@elizaos/shared";
import { parseAccountsListResponse } from "./client-agent-accounts-validator";
import { ElizaClient } from "./client-base";

export type AccountStrategy = ServiceRouteAccountStrategy;

export type {
  LinkedAccountAccountSource,
  LinkedAccountConfig,
  LinkedAccountHealth,
  LinkedAccountHealthDetail,
  LinkedAccountProviderId,
  LinkedAccountUsage,
} from "@elizaos/shared";

export interface AccountWithCredentialFlag extends LinkedAccountConfig {
  hasCredential: boolean;
}

export interface AccountsListProvider {
  providerId: LinkedAccountProviderId;
  strategy: AccountStrategy;
  accounts: AccountWithCredentialFlag[];
}

export interface AccountsListResponse {
  providers: AccountsListProvider[];
}

export interface AccountTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  error?: string;
  /** Bounded official provider catalog sample returned by a direct-key probe. */
  modelIds?: string[];
  modelCatalogTruncated?: boolean;
}

export interface AccountRefreshUsageResult {
  account: LinkedAccountConfig;
  source: "pool" | "inline-probe" | "direct-probe" | "coding-plan-probe";
}

export interface AccountOAuthStartResult {
  sessionId: string;
  authUrl: string;
  needsCodeSubmission: boolean;
  userCode?: string;
}

declare module "./client-base" {
  interface ElizaClient {
    listAccounts(): Promise<AccountsListResponse>;
    createApiKeyAccount(
      providerId: LinkedAccountProviderId,
      body: { label: string; apiKey: string },
    ): Promise<LinkedAccountConfig>;
    patchAccount(
      providerId: LinkedAccountProviderId,
      accountId: string,
      body: Partial<{ label: string; enabled: boolean; priority: number }>,
    ): Promise<LinkedAccountConfig>;
    deleteAccount(
      providerId: LinkedAccountProviderId,
      accountId: string,
    ): Promise<{ deleted: boolean }>;
    testAccount(
      providerId: LinkedAccountProviderId,
      accountId: string,
    ): Promise<AccountTestResult>;
    refreshAccountUsage(
      providerId: LinkedAccountProviderId,
      accountId: string,
    ): Promise<AccountRefreshUsageResult>;
    startAccountOAuth(
      providerId: LinkedAccountProviderId,
      body: { label: string; mode?: "auto" | "localhost" | "device" },
    ): Promise<AccountOAuthStartResult>;
    submitAccountOAuthCode(
      providerId: LinkedAccountProviderId,
      body: { sessionId: string; code: string },
    ): Promise<{ accepted: boolean }>;
    cancelAccountOAuth(
      providerId: LinkedAccountProviderId,
      body: { sessionId: string },
    ): Promise<{ cancelled: boolean }>;
    patchProviderStrategy(
      providerId: LinkedAccountProviderId,
      body: { strategy: AccountStrategy },
    ): Promise<{
      providerId: LinkedAccountProviderId;
      strategy: AccountStrategy;
    }>;
  }
}

ElizaClient.prototype.listAccounts = async function (this: ElizaClient) {
  // The agent is a separate process on an operator-controlled host, so its
  // reply is untrusted input: validate the shape once here rather than letting
  // a malformed provider list surface as undefined fields in the panel.
  const response = await this.fetch<unknown>("/api/accounts");
  return parseAccountsListResponse(response);
};

ElizaClient.prototype.createApiKeyAccount = async function (
  this: ElizaClient,
  providerId,
  body,
) {
  return this.fetch<LinkedAccountConfig>(
    `/api/accounts/${encodeURIComponent(providerId)}`,
    {
      method: "POST",
      body: JSON.stringify({ source: "api-key", ...body }),
    },
  );
};

ElizaClient.prototype.patchAccount = async function (
  this: ElizaClient,
  providerId,
  accountId,
  body,
) {
  return this.fetch<LinkedAccountConfig>(
    `/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
};

ElizaClient.prototype.deleteAccount = async function (
  this: ElizaClient,
  providerId,
  accountId,
) {
  return this.fetch<{ deleted: boolean }>(
    `/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.testAccount = async function (
  this: ElizaClient,
  providerId,
  accountId,
) {
  return this.fetch<AccountTestResult>(
    `/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}/test`,
    { method: "POST" },
  );
};

ElizaClient.prototype.refreshAccountUsage = async function (
  this: ElizaClient,
  providerId,
  accountId,
) {
  return this.fetch<AccountRefreshUsageResult>(
    `/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}/refresh-usage`,
    { method: "POST" },
  );
};

ElizaClient.prototype.startAccountOAuth = async function (
  this: ElizaClient,
  providerId,
  body,
) {
  return this.fetch<AccountOAuthStartResult>(
    `/api/accounts/${encodeURIComponent(providerId)}/oauth/start`,
    { method: "POST", body: JSON.stringify(body) },
  );
};

ElizaClient.prototype.submitAccountOAuthCode = async function (
  this: ElizaClient,
  providerId,
  body,
) {
  return this.fetch<{ accepted: boolean }>(
    `/api/accounts/${encodeURIComponent(providerId)}/oauth/submit-code`,
    { method: "POST", body: JSON.stringify(body) },
  );
};

ElizaClient.prototype.cancelAccountOAuth = async function (
  this: ElizaClient,
  providerId,
  body,
) {
  return this.fetch<{ cancelled: boolean }>(
    `/api/accounts/${encodeURIComponent(providerId)}/oauth/cancel`,
    { method: "POST", body: JSON.stringify(body) },
  );
};

ElizaClient.prototype.patchProviderStrategy = async function (
  this: ElizaClient,
  providerId,
  body,
) {
  return this.fetch<{
    providerId: LinkedAccountProviderId;
    strategy: AccountStrategy;
  }>(`/api/providers/${encodeURIComponent(providerId)}/strategy`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
};
