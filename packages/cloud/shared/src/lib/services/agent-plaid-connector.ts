/**
 * Agent → Plaid connector.
 *
 * Plaid is NOT OAuth 2.0. The flow is Plaid Link:
 *   1. Server: POST /link/token/create → returns a `link_token`
 *   2. Client: drives Plaid Link with that token → returns a `public_token`
 *   3. Server: POST /item/public_token/exchange → returns a long-lived
 *      `access_token` per Item (institution login)
 *   4. Server: POST /transactions/sync (with a per-Item cursor) → returns
 *      added/modified/removed transactions
 *
 * `access_token` MUST stay server-side. The Plaid connection service stores it
 * as an encrypted, organization-bound vendor connection and gives clients an
 * opaque connection id.
 *
 * Env-gated: calls require PLAID_CLIENT_ID and the selected environment's
 * secret. PLAID_SECRET remains an active-environment compatibility alias.
 */

import { z } from "zod";

const PLAID_DEFAULT_HOST = "https://sandbox.plaid.com";
const PLAID_REQUEST_TIMEOUT_MS = 30_000;

export class AgentPlaidConnectorError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface PlaidConfig {
  clientId: string;
  secret: string;
  host: string;
  /** Plaid environment string (sandbox/development/production). */
  environment: "sandbox" | "development" | "production";
}

const linkTokenResponseSchema = z.object({
  link_token: z.string().min(1),
  expiration: z.string().min(1),
});

const exchangeResponseSchema = z.object({
  access_token: z.string().min(1),
  item_id: z.string().min(1),
});

const plaidTransactionSchema = z.object({
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
  personal_finance_category: z.object({ primary: z.string(), detailed: z.string() }).nullable(),
});

const syncResponseSchema = z.object({
  added: z.array(plaidTransactionSchema),
  modified: z.array(plaidTransactionSchema),
  removed: z.array(z.object({ transaction_id: z.string().min(1) })),
  next_cursor: z.string(),
  has_more: z.boolean(),
});

