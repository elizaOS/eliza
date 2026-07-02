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

import { paymentAction as _bs_1_paymentAction } from "./actions/payment.ts";
import { paymentsPlugin as _bs_2_paymentsPlugin } from "./plugin.ts";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name. Without this eager anchor
// the whole feature is reachable only through re-export edges and Bun.build
// tree-shakes the module bodies out of the mobile agent bundle while keeping
// the core namespace getter — `paymentsPlugin` then throws a ReferenceError
// on first access on device.
const __bundle_safety_FEATURES_PAYMENTS_INDEX__ = [
	_bs_1_paymentAction,
	_bs_2_paymentsPlugin,
];
(
	globalThis as Record<string, unknown>
).__bundle_safety_FEATURES_PAYMENTS_INDEX__ =
	__bundle_safety_FEATURES_PAYMENTS_INDEX__;
