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
 * `access_token` MUST stay server-side. We store it under the user's
 * organization in the existing platform_credentials table, keyed by
 * `provider = "plaid"`.
 *
 * Env-gated: if PLAID_CLIENT_ID + PLAID_SECRET are not set, all calls
 * return 503-style errors so the rest of the app keeps working.
 */

const PLAID_DEFAULT_HOST = "https://sandbox.plaid.com";

export class AgentPlaidConnectorError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface PlaidConfig {
  clientId: string;
  secret: string;
  host: string;
  /** Plaid environment string (sandbox/development/production). */
  environment: "sandbox" | "development" | "production";
}

function readPlaidConfig(): PlaidConfig | null {
  const clientId = process.env.PLAID_CLIENT_ID?.trim();
  const secret = process.env.PLAID_SECRET?.trim();
  if (!clientId || !secret) {
    return null;
  }
  const env = (process.env.PLAID_ENV ?? "sandbox").trim().toLowerCase();
  const environment: PlaidConfig["environment"] =
    env === "production" ? "production" : env === "development" ? "development" : "sandbox";
  const host =
    environment === "production"
      ? "https://production.plaid.com"
      : environment === "development"
        ? "https://development.plaid.com"
        : PLAID_DEFAULT_HOST;
  return { clientId, secret, host, environment };
}

function requireConfig(): PlaidConfig {
  const config = readPlaidConfig();
  if (!config) {
    throw new AgentPlaidConnectorError(
      503,
      "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in the cloud environment.",
    );
  }
  return config;
}

async function plaidPost<TResponse>(
  config: PlaidConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<TResponse> {
  const response = await fetch(`${config.host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      secret: config.secret,
      ...body,
    }),
  });
  if (!response.ok) {
    let errorMessage = `Plaid ${path} failed with ${response.status}`;
    try {
      const data = (await response.json()) as {
        error_code?: string;
        error_message?: string;
        display_message?: string;
      };
      errorMessage =
        data.display_message ?? data.error_message ?? `${data.error_code ?? errorMessage}`;
    } catch {
      // Body was not JSON — fall through with the prefix message.
    }
    throw new AgentPlaidConnectorError(response.status, errorMessage);
  }
  return (await response.json()) as TResponse;
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
  const data = await plaidPost<{
    link_token: string;
    expiration: string;
  }>(config, "/link/token/create", {
    user: { client_user_id: request.userId },
    client_name: request.clientName ?? "Agent",
    products: ["transactions"],
    transactions: { days_requested: 730 },
    country_codes: request.countryCodes ?? ["US"],
    language: request.language ?? "en",
  });
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
  const data = await plaidPost<{
    access_token: string;
    item_id: string;
  }>(config, "/item/public_token/exchange", {
    public_token: request.publicToken,
  });
  return { accessToken: data.access_token, itemId: data.item_id };
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
  const data = await plaidPost<{
    added: PlaidTransaction[];
    modified: PlaidTransaction[];
    removed: Array<{ transaction_id: string }>;
    next_cursor: string;
    has_more: boolean;
  }>(config, "/transactions/sync", {
    access_token: request.accessToken,
    cursor: request.cursor ?? "",
    count: Math.max(1, Math.min(500, request.count ?? 250)),
  });
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
  const item = await plaidPost<{
    item: { institution_id: string | null };
  }>(config, "/item/get", { access_token: args.accessToken });
  const institutionId = item.item.institution_id ?? "unknown";
  let institutionName = "Unknown institution";
  if (item.item.institution_id) {
    try {
      const inst = await plaidPost<{
        institution: { name: string };
      }>(config, "/institutions/get_by_id", {
        institution_id: item.item.institution_id,
        country_codes: ["US"],
      });
      institutionName = inst.institution.name;
    } catch {
      // Institution name is optional — fall back.
    }
  }
  const accountsResponse = await plaidPost<{
    accounts: Array<{
      account_id: string;
      name: string;
      mask: string | null;
      type: string;
      subtype: string | null;
    }>;
  }>(config, "/accounts/get", { access_token: args.accessToken });
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

export function isPlaidConfigured(): boolean {
  return readPlaidConfig() !== null;
}
