/**
 * Transport types for the billing domain.
 *
 * Copied verbatim from the canonical cloud DTOs in
 * `@elizaos/cloud-shared/lib/types/{cloud-api,crypto-status}` — duplicated here
 * (not imported) because `@elizaos/cloud-shared` is not yet a dependency of
 * `@elizaos/ui`. FOLLOW-UP: once the Scaffold wave adds `@elizaos/cloud-shared`
 * to `packages/ui/package.json`, replace these local copies with
 * `import type { ... } from "@elizaos/cloud-shared/lib/types/cloud-api"` and
 * `".../crypto-status"` so the contract stays single-sourced.
 */

export type IsoDateString = string;
export type DateLike = Date | IsoDateString;

/** GET /api/credits/balance (and /api/v1/credits/balance). */
export interface CreditBalanceResponse {
  balance: number;
}

/** POST /api/billing/checkout/verify. */
export interface VerifyCheckoutResult {
  success: boolean;
  balance: number;
  alreadyApplied: boolean;
}

/** GET /api/invoices/:id — single invoice scoped to the caller's org. */
export interface InvoiceDto {
  id: string;
  organization_id: string;
  stripe_invoice_id: string;
  stripe_customer_id: string;
  stripe_payment_intent_id: string | null;
  amount_due: string | number;
  amount_paid: string | number;
  currency: string;
  status: string;
  invoice_type: string;
  invoice_number: string | null;
  invoice_pdf: string | null;
  hosted_invoice_url: string | null;
  credits_added: string | number | null;
  metadata: Record<string, unknown> | null;
  created_at: DateLike;
  updated_at: DateLike;
  due_date: DateLike | null;
  paid_at: DateLike | null;
}

/**
 * Worker `GET /api/invoices/:id` returns a flattened camelCase ISO-string
 * payload; the detail UI consumes the snake_case {@link InvoiceDto}, so the
 * data hook adapts at that seam.
 */
export interface InvoiceApiPayload {
  id: string;
  stripeInvoiceId: string;
  stripeCustomerId: string;
  stripePaymentIntentId: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: string;
  invoiceType: string;
  invoiceNumber: string | null;
  invoicePdf: string | null;
  hostedInvoiceUrl: string | null;
  creditsAdded?: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  dueDate?: string;
  paidAt?: string;
}

/** Invoice summary row from GET /api/invoices/list. */
export interface InvoiceDisplay {
  id: string;
  stripeInvoiceId?: string;
  date: string;
  total: string;
  status: string;
  invoiceUrl?: string;
  invoicePdf?: string;
  type?: string;
  creditsAdded?: number;
}

/** GET /api/crypto/status. */
export type CryptoStatusTokenKind = "native" | "bep20" | "erc20" | "spl";

export interface CryptoStatusTokenOption {
  symbol: string;
  kind: CryptoStatusTokenKind;
  tokenAddress?: `0x${string}`;
  tokenMint?: string;
  decimals: number;
}

export interface CryptoStatusResponse {
  enabled: boolean;
  oxapayEnabled?: boolean;
  directWallet?: {
    enabled: boolean;
    networks: Array<{
      network: "base" | "bsc" | "solana";
      displayName: string;
      chainId?: number;
      tokenSymbol: string;
      tokenAddress?: `0x${string}`;
      tokenMint?: string;
      tokenDecimals: number;
      tokens: CryptoStatusTokenOption[];
      receiveAddress: string | null;
      enabled: boolean;
    }>;
    promotion: {
      code: "bsc";
      network: "bsc";
      minimumUsd: number;
      bonusCredits: number;
    };
  };
  supportedTokens: string[];
  networks: Array<{ id: string; name: string }>;
  isTestnet: boolean;
}

/** Minimal user/org shape the billing surface consumes (GET /api/v1/user). */
export interface BillingUser {
  organization_id: string;
  wallet_address?: string | null;
  organization: {
    credit_balance: string | number;
  };
}

/** Envelope returned by GET /api/v1/user. */
export interface CurrentUserResponse {
  success: true;
  data: {
    organization_id: string | null;
    wallet_address: string | null;
    organization: {
      credit_balance: string;
    } | null;
  };
}
