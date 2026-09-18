/**
 * Payments — action slice.
 *
 * Re-exports the PAYMENT action, the plugin scaffold, and the runtime contract
 * types (`PaymentRequestsClient`, `PaymentBusClient`, `PaymentSettler`,
 * envelope/settlement shapes, service name constants).
 */

// Re-export the action from its defining file, NOT through a re-export-only
// barrel — see the note in ./plugin.ts (Bun.build drops barrel-only-reachable
// modules when the mobile bundle lowers @elizaos/core to lazy CJS-interop
// inits, silently removing the feature from the on-device bundle).
export { paymentAction } from "./actions/payment.ts";

export { paymentsPlugin, paymentsPlugin as default } from "./plugin.ts";
export type {
  CreatePaymentRequestInput,
  PaymentBusClient,
  PaymentContext,
  PaymentContextKind,
  PaymentProofVerification,
  PaymentProvider,
  PaymentRequestEnvelope,
  PaymentRequestStatus,
  PaymentRequestsClient,
  PaymentSettlementResult,
  PaymentSettler,
} from "./types.ts";
export {
  eligibleDeliveryTargetsFor,
  PAYMENT_BUS_CLIENT_SERVICE,
  PAYMENT_REQUESTS_CLIENT_SERVICE,
  PAYMENT_SETTLER_SERVICE,
} from "./types.ts";
