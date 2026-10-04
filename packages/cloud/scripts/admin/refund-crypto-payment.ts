/**
 * Operator refund for a direct crypto or x402 payment (#22968).
 *
 * Crypto and x402 payments are refundable only as Eliza Cloud credits: this
 * credits the organization that owns the payment, capped at the USD it paid,
 * and never sends funds on-chain or to a card or bank account. An x402
 * payment request is owned by its payee, not its payer, so it is refused
 * (`CRYPTO_REFUND_X402_PAYER_UNBOUND`).
 *
 * Usage:
 *   bun --conditions=eliza-source packages/cloud/scripts/admin/refund-crypto-payment.ts \
 *     <payment-id> <organization-id> <amount-usd> <refund-key> <operator-user-id> <reason...>
 */

import { loadEnvFiles } from "./local-dev-helpers";

loadEnvFiles();

const [
  paymentId,
  organizationId,
  amountUsd,
  refundKey,
  operatorUserId,
  ...reasonWords
] = process.argv.slice(2);
const reason = reasonWords.join(" ").trim();

if (
  !paymentId ||
  !organizationId ||
  !amountUsd ||
  !refundKey ||
  !operatorUserId ||
  !reason
) {
  console.error(
    "Usage: bun --conditions=eliza-source packages/cloud/scripts/admin/refund-crypto-payment.ts <payment-id> <organization-id> <amount-usd> <refund-key> <operator-user-id> <reason...>",
  );
  process.exit(1);
}

const { cryptoPaymentRefundsService } = await import(
  "@elizaos/cloud-shared/lib/services/crypto-payment-refunds"
);
const refund = await cryptoPaymentRefundsService.refundAsCloudCredits({
  paymentId,
  organizationId,
  amountUsd,
  refundKey,
  operatorUserId,
  reason,
  destination: "cloud_credits",
});
console.log(JSON.stringify(refund, null, 2));
process.exit(0);
