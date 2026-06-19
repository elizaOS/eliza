/**
 * Billing domain barrel for the app-hosted Eliza Cloud surface.
 *
 * Importing this module registers the billing cloud routes (side effect via
 * `./routes`). The named exports let the Wave-3 settings billing section mount
 * the billing body without re-fetching, and let the shell mount the standalone
 * page.
 *
 * Mounted surfaces:
 * - Settings section (Wave-3): render {@link BillingSectionBody} (no route chrome)
 *   — it self-fetches the user/org and includes the {@link ConditionalWalletProviders}
 *   gate, so the section host just renders it. Or wrap {@link BillingTab} directly
 *   if the host already has the user.
 * - Routes (registered by importing `./routes`): `dashboard/billing`,
 *   `dashboard/billing/success`, `dashboard/invoices/:id`.
 */

import "./routes";

export {
  BillingSectionBody,
  default as BillingSection,
} from "./BillingSection";
export { default as BillingSuccessPage } from "./BillingSuccessPage";
export { BillingTab } from "./components/billing-tab";
// NOTE: DirectCryptoCreditCard is intentionally NOT re-exported here — a static
// re-export pulls its @solana/spl-token + @solana/web3.js imports into the boot
// graph (top-level PublicKey constants → safe-buffer Buffer() → boot crash).
// It is lazy-loaded inside billing-tab where it is used.
export { InvoiceDetailClient } from "./components/invoice-detail-client";
export {
  useBillingUser,
  useCreditsBalance,
  useInvoice,
  useVerifyCheckout,
} from "./data/billing-data";
export { default as InvoiceDetailPage } from "./InvoiceDetailPage";
export type {
  BillingUser,
  CreditBalanceResponse,
  CryptoStatusResponse,
  InvoiceDto,
  VerifyCheckoutResult,
} from "./types";
export { ConditionalWalletProviders } from "./wallet/ConditionalWalletProviders";
