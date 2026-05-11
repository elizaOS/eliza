/**
 * Payments capability — atomic action slice (Wave B-atoms).
 *
 * Registers the six atomic payment actions:
 *   CREATE_PAYMENT_REQUEST, DELIVER_PAYMENT_LINK, VERIFY_PAYMENT_PAYLOAD,
 *   SETTLE_PAYMENT, AWAIT_PAYMENT_CALLBACK, CANCEL_PAYMENT_REQUEST.
 *
 * Composition (create + deliver + await + finalize) lives in the planner.
 * The cloud-backed client implementations (`PaymentRequestsClient`,
 * `PaymentBusClient`, `PaymentSettler`) are registered by sibling Wave B
 * packages and resolved here via `runtime.getService(...)`.
 *
 * This plugin is intentionally NOT auto-enabled. Wave H wires it into the
 * default plugin set; until then it's an opt-in import for callers that need
 * the atomic surface.
 */

import { logger } from "../../logger.ts";
import type { Plugin } from "../../types/index.ts";
import {
	awaitPaymentCallbackAction,
	cancelPaymentRequestAction,
	createPaymentRequestAction,
	deliverPaymentLinkAction,
	settlePaymentAction,
	verifyPaymentPayloadAction,
} from "./actions/index.ts";

export const paymentsPlugin: Plugin = {
	name: "payments",
	description:
		"Atomic payment actions: create / deliver / verify / settle / await / cancel a payment request.",
	actions: [
		createPaymentRequestAction,
		deliverPaymentLinkAction,
		verifyPaymentPayloadAction,
		settlePaymentAction,
		awaitPaymentCallbackAction,
		cancelPaymentRequestAction,
	],
	init: async () => {
		logger.info("[PaymentsPlugin] Initialized");
	},
};

export default paymentsPlugin;
