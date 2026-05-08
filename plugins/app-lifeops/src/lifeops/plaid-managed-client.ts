/**
 * Eliza-runtime client for Eliza Cloud's Plaid bridge endpoints.
 *
 * Pattern matches the LifeOps managed-client convention: read the cloud apiKey from
 * loadElizaConfig() / ELIZAOS_CLOUD_API_KEY, hit the cloud at
 * /api/v1/eliza/plaid/*, and surface a typed PlaidManagedClientError on
 * non-2xx responses so callers can show actionable messages.
 *
 * The cloud API holds the long-lived Plaid `access_token` for transaction
 * sync. The Eliza runtime never sees Plaid client secrets, only the cloud
 * api key.
 */

import {
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
} from "@elizaos/plugin-elizacloud/cloud/base-url";
import { loadElizaConfig } from "@elizaos/agent/config/config";

const PLAID_REQUEST_TIMEOUT_MS = 30_000;

export class PlaidManagedClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlaidManagedClientError";
  }
}

interface ResolvedCloudConfig {
  configured: boolean;
  apiKey: string | null;
  apiBaseUrl: string;
  siteUrl: string;
}

function normalizeApiKey(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase() === "[REDACTED]" ? null : trimmed;
}

function resolveCloudConfig(): ResolvedCloudConfig {
  let configKey: string | null = null;
  let configBase: string | null = null;
  try {
    const config = loadElizaConfig();
    const cloud =
      config.cloud && typeof config.cloud === "object"
        ? (config.cloud as Record<string, unknown>)
        : null;
    if (cloud) {
      if (typeof cloud.apiKey === "string") {
        configKey = normalizeApiKey(cloud.apiKey);
      }
      if (typeof cloud.baseUrl === "string" && cloud.baseUrl.trim().length) {
        configBase = cloud.baseUrl.trim();
      }
    }
  } catch {
    // Fall through to env.
  }
  const apiKey =
    configKey ?? normalizeApiKey(process.env.ELIZAOS_CLOUD_API_KEY);
  const baseUrl = configBase ?? process.env.ELIZAOS_CLOUD_BASE_URL ?? undefined;
  return {
    configured: Boolean(apiKey),
    apiKey,
    apiBaseUrl: resolveCloudApiBaseUrl(baseUrl),
    siteUrl: normalizeCloudSiteUrl(baseUrl),
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`.trim();
    const text = await response.text();
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text) as {
          error?: string;
          message?: string;
        };
        detail = parsed.message ?? parsed.error ?? text.slice(0, 240);
      } catch {
        detail = text.slice(0, 240);
      }
    }
    throw new PlaidManagedClientError(response.status, detail);
  }
  return (await response.json()) as T;
}

export interface PlaidLinkTokenResponse {
  linkToken: string;
  expiration: string;
  environment: "sandbox" | "development" | "production";
}

export interface PlaidExchangeResponse {
  accessToken: string;
  itemId: string;
  institution: {
    institutionId: string;
    institutionName: string;
    primaryAccountMask: string | null;
    accounts: Array<{
      accountId: string;
      name: string;
      mask: string | null;
      type: string;
      subtype: string | null;
    }>;
  };
}

export interface PlaidSyncResponse {
  added: PlaidTransactionDto[];
  modified: PlaidTransactionDto[];
  removed: Array<{ transaction_id: string }>;
  nextCursor: string;
  hasMore: boolean;
}

export interface PlaidTransactionDto {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  category: string[] | null;
  personal_finance_category: {
    primary: string;
    detailed: string;
  } | null;
}

export class PlaidManagedClient {
  constructor(
    private readonly configSource: () => ResolvedCloudConfig = resolveCloudConfig,
  ) {}

  private requireConfig(): ResolvedCloudConfig & { apiKey: string } {
    const config = this.configSource();
    if (!config.apiKey) {
      throw new PlaidManagedClientError(409, "Eliza Cloud is not connected.");
    }
    return { ...config, apiKey: config.apiKey };
  }

  get configured(): boolean {
    return this.configSource().configured;
  }

  async createLinkToken(): Promise<PlaidLinkTokenResponse> {
    const config = this.requireConfig();
    const response = await fetch(
      `${config.apiBaseUrl}/v1/eliza/plaid/link-token`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(PLAID_REQUEST_TIMEOUT_MS),
      },
    );
    return readJson<PlaidLinkTokenResponse>(response);
  }

  async exchangePublicToken(args: {
    publicToken: string;
  }): Promise<PlaidExchangeResponse> {
    const config = this.requireConfig();
    const response = await fetch(
      `${config.apiBaseUrl}/v1/eliza/plaid/exchange`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ publicToken: args.publicToken }),
        signal: AbortSignal.timeout(PLAID_REQUEST_TIMEOUT_MS),
      },
    );
    return readJson<PlaidExchangeResponse>(response);
  }

  async syncTransactions(args: {
    accessToken: string;
    cursor?: string;
    count?: number;
  }): Promise<PlaidSyncResponse> {
    const config = this.requireConfig();
    const response = await fetch(`${config.apiBaseUrl}/v1/eliza/plaid/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accessToken: args.accessToken,
        cursor: args.cursor ?? "",
        count: args.count ?? 250,
      }),
      signal: AbortSignal.timeout(PLAID_REQUEST_TIMEOUT_MS * 2),
    });
    return readJson<PlaidSyncResponse>(response);
  }
}
