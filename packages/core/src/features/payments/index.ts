/**
 * Payments — consolidated action slice.
 *
 * Re-exports the PAYMENT action, the plugin scaffold, and the runtime contract
 * types (`PaymentRequestsClient`, `PaymentBusClient`, `PaymentSettler`,
 * envelope/settlement shapes, service name constants).
 */

export { paymentAction } from "./actions/index.ts";

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
