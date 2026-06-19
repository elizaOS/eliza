import {
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
} from "./base-url.js";

export { normalizeCloudSiteUrl, resolveCloudApiBaseUrl } from "./base-url.js";

export interface ElizaCloudManagedClientConfig {
  configured: boolean;
  apiKey: string | null;
  apiBaseUrl: string;
  siteUrl: string;
}

export function normalizeElizaCloudApiKey(
  value: string | undefined | null,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase() === "[REDACTED]" ? null : trimmed;
}

export function resolveEnvElizaCloudManagedClientConfig(
  env: Record<string, string | undefined> =
    typeof process === "undefined" ? {} : process.env,
): ElizaCloudManagedClientConfig {
  const apiKey = normalizeElizaCloudApiKey(env.ELIZAOS_CLOUD_API_KEY);
  const baseUrl = env.ELIZAOS_CLOUD_BASE_URL;
  return {
    configured: Boolean(apiKey),
    apiKey,
    apiBaseUrl: resolveCloudApiBaseUrl(baseUrl),
    siteUrl: normalizeCloudSiteUrl(baseUrl),
  };
}

const PLAID_REQUEST_TIMEOUT_MS = 30_000;
const PAYPAL_REQUEST_TIMEOUT_MS = 30_000;

type ConfigSource = () => ElizaCloudManagedClientConfig;

export class PlaidManagedClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlaidManagedClientError";
  }
}

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

async function readPlaidJson<T>(response: Response): Promise<T> {
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

async function readPaypalJson<T>(response: Response): Promise<T> {
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
    private readonly configSource: ConfigSource =
      resolveEnvElizaCloudManagedClientConfig,
  ) {}

  private requireConfig(): ElizaCloudManagedClientConfig & { apiKey: string } {
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
    return readPlaidJson<PlaidLinkTokenResponse>(response);
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
    return readPlaidJson<PlaidExchangeResponse>(response);
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
    return readPlaidJson<PlaidSyncResponse>(response);
  }
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
    private readonly configSource: ConfigSource =
      resolveEnvElizaCloudManagedClientConfig,
  ) {}

  private requireConfig(): ElizaCloudManagedClientConfig & { apiKey: string } {
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
    return readPaypalJson<PaypalAuthorizeUrlResponse>(response);
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
    return readPaypalJson<PaypalCallbackResponse>(response);
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
    return readPaypalJson(response);
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
    return readPaypalJson<PaypalTransactionsResponse>(response);
  }
}
