import { logger } from "@/lib/utils/logger";

export type OxaPayNetwork = "ERC20" | "TRC20" | "BEP20" | "POLYGON" | "SOL" | "BASE" | "ARB" | "OP";

export interface OxaPayInvoiceResult {
  trackId: string;
  payLink: string;
  amount: number;
  currency: string;
  expiresAt: Date;
}

export interface OxaPayPaymentStatus {
  trackId: string;
  status: string;
  amount: number;
  currency: string;
  transactions: Array<{
    txHash: string;
    /** The amount to credit (USD value when auto-converted, native value otherwise) */
    amount: number;
    currency: string;
    network: string;
    address: string;
    status: string;
    /** Original amount in native currency (e.g., SOL) before conversion */
    nativeAmount?: number;
    /** USD equivalent amount from invoice */
    usdAmount?: number;
  }>;
}

const OXAPAY_API_BASE = "https://api.oxapay.com";

/**
 * Custom error for OxaPay API failures.
 */
export class OxaPayApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly apiResult?: number,
  ) {
    super(message);
    this.name = "OxaPayApiError";
  }
}

/**
 * Helper to make OxaPay API requests with proper error handling.
 */
async function oxaPayFetch<T>(url: string, options: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, options);
  } catch (error) {
    logger.error("[OxaPay] Network error", { url, error });
    throw new OxaPayApiError(
      `Network error connecting to OxaPay: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  if (!response.ok) {
    logger.error("[OxaPay] HTTP error", { url, status: response.status });
    throw new OxaPayApiError(`OxaPay API returned HTTP ${response.status}`, response.status);
  }

  let data: T;
  try {
    data = await response.json();
  } catch (error) {
    logger.error("[OxaPay] Invalid JSON response", { url, error });
    throw new OxaPayApiError("OxaPay returned invalid JSON response");
  }

  return data;
}

function getMerchantApiKey(): string {
  const apiKey = process.env.OXAPAY_MERCHANT_API_KEY;
  if (!apiKey) {
    throw new OxaPayApiError("OXAPAY_MERCHANT_API_KEY not configured");
  }
  return apiKey;
}

export function isOxaPayConfigured(): boolean {
  return Boolean(process.env.OXAPAY_MERCHANT_API_KEY);
}

class OxaPayService {
  /**
   * Create an invoice payment using OxaPay's merchant request API.
   * This returns a payLink that redirects users to OxaPay's hosted payment page.
   */
  async createInvoice(params: {
    amount: number;
    currency?: string;
    payCurrency?: string;
    network?: OxaPayNetwork;
    orderId?: string;
    description?: string;
    callbackUrl?: string;
    returnUrl?: string;
    email?: string;
    lifetime?: number;
  }): Promise<OxaPayInvoiceResult> {
    const merchantKey = getMerchantApiKey();

    const {
      amount,
      currency = "USD",
      payCurrency,
      network,
      orderId,
      description,
      callbackUrl,
      returnUrl,
      email,
      lifetime = 1800,
    } = params;

    logger.info("[OxaPay] Creating invoice", {
      amount,
      currency,
      payCurrency,
      network,
      orderId,
    });

    const requestBody: Record<string, unknown> = {
      merchant: merchantKey,
      amount,
      currency,
      lifeTime: lifetime / 60,
      feePaidByPayer: 0,
      underPaidCover: 0, // Reject underpayments - user must pay full amount
    };

    if (payCurrency) requestBody.payCurrency = payCurrency;
    if (network) requestBody.network = network;
    if (orderId) requestBody.orderId = orderId;
    if (description) requestBody.description = description;
    if (callbackUrl) requestBody.callbackUrl = callbackUrl;
    if (returnUrl) requestBody.returnUrl = returnUrl;
    if (email) requestBody.email = email;

    const data = await oxaPayFetch<{
      result: number;
      message?: string;
      trackId: string;
      payLink: string;
    }>(`${OXAPAY_API_BASE}/merchants/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (data.result !== 100) {
      logger.error("[OxaPay] Invoice creation failed", {
        result: data.result,
        message: data.message,
      });
      throw new OxaPayApiError(data.message || "Invoice creation failed", undefined, data.result);
    }

    logger.info("[OxaPay] Invoice created", {
      trackId: data.trackId,
      hasPayLink: !!data.payLink,
    });

    return {
      trackId: data.trackId,
      payLink: data.payLink,
      amount,
      currency,
      expiresAt: new Date(Date.now() + lifetime * 1000),
    };
  }

  async getPaymentStatus(trackId: string): Promise<OxaPayPaymentStatus> {
    const merchantKey = getMerchantApiKey();

    logger.info("[OxaPay] Checking payment status", { trackId });

    const data = await oxaPayFetch<{
      result: number;
      message?: string;
      trackId: string;
      status: string;
      amount: string;
      currency: string;
      txID?: string;
      payAmount?: string;
      payCurrency?: string;
      network?: string;
      address?: string;
    }>(`${OXAPAY_API_BASE}/merchants/inquiry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        merchant: merchantKey,
        trackId,
      }),
    });

    if (data.result !== 100) {
      logger.error("[OxaPay] Payment status check failed", {
        result: data.result,
        message: data.message,
      });
      throw new OxaPayApiError(
        data.message || "Payment status check failed",
        undefined,
        data.result,
      );
    }

    // Note: OxaPay doesn't provide blockchain confirmation counts.
    // Confirmation is determined by status ("paid" = confirmed by network).
    //
    // Credit the invoice USD amount for ALL currencies.
    // - Underpayments: Rejected by OxaPay (underPaidCover: 0)
    // - Overpayments: User's responsibility, we credit invoice amount only
    const invoiceAmount = Number.parseFloat(data.amount) || 0;
    const nativePayAmount = Number.parseFloat(data.payAmount || "0");

    return {
      trackId: data.trackId,
      status: data.status,
      amount: invoiceAmount,
      currency: data.currency,
      transactions: data.txID
        ? [
            {
              txHash: data.txID,
              amount: invoiceAmount, // Always credit invoice amount
              currency: data.payCurrency || "",
              network: data.network || "",
              address: data.address || "",
              status: data.status,
              // Store native amount for audit/debugging
              nativeAmount: nativePayAmount,
              usdAmount: invoiceAmount,
            },
          ]
        : [],
    };
  }

  async getSupportedCurrencies(): Promise<
    Array<{
      symbol: string;
      name: string;
      networks: Array<{
        network: string;
        name: string;
        depositMin: number;
        withdrawFee: number;
      }>;
    }>
  > {
    const data = await oxaPayFetch<Record<string, unknown>>(`${OXAPAY_API_BASE}/api/currencies`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!data || typeof data !== "object") {
      throw new OxaPayApiError("Failed to fetch supported currencies");
    }

    const currencies = Object.entries(data)
      .filter(([_, info]: [string, unknown]) => (info as { status?: boolean })?.status)
      .map(([_, info]: [string, unknown]) => {
        const currency = info as {
          symbol: string;
          name: string;
          networks?: Record<string, unknown>;
        };
        return {
          symbol: currency.symbol,
          name: currency.name,
          networks: Object.entries(currency.networks || {}).map(
            ([_, netInfo]: [string, unknown]) => {
              const network = netInfo as {
                network: string;
                name: string;
                deposit_min: number;
                withdraw_fee: number;
              };
              return {
                network: network.network,
                name: network.name,
                depositMin: network.deposit_min,
                withdrawFee: network.withdraw_fee,
              };
            },
          ),
        };
      });

    return currencies;
  }

  async getSystemStatus(): Promise<boolean> {
    try {
      const data = await oxaPayFetch<{ status?: boolean }>(`${OXAPAY_API_BASE}/api/status`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      return data?.status === true;
    } catch {
      return false;
    }
  }

  /**
   * Check if payment is confirmed and safe to deliver goods/credits.
   * Per OxaPay docs:
   * - "Paid" = Payment confirmed by network (for invoice/white_label payments)
   * - "Confirmed" = Payout confirmed (for payout transactions)
   * Note: OxaPay API returns lowercase status values, so we normalize to lowercase.
   */
  isPaymentConfirmed(status: string): boolean {
    const normalized = status.toLowerCase();
    return normalized === "paid" || normalized === "confirmed";
  }

  /**
   * Check if payment is pending (awaiting blockchain confirmation).
   * Per OxaPay docs:
   * - "Waiting" = Waiting for payer to send payment
   * - "Paying" = Payer sent payment, awaiting blockchain confirmation
   * - "Confirming" = Transaction confirming (for payouts)
   */
  isPaymentPending(status: string): boolean {
    const normalized = status.toLowerCase();
    return normalized === "waiting" || normalized === "paying" || normalized === "confirming";
  }

  isPaymentExpired(status: string): boolean {
    return status.toLowerCase() === "expired";
  }

  isPaymentFailed(status: string): boolean {
    const normalized = status.toLowerCase();
    return normalized === "failed" || normalized === "refunded";
  }
}

export const oxaPayService = new OxaPayService();
