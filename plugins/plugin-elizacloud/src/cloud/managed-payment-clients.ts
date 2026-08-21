/**
 * Managed payment-provider clients keep Cloud authentication and response
 * validation at the runtime boundary while delegating route construction to
 * the generated Cloud SDK.
 */

import { ElizaCloudClient } from "@elizaos/cloud-sdk";
import { z } from "zod";
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
    public readonly code: string | null = null,
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
  schema: z.ZodType<T>,
  secrets: readonly string[] = [],
): Promise<T> {
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`.trim();
    let code: string | null = null;
    const text = await response.text();
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text) as {
          code?: string | null;
          error?: string;
          message?: string;
        };
        detail = parsed.message ?? parsed.error ?? text;
        code = typeof parsed.code === "string" ? parsed.code : null;
      } catch {
        detail = text;
      }
    }
    for (const secret of secrets) {
      if (secret.length > 0) detail = detail.replaceAll(secret, "[REDACTED]");
    }
    throw new PlaidManagedClientError(response.status, detail, code);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // error-policy:J3 malformed Cloud responses are explicit provider errors,
    // never fabricated successful payment data.
    throw new PlaidManagedClientError(502, "Eliza Cloud returned invalid Plaid JSON.");
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new PlaidManagedClientError(502, "Eliza Cloud returned malformed Plaid data.");
  }
  return parsed.data;
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
        detail = parsed.message ?? parsed.error ?? text;
        fallback = parsed.fallback ?? null;
      } catch {
        detail = text;
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
  connectionCreated: boolean;
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

export interface PlaidItemStatusResponse {
  connectionId: string;
  itemId: string;
  institutionId: string | null;
  error: { code: string; message: string | null } | null;
  consentExpirationTime: string | null;
}

export interface PlaidItemConnectionResponse {
  connectionId: string;
}

export interface PlaidWebhookVerificationKey {
  [key: string]: unknown;
  alg: "ES256";
  crv: "P-256";
  kid: string;
  kty: "EC";
  use: "sig";
  x: string;
  y: string;
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

const plaidAccountSchema = z.object({
  accountId: z.string().min(1),
  name: z.string(),
  mask: z.string().nullable(),
  type: z.string().min(1),
  subtype: z.string().nullable(),
});

const plaidLinkTokenResponseSchema: z.ZodType<PlaidLinkTokenResponse> = z.object({
  linkToken: z.string().min(1),
  expiration: z.string().min(1),
  environment: z.enum(["sandbox", "development", "production"]),
});

const plaidExchangeResponseSchema: z.ZodType<PlaidExchangeResponse> = z.object({
  connectionId: z.string().uuid(),
  connectionCreated: z.boolean(),
  environment: z.enum(["sandbox", "development", "production"]),
  institution: z.object({
    institutionId: z.string().min(1),
    institutionName: z.string().min(1),
    primaryAccountMask: z.string().nullable(),
    accounts: z.array(plaidAccountSchema),
  }),
});

const plaidTransactionSchema: z.ZodType<PlaidTransactionDto> = z.object({
  transaction_id: z.string().min(1),
  account_id: z.string().min(1),
  amount: z.number().finite(),
  iso_currency_code: z.string().nullable(),
  unofficial_currency_code: z.string().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  authorized_date: z.string().nullable(),
  name: z.string(),
  merchant_name: z.string().nullable(),
  pending: z.boolean(),
  category: z.array(z.string()).nullable(),
  personal_finance_category: z
    .object({ primary: z.string(), detailed: z.string() })
    .nullable(),
});

const plaidSyncResponseSchema: z.ZodType<PlaidSyncResponse> = z.object({
  added: z.array(plaidTransactionSchema),
  modified: z.array(plaidTransactionSchema),
  removed: z.array(z.object({ transaction_id: z.string().min(1) })),
  nextCursor: z.string(),
  hasMore: z.boolean(),
});

const plaidRevokeResponseSchema = z.object({ revoked: z.literal(true) });
const plaidItemConnectionResponseSchema: z.ZodType<PlaidItemConnectionResponse> = z.object({
  connectionId: z.string().uuid(),
});
const plaidItemStatusResponseSchema: z.ZodType<PlaidItemStatusResponse> = z.object({
  connectionId: z.string().uuid(),
  itemId: z.string().min(1),
  institutionId: z.string().nullable(),
  error: z.object({ code: z.string().min(1), message: z.string().nullable() }).nullable(),
  consentExpirationTime: z.string().nullable(),
});
const plaidWebhookVerificationKeySchema: z.ZodType<PlaidWebhookVerificationKey> = z.object({
  alg: z.literal("ES256"),
  crv: z.literal("P-256"),
  kid: z.string().min(1),
  kty: z.literal("EC"),
  use: z.literal("sig"),
  x: z.string().min(1),
  y: z.string().min(1),
});

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

  async createLinkToken(args: {
    connectionId?: string;
    webhookUrl?: string;
  } = {}): Promise<PlaidLinkTokenResponse> {
    const config = this.requireConfig();
    const response = await this.cloudClient(config).routes.postApiV1ElizaPlaidLinkTokenRaw({
      json: args,
      timeoutMs: PLAID_REQUEST_TIMEOUT_MS,
    });
    return readPlaidJson(response, plaidLinkTokenResponseSchema, [config.apiKey]);
  }

  async exchangePublicToken(args: {
    publicToken: string;
  }): Promise<PlaidExchangeResponse> {
    const config = this.requireConfig();
    const response = await this.cloudClient(config).routes.postApiV1ElizaPlaidExchangeRaw({
      json: { publicToken: args.publicToken },
      timeoutMs: PLAID_REQUEST_TIMEOUT_MS,
    });
    return readPlaidJson(response, plaidExchangeResponseSchema, [
      config.apiKey,
      args.publicToken,
    ]);
  }

  async syncTransactions(args: {
    connectionId: string;
    cursor?: string;
    count?: number;
  }): Promise<PlaidSyncResponse> {
    const config = this.requireConfig();
    const response = await this.cloudClient(config).routes.postApiV1ElizaPlaidSyncRaw({
      json: {
        connectionId: args.connectionId,
        cursor: args.cursor ?? "",
        count: args.count ?? 250,
      },
      timeoutMs: PLAID_REQUEST_TIMEOUT_MS * 2,
    });
    return readPlaidJson(response, plaidSyncResponseSchema, [config.apiKey]);
  }

  async revokeConnection(args: {
    connectionId: string;
  }): Promise<{ revoked: true }> {
    const config = this.requireConfig();
    const response = await this.cloudClient(config).routes.postApiV1ElizaPlaidRevokeRaw({
      json: { connectionId: args.connectionId },
      timeoutMs: PLAID_REQUEST_TIMEOUT_MS,
    });
    return readPlaidJson(response, plaidRevokeResponseSchema, [config.apiKey]);
  }

  async getItemStatus(args: {
    connectionId: string;
  }): Promise<PlaidItemStatusResponse> {
    const config = this.requireConfig();
    const response = await this.cloudClient(config).routes.postApiV1ElizaPlaidItemStatusRaw({
      json: args,
      timeoutMs: PLAID_REQUEST_TIMEOUT_MS,
    });
    return readPlaidJson(response, plaidItemStatusResponseSchema, [config.apiKey]);
  }

  async resolveItemConnection(args: {
    itemId: string;
  }): Promise<PlaidItemConnectionResponse> {
    const config = this.requireConfig();
    const response = await this.cloudClient(
      config,
    ).routes.postApiV1ElizaPlaidItemConnectionRaw({
      json: args,
      timeoutMs: PLAID_REQUEST_TIMEOUT_MS,
    });
    return readPlaidJson(response, plaidItemConnectionResponseSchema, [
      config.apiKey,
    ]);
  }

  async getWebhookVerificationKey(args: {
    keyId: string;
  }): Promise<{ key: PlaidWebhookVerificationKey }> {
    const config = this.requireConfig();
    const response = await this.cloudClient(config).routes.postApiV1ElizaPlaidVerificationKeyRaw({
      json: args,
      timeoutMs: PLAID_REQUEST_TIMEOUT_MS,
    });
    return {
      key: await readPlaidJson(response, plaidWebhookVerificationKeySchema, [config.apiKey]),
    };
  }

  private cloudClient(
    config: ElizaCloudManagedClientConfig & { apiKey: string },
  ): ElizaCloudClient {
    return new ElizaCloudClient({
      baseUrl: config.siteUrl,
      apiBaseUrl: config.apiBaseUrl,
      apiKey: config.apiKey,
    });
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
      `${config.apiBaseUrl}/eliza/paypal/authorize`,
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
      `${config.apiBaseUrl}/eliza/paypal/callback`,
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
      `${config.apiBaseUrl}/eliza/paypal/refresh`,
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
      `${config.apiBaseUrl}/eliza/paypal/transactions`,
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
