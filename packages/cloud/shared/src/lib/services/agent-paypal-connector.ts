/**
 * Agent → PayPal connector (OAuth 2.0 + Reporting API).
 *
 * IMPORTANT — what works and what doesn't:
 *
 * - **Merchant accounts** (people who *sell* on PayPal) → PayPal exposes the
 *   Transaction Search Reporting API at /v1/reporting/transactions and we
 *   can sync transactions automatically once the user authorizes our app.
 *
 * - **Personal accounts** (everyday consumers) → PayPal does NOT expose
 *   transaction history through the public API. The only reliable path is
 *   for the user to download a CSV via paypal.com → Activity → Statements
 *   and import it through the existing Money CSV import endpoint.
 *
 * The connector implements the merchant flow. If the user has a personal-only
 * account, the Transaction Search call returns an authorization error or an
 * empty list and the UI surfaces the CSV-export fallback.
 *
 * Env-gated: if PAYPAL_CLIENT_ID + PAYPAL_SECRET are not set, all calls
 * return 503 errors so the rest of the app keeps working.
 */

const PAYPAL_LIVE_HOST = "https://api-m.paypal.com";
const PAYPAL_SANDBOX_HOST = "https://api-m.sandbox.paypal.com";

export class AgentPaypalConnectorError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface PaypalConfig {
  clientId: string;
  secret: string;
  host: string;
  environment: "live" | "sandbox";
  /** Where PayPal redirects after consent. Set in your PayPal app config. */
  redirectUri: string;
}

function readPaypalConfig(): PaypalConfig | null {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const secret = process.env.PAYPAL_SECRET?.trim();
  const redirectUri = process.env.PAYPAL_REDIRECT_URI?.trim();
  if (!clientId || !secret || !redirectUri) {
    return null;
  }
  const environment =
    (process.env.PAYPAL_ENV ?? "sandbox").trim().toLowerCase() === "live" ? "live" : "sandbox";
  return {
    clientId,
    secret,
    redirectUri,
    environment,
    host: environment === "live" ? PAYPAL_LIVE_HOST : PAYPAL_SANDBOX_HOST,
  };
}

function requireConfig(): PaypalConfig {
  const config = readPaypalConfig();
  if (!config) {
    throw new AgentPaypalConnectorError(
      503,
      "PayPal is not configured. Set PAYPAL_CLIENT_ID, PAYPAL_SECRET, and PAYPAL_REDIRECT_URI in the cloud environment.",
    );
  }
  return config;
}

const REPORTING_SCOPE = "https://uri.paypal.com/services/reporting/search/read";
const IDENTITY_SCOPE = "openid email profile";

export interface BuildAuthorizeUrlRequest {
  organizationId: string;
  userId: string;
  /** Opaque CSRF token; round-trip via PayPal as the `state` param. */
  state: string;
}

export interface BuildAuthorizeUrlResult {
  url: string;
  scope: string;
  environment: PaypalConfig["environment"];
}

export function buildPaypalAuthorizeUrl(
  request: BuildAuthorizeUrlRequest,
): BuildAuthorizeUrlResult {
  const config = requireConfig();
  const scope = `${IDENTITY_SCOPE} ${REPORTING_SCOPE}`;
  // PayPal uses the consumer-facing /connect host for the authorize step,
  // not api-m. The `connect` flow returns to our redirect_uri with `?code=`.
  const authorizeBase =
    config.environment === "live"
      ? "https://www.paypal.com/connect"
      : "https://www.sandbox.paypal.com/connect";
  const params = new URLSearchParams({
    flowEntry: "static",
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope,
    state: request.state,
  });
  return {
    url: `${authorizeBase}?${params.toString()}`,
    scope,
    environment: config.environment,
  };
}

interface PaypalTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

