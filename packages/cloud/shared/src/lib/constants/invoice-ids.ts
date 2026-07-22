/**
 * Invoice ID namespace prefixes for different payment methods.
 *
 * These are NOT actual Stripe IDs - they are internal identifiers
 * used to track invoices from non-Stripe payment methods.
 *
 * Format:
 * - Invoice ID: `{PROVIDER_PREFIX}_INV_{unique_id}`
 * - Customer ID: `{PROVIDER_PREFIX}_ORG_{organization_id}`
 */

export const INVOICE_NAMESPACE = {
  /** Crypto payments via OxaPay */
  CRYPTO: {
    INVOICE_PREFIX: "OXAPAY_INV",
    CUSTOMER_PREFIX: "OXAPAY_ORG",
    PAYMENT_INTENT_PREFIX: "OXAPAY_TX",
  },
  /** Stripe payments (actual Stripe IDs, no prefix needed) */
  STRIPE: {
    INVOICE_PREFIX: "", // Uses actual Stripe invoice IDs
    CUSTOMER_PREFIX: "", // Uses actual Stripe customer IDs
    PAYMENT_INTENT_PREFIX: "", // Uses actual Stripe payment intent IDs
  },
} as const;

/**
 * Generate a namespaced invoice ID for crypto payments.
 * Clearly distinguishes from Stripe invoice IDs to avoid confusion.
 * Returns a namespaced ID like "OXAPAY_INV_abc123".
 */
export function createCryptoInvoiceId(paymentId: string): string {
  return `${INVOICE_NAMESPACE.CRYPTO.INVOICE_PREFIX}_${paymentId}`;
}

/**
 * Generate a namespaced customer ID for crypto payments.
 * Clearly distinguishes from Stripe customer IDs to avoid confusion.
 * Returns a namespaced ID like "OXAPAY_ORG_abc123".
 */
export function createCryptoCustomerId(organizationId: string): string {
  return `${INVOICE_NAMESPACE.CRYPTO.CUSTOMER_PREFIX}_${organizationId}`;
}
