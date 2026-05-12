/**
 * Eliza-runtime client for Eliza Cloud's PayPal bridge endpoints.
 *
 * Same pattern as PlaidManagedClient: cloud holds the PAYPAL_* secrets,
 * we just authenticate with the user's Eliza Cloud API key and forward
 * the OAuth + Reporting API calls.
 *
 * The Reporting API (transaction sync) is only available to merchant-tier
 * PayPal accounts. Personal accounts can authorize Login but the API
 * returns 403; the cloud surfaces this as
 * `{ error, fallback: "csv_export" }` so we can route the user to CSV
 * import instead.
 */

import {
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
} from "@elizaos/plugin-elizacloud";
import { loadElizaConfig } from "@elizaos/agent";

const PAYPAL_REQUEST_TIMEOUT_MS = 30_000;

export class PaypalManagedClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fallback: "csv_export" | null = null,
  ) {
    super(message);
    this.name = "PaypalManagedClientError";
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
    let fallback: "csv_export" | null = null;
    const text = await response.text();
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text) as {
          error?: string;
          message?: string;
          fallback?: "csv_export" | null;
        };
        detail = parsed.message ?? parsed.error ?? text.slice(0, 240);
        fallback = parsed.fallback ?? null;
      } catch {
        detail = text.slice(0, 240);
      }
    }
    throw new PaypalManagedClientError(response.status, detail, fallback);
  }
  return (await response.json()) as T;
}

export interface PaypalAuthorizeUrlResponse {
  url: string;
  scope: string;
  environment: "live" | "sandbox";
}

export interface PaypalCallbackResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
  capability: { hasReporting: boolean; hasIdentity: boolean };
  identity: { payerId: string; emails: string[]; name: string | null } | null;
}

export interface PaypalTransactionDto {
  transaction_info: {
    transaction_id: string;
    transaction_initiation_date: string;
    transaction_updated_date: string | null;
    transaction_amount: { currency_code: string; value: string };
    transaction_status: string;
    transaction_subject: string | null;
    transaction_note: string | null;
  };
  payer_info?: {
    email_address?: string;
    payer_name?: { alternate_full_name?: string };
  };
  shipping_info?: { name?: string };
  cart_info?: {
    item_details?: Array<{
      item_name?: string;
      item_amount?: { currency_code: string; value: string };
    }>;
  };
}

export interface PaypalTransactionsResponse {
  transactions: PaypalTransactionDto[];
  totalItems: number;
  totalPages: number;
  page: number;
}

export class PaypalManagedClient {
  constructor(
    private readonly configSource: () => ResolvedCloudConfig = resolveCloudConfig,
  ) {}

  private requireConfig(): ResolvedCloudConfig & { apiKey: string } {
    const config = this.configSource();
    if (!config.apiKey) {
      throw new PaypalManagedClientError(409, "Eliza Cloud is not connected.");
    }
    return { ...config, apiKey: config.apiKey };
  }

  get configured(): boolean {
    return this.configSource().configured;
  }

  async buildAuthorizeUrl(args: {
    state: string;
  }): Promise<PaypalAuthorizeUrlResponse> {
    const config = this.requireConfig();
    const response = await fetch(
      `${config.apiBaseUrl}/v1/eliza/paypal/authorize`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: args.state }),
        signal: AbortSignal.timeout(PAYPAL_REQUEST_TIMEOUT_MS),
      },
    );
    return readJson<PaypalAuthorizeUrlResponse>(response);
  }

  async exchangeCode(args: { code: string }): Promise<PaypalCallbackResponse> {
    const config = this.requireConfig();
    const response = await fetch(
      `${config.apiBaseUrl}/v1/eliza/paypal/callback`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: args.code }),
        signal: AbortSignal.timeout(PAYPAL_REQUEST_TIMEOUT_MS),
      },
    );
    return readJson<PaypalCallbackResponse>(response);
  }

  async refreshAccessToken(args: { refreshToken: string }): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresIn: number;
    scope: string;
  }> {
    const config = this.requireConfig();
    const response = await fetch(
      `${config.apiBaseUrl}/v1/eliza/paypal/refresh`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refreshToken: args.refreshToken }),
        signal: AbortSignal.timeout(PAYPAL_REQUEST_TIMEOUT_MS),
      },
    );
    return readJson(response);
  }

  async searchTransactions(args: {
    accessToken: string;
    startDate: string;
    endDate: string;
    page?: number;
  }): Promise<PaypalTransactionsResponse> {
    const config = this.requireConfig();
    const response = await fetch(
      `${config.apiBaseUrl}/v1/eliza/paypal/transactions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(PAYPAL_REQUEST_TIMEOUT_MS * 2),
      },
    );
    return readJson<PaypalTransactionsResponse>(response);
  }
}