async function paypalTokenRequest(
  config: PaypalConfig,
  body: URLSearchParams,
): Promise<PaypalTokenResponse> {
  const credentials = Buffer.from(`${config.clientId}:${config.secret}`, "utf-8").toString(
    "base64",
  );
  const response = await fetch(`${config.host}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    let message = `PayPal token request failed with ${response.status}`;
    try {
      const data = (await response.json()) as {
        error?: string;
        error_description?: string;
      };
      message = data.error_description ?? data.error ?? message;
    } catch {
      // Body wasn't JSON.
    }
    throw new AgentPaypalConnectorError(response.status, message);
  }
  return (await response.json()) as PaypalTokenResponse;
}

export interface ExchangeCodeRequest {
  code: string;
}

export interface ExchangeCodeResult {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds until accessToken expires. */
  expiresIn: number;
  scope: string;
}

export async function exchangePaypalAuthorizationCode(
  request: ExchangeCodeRequest,
): Promise<ExchangeCodeResult> {
  const config = requireConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: request.code,
    redirect_uri: config.redirectUri,
  });
  const data = await paypalTokenRequest(config, body);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scope: data.scope,
  };
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export async function refreshPaypalAccessToken(
  request: RefreshTokenRequest,
): Promise<ExchangeCodeResult> {
  const config = requireConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: request.refreshToken,
  });
  const data = await paypalTokenRequest(config, body);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? request.refreshToken,
    expiresIn: data.expires_in,
    scope: data.scope,
  };
}

export interface PaypalIdentity {
  payerId: string;
  emails: string[];
  name: string | null;
}

export async function getPaypalIdentity(args: { accessToken: string }): Promise<PaypalIdentity> {
  const config = requireConfig();
  const response = await fetch(`${config.host}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, {
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new AgentPaypalConnectorError(
      response.status,
      `PayPal identity fetch failed with ${response.status}`,
    );
  }
  const data = (await response.json()) as {
    user_id: string;
    name?: string;
    emails?: Array<{ value: string }>;
  };
  return {
    payerId: data.user_id,
    emails: (data.emails ?? []).map((e) => e.value),
    name: data.name ?? null,
  };
}

export interface PaypalTransaction {
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
  shipping_info?: {
    name?: string;
  };
  cart_info?: {
    item_details?: Array<{
      item_name?: string;
      item_amount?: { currency_code: string; value: string };
    }>;
  };
}

export interface SearchTransactionsRequest {
  accessToken: string;
  /** Inclusive start. ISO-8601 with timezone. */
  startDate: string;
  /** Inclusive end. */
  endDate: string;
  page?: number;
}

export interface SearchTransactionsResult {
  transactions: PaypalTransaction[];
  totalItems: number;
  totalPages: number;
  page: number;
}

export async function searchPaypalTransactions(
  request: SearchTransactionsRequest,
): Promise<SearchTransactionsResult> {
  const config = requireConfig();
  const params = new URLSearchParams({
    start_date: request.startDate,
    end_date: request.endDate,
    fields: "transaction_info,payer_info,shipping_info,cart_info",
    page_size: "100",
    page: String(Math.max(1, request.page ?? 1)),
  });
  const response = await fetch(`${config.host}/v1/reporting/transactions?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${request.accessToken}`,
      Accept: "application/json",
    },
  });
  if (response.status === 403) {
    // The most common error: user authorized but they're a personal-tier
    // account without Reporting API access. Surface a specific message so
    // the UI can suggest the CSV-export fallback.
    throw new AgentPaypalConnectorError(
      403,
      "PayPal Reporting API is unavailable for this account (typically personal-tier accounts). Use the CSV export from paypal.com → Activity → Statements.",
    );
  }
  if (!response.ok) {
    let message = `PayPal transaction search failed with ${response.status}`;
    try {
      const data = (await response.json()) as {
        message?: string;
        details?: Array<{ description?: string }>;
      };
      message = data.details?.[0]?.description ?? data.message ?? message;
    } catch {
      // Body wasn't JSON.
    }
    throw new AgentPaypalConnectorError(response.status, message);
  }
  const data = (await response.json()) as {
    transaction_details: PaypalTransaction[];
    total_items: number;
    total_pages: number;
    page: number;
  };
  return {
    transactions: data.transaction_details ?? [],
    totalItems: data.total_items ?? 0,
    totalPages: data.total_pages ?? 0,
    page: data.page ?? 1,
  };
}

export function isPaypalConfigured(): boolean {
  return readPaypalConfig() !== null;
}

/** Did this PayPal account expose Reporting API access during the last sync? */
export function describePaypalCapability(scope: string): {
  hasReporting: boolean;
  hasIdentity: boolean;
} {
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return {
    hasReporting: granted.has(REPORTING_SCOPE),
    hasIdentity: granted.has("openid") || granted.has("email") || granted.has("profile"),
  };
}