const itemResponseSchema = z.object({
  item: z.object({
    item_id: z.string().min(1),
    institution_id: z.string().min(1).nullable(),
    error: z
      .object({
        error_code: z.string().min(1),
        error_message: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    consent_expiration_time: z.string().nullable().optional(),
  }),
});

const institutionResponseSchema = z.object({
  institution: z.object({ name: z.string().min(1) }),
});

const accountsResponseSchema = z.object({
  accounts: z.array(
    z.object({
      account_id: z.string().min(1),
      name: z.string(),
      mask: z.string().nullable(),
      type: z.string().min(1),
      subtype: z.string().nullable(),
    }),
  ),
});

const removeResponseSchema = z.object({ request_id: z.string().min(1) });

const webhookKeyResponseSchema = z.object({
  key: z.object({
    alg: z.literal("ES256"),
    crv: z.literal("P-256"),
    kid: z.string().min(1),
    kty: z.literal("EC"),
    use: z.literal("sig"),
    x: z.string().min(1),
    y: z.string().min(1),
    created_at: z.number().int(),
    expired_at: z.number().int().nullable(),
  }),
});

const plaidErrorResponseSchema = z.object({
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  display_message: z.string().nullable().optional(),
});

function redactPlaidErrorMessage(
  message: string,
  config: PlaidConfig,
  body: Record<string, unknown>,
): string {
  let sanitized = message.slice(0, 500);
  const secrets = [config.clientId, config.secret];
  for (const value of Object.values(body)) {
    if (typeof value === "string" && value.length > 0) {
      secrets.push(value);
    }
  }
  for (const secret of secrets) {
    sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  return sanitized;
}

function readPlaidConfig(environmentOverride?: PlaidConfig["environment"]): PlaidConfig | null {
  const clientId = process.env.PLAID_CLIENT_ID?.trim();
  const env = environmentOverride ?? (process.env.PLAID_ENV ?? "sandbox").trim().toLowerCase();
  if (env !== "sandbox" && env !== "development" && env !== "production") {
    throw new AgentPlaidConnectorError(
      503,
      "PLAID_ENV must be sandbox, development, or production.",
    );
  }
  const environment: PlaidConfig["environment"] = env;
  const environmentSecret = process.env[`PLAID_${environment.toUpperCase()}_SECRET`]?.trim();
  const configuredEnvironment = (process.env.PLAID_ENV ?? "sandbox").trim().toLowerCase();
  // PLAID_SECRET remains a compatibility alias for the active environment.
  // Cross-environment cleanup must use that environment's own credential.
  const secret =
    environmentSecret ??
    (environment === configuredEnvironment ? process.env.PLAID_SECRET?.trim() : undefined);
  if (!clientId || !secret) {
    return null;
  }
  const host =
    environment === "production"
      ? "https://production.plaid.com"
      : environment === "development"
        ? "https://development.plaid.com"
        : PLAID_DEFAULT_HOST;
  return { clientId, secret, host, environment };
}

function requireConfig(environmentOverride?: PlaidConfig["environment"]): PlaidConfig {
  const config = readPlaidConfig(environmentOverride);
  if (!config) {
    throw new AgentPlaidConnectorError(
      503,
      "Plaid is not configured. Set PLAID_CLIENT_ID and the selected environment's PLAID_*_SECRET in the cloud environment.",
    );
  }
  return config;
}

async function plaidPost<TSchema extends z.ZodType>(
  config: PlaidConfig,
  path: string,
  body: Record<string, unknown>,
  responseSchema: TSchema,
): Promise<z.infer<TSchema>> {
  let response: Response;
  try {
    response = await fetch(`${config.host}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        secret: config.secret,
        ...body,
      }),
      signal: AbortSignal.timeout(PLAID_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // error-policy:J1 the provider transport boundary exposes a stable status
    // without serializing request credentials or fetch implementation details.
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new AgentPlaidConnectorError(
      timedOut ? 504 : 502,
      timedOut ? `Plaid ${path} timed out.` : `Plaid ${path} was unreachable.`,
      timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    let errorMessage = `Plaid ${path} failed with ${response.status}`;
    let errorCode: string | null = null;
    try {
      const parsed = plaidErrorResponseSchema.safeParse(await response.json());
      if (parsed.success) {
        const data = parsed.data;
        errorMessage =
          data.display_message ?? data.error_message ?? `${data.error_code ?? errorMessage}`;
        errorCode = data.error_code ?? null;
      }
    } catch {
      // error-policy:J3 malformed upstream error bodies become a bounded,
      // non-secret status message rather than fabricated structured data.
    }
    throw new AgentPlaidConnectorError(
      response.status,
      redactPlaidErrorMessage(errorMessage, config, body),
      errorCode,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // error-policy:J3 malformed upstream success bodies are rejected at the
    // protocol boundary and never converted into healthy-looking defaults.
    throw new AgentPlaidConnectorError(
      502,
      `Plaid ${path} returned invalid JSON.`,
      error instanceof Error ? "MALFORMED_RESPONSE" : null,
    );
  }
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AgentPlaidConnectorError(
      502,
      `Plaid ${path} returned a malformed response.`,
      "MALFORMED_RESPONSE",
    );
  }
  return parsed.data;
}

export interface CreateLinkTokenRequest {
  organizationId: string;
  userId: string;
  /** App display name shown in Plaid Link. */
  clientName?: string;
  /** Two-letter language code; Plaid accepts "en", "fr", "es" etc. */
  language?: string;
  /** ISO 3166-1 alpha-2 country list. Defaults to ["US"]. */
  countryCodes?: string[];
  /** Existing Item credential for Plaid Link update mode. */
  accessToken?: string;
  /** Public webhook receiver registered on the Item. */
  webhookUrl?: string;
}

export interface CreateLinkTokenResult {
  linkToken: string;
  expiration: string;
  /** Echoed environment string, useful for the Link SDK init. */
  environment: PlaidConfig["environment"];
}

export async function createPlaidLinkToken(
  request: CreateLinkTokenRequest,
): Promise<CreateLinkTokenResult> {
  const config = requireConfig();
  const requestBody: Record<string, unknown> = {
    user: { client_user_id: request.userId },
    client_name: request.clientName ?? "Agent",
    country_codes: request.countryCodes ?? ["US"],
    language: request.language ?? "en",
  };
  if (request.accessToken) {
    requestBody.access_token = request.accessToken;
  } else {
    requestBody.products = ["transactions"];
    requestBody.transactions = { days_requested: 730 };
  }
  if (request.webhookUrl) requestBody.webhook = request.webhookUrl;
  const data = await plaidPost(config, "/link/token/create", requestBody, linkTokenResponseSchema);
  return {
    linkToken: data.link_token,
    expiration: data.expiration,
    environment: config.environment,
  };
}

export interface ExchangePublicTokenRequest {
  publicToken: string;
}

export interface ExchangePublicTokenResult {
  /** Long-lived per-Item access token. NEVER expose to the client. */
  accessToken: string;
  itemId: string;
}

export async function exchangePlaidPublicToken(
  request: ExchangePublicTokenRequest,
): Promise<ExchangePublicTokenResult> {
  const config = requireConfig();
  const data = await plaidPost(
    config,
    "/item/public_token/exchange",
    { public_token: request.publicToken },
    exchangeResponseSchema,
  );
  return { accessToken: data.access_token, itemId: data.item_id };
}

export function getPlaidEnvironment(): PlaidConfig["environment"] {
  return requireConfig().environment;
}

export async function removePlaidItem(args: {
  accessToken: string;
  environment?: PlaidConfig["environment"];
}): Promise<void> {
  const config = requireConfig(args.environment);
  await plaidPost(config, "/item/remove", { access_token: args.accessToken }, removeResponseSchema);
}

export interface PlaidTransactionDelta {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string }>;
  nextCursor: string;
  hasMore: boolean;
}

export interface PlaidTransaction {
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

export interface SyncPlaidTransactionsRequest {
  accessToken: string;
  cursor?: string;
  count?: number;
}

export async function syncPlaidTransactions(
  request: SyncPlaidTransactionsRequest,
): Promise<PlaidTransactionDelta> {
  const config = requireConfig();
  const data = await plaidPost(
    config,
    "/transactions/sync",
    {
      access_token: request.accessToken,
      cursor: request.cursor ?? "",
      count: Math.max(1, Math.min(500, request.count ?? 250)),
    },
    syncResponseSchema,
  );
  return {
    added: data.added,
    modified: data.modified,
    removed: data.removed,
    nextCursor: data.next_cursor,
    hasMore: data.has_more,
  };
}

export interface PlaidInstitutionInfo {
  institutionId: string;
  institutionName: string;
  /** First account, used for the per-source label/mask. */
  primaryAccountMask: string | null;
  /** All accounts the user linked under this Item. */
  accounts: Array<{
    accountId: string;
    name: string;
    mask: string | null;
    type: string;
    subtype: string | null;
  }>;
}

export async function getPlaidItemInfo(args: {
  accessToken: string;
}): Promise<PlaidInstitutionInfo> {
  const config = requireConfig();
  const item = await plaidPost(
    config,
    "/item/get",
    { access_token: args.accessToken },
    itemResponseSchema,
  );
  const institutionId = item.item.institution_id ?? "unknown";
  let institutionName = "Unknown institution";
  if (item.item.institution_id) {
    try {
      const inst = await plaidPost(
        config,
        "/institutions/get_by_id",
        {
          institution_id: item.item.institution_id,
          country_codes: ["US"],
        },
        institutionResponseSchema,
      );
      institutionName = inst.institution.name;
    } catch {
      // error-policy:J4 institution display metadata is optional; account and
      // Item authority remain explicit while the UI shows an unavailable name.
    }
  }
  const accountsResponse = await plaidPost(
    config,
    "/accounts/get",
    { access_token: args.accessToken },
    accountsResponseSchema,
  );
  return {
    institutionId,
    institutionName,
    primaryAccountMask: accountsResponse.accounts[0]?.mask ?? null,
    accounts: accountsResponse.accounts.map((account) => ({
      accountId: account.account_id,
      name: account.name,
      mask: account.mask,
      type: account.type,
      subtype: account.subtype,
    })),
  };
}

export interface PlaidItemStatus {
  itemId: string;
  institutionId: string | null;
  error: { code: string; message: string | null } | null;
  consentExpirationTime: string | null;
}

export async function getPlaidItemStatus(args: { accessToken: string }): Promise<PlaidItemStatus> {
  const config = requireConfig();
  const result = await plaidPost(
    config,
    "/item/get",
    { access_token: args.accessToken },
    itemResponseSchema,
  );
  return {
    itemId: result.item.item_id,
    institutionId: result.item.institution_id,
    error: result.item.error
      ? {
          code: result.item.error.error_code,
          message: result.item.error.error_message ?? null,
        }
      : null,
    consentExpirationTime: result.item.consent_expiration_time ?? null,
  };
}

export interface PlaidWebhookVerificationKey {
  alg: "ES256";
  crv: "P-256";
  kid: string;
  kty: "EC";
  use: "sig";
  x: string;
  y: string;
}

export async function getPlaidWebhookVerificationKey(args: {
  keyId: string;
}): Promise<PlaidWebhookVerificationKey> {
  const config = requireConfig();
  const result = await plaidPost(
    config,
    "/webhook_verification_key/get",
    { key_id: args.keyId },
    webhookKeyResponseSchema,
  );
  if (result.key.expired_at !== null) {
    throw new AgentPlaidConnectorError(401, "Plaid webhook key is expired.", "EXPIRED_KEY");
  }
  const { created_at: _createdAt, expired_at: _expiredAt, ...key } = result.key;
  return key;
}

export function isPlaidConfigured(): boolean {
  return readPlaidConfig() !== null;
}
