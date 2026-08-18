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

async function readPlaidJson<T>(
  response: Response,
  validate: (value: unknown) => value is T,
): Promise<T> {
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
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    // error-policy:J1 malformed Cloud responses become a typed client failure.
    throw new PlaidManagedClientError(502, "Eliza Cloud returned invalid Plaid JSON.");
  }
  if (!validate(value)) {
    throw new PlaidManagedClientError(502, "Eliza Cloud returned an invalid Plaid response.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlaidEnvironment(value: unknown): value is PlaidLinkTokenResponse["environment"] {
  return value === "sandbox" || value === "development" || value === "production";
}

function isPlaidLinkTokenResponse(value: unknown): value is PlaidLinkTokenResponse {
  return (
    isRecord(value) &&
    typeof value.linkToken === "string" &&
    value.linkToken.length > 0 &&
    typeof value.expiration === "string" &&
    isPlaidEnvironment(value.environment)
  );
}

function isPlaidExchangeResponse(value: unknown): value is PlaidExchangeResponse {
  if (!isRecord(value) || !isPlaidEnvironment(value.environment) || !isRecord(value.institution)) {
    return false;
  }
  const institution = value.institution;
  return (
    typeof value.connectionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.connectionId,
    ) &&
    typeof institution.institutionId === "string" &&
    typeof institution.institutionName === "string" &&
    (institution.primaryAccountMask === null || typeof institution.primaryAccountMask === "string") &&
    Array.isArray(institution.accounts) &&
    institution.accounts.every(
      (account) =>
        isRecord(account) &&
        typeof account.accountId === "string" &&
        typeof account.name === "string" &&
        (account.mask === null || typeof account.mask === "string") &&
        typeof account.type === "string" &&
        (account.subtype === null || typeof account.subtype === "string"),
    )
  );
}

function isPlaidTransaction(value: unknown): value is PlaidTransactionDto {
  return (
    isRecord(value) &&
    typeof value.transaction_id === "string" &&
    typeof value.account_id === "string" &&
    typeof value.amount === "number" &&
    Number.isFinite(value.amount) &&
    (value.iso_currency_code === null || typeof value.iso_currency_code === "string") &&
    (value.unofficial_currency_code === null ||
      typeof value.unofficial_currency_code === "string") &&
    typeof value.date === "string" &&
    (value.authorized_date === null || typeof value.authorized_date === "string") &&
    typeof value.name === "string" &&
    (value.merchant_name === null || typeof value.merchant_name === "string") &&
    typeof value.pending === "boolean" &&
    (value.category === null ||
      (Array.isArray(value.category) && value.category.every((entry) => typeof entry === "string"))) &&
    (value.personal_finance_category === null ||
      (isRecord(value.personal_finance_category) &&
        typeof value.personal_finance_category.primary === "string" &&
        typeof value.personal_finance_category.detailed === "string"))
  );
}

function isPlaidSyncResponse(value: unknown): value is PlaidSyncResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.added) &&
    value.added.every(isPlaidTransaction) &&
    Array.isArray(value.modified) &&
    value.modified.every(isPlaidTransaction) &&
    Array.isArray(value.removed) &&
    value.removed.every(
      (entry) => isRecord(entry) && typeof entry.transaction_id === "string",
    ) &&
    typeof value.nextCursor === "string" &&
    typeof value.hasMore === "boolean"
  );
}

function isPlaidRevokeResponse(value: unknown): value is { revoked: true } {
  return isRecord(value) && value.revoked === true;
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
  connectionId: string;
  environment: "sandbox" | "development" | "production";
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
    return readPlaidJson(response, isPlaidLinkTokenResponse);
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
    return readPlaidJson(response, isPlaidExchangeResponse);
  }

  async syncTransactions(args: {
    connectionId: string;
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
        connectionId: args.connectionId,
        cursor: args.cursor ?? "",
        count: args.count ?? 250,
      }),
      signal: AbortSignal.timeout(PLAID_REQUEST_TIMEOUT_MS * 2),
    });
    return readPlaidJson(response, isPlaidSyncResponse);
  }

  async revokeConnection(args: {
    connectionId: string;
  }): Promise<{ revoked: true }> {
    const config = this.requireConfig();
    const response = await fetch(`${config.apiBaseUrl}/v1/eliza/plaid/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ connectionId: args.connectionId }),
      signal: AbortSignal.timeout(PLAID_REQUEST_TIMEOUT_MS),
    });
    return readPlaidJson(response, isPlaidRevokeResponse);
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
