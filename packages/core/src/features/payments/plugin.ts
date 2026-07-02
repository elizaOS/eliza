/**
 * Payments capability — action slice.
 *
 * Registers the PAYMENT umbrella action with structural subactions:
 *   create_request, deliver_link, verify_payload, settle, await_callback,
 *   cancel_request.
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
// Import the action from its defining file, NOT through a re-export-only
// barrel. When the mobile agent bundle lowers @elizaos/core into lazy
// CJS-interop module inits (the core barrel graph is cyclic via
// features/basic-capabilities -> ../index.ts), Bun's tree-shaker drops
// modules that are reachable only through a pure re-export barrel — this
// entire feature was silently absent from the shipped mobile bundle
// (same incident class as sub-agent-credentials/plugin.ts).
import { paymentAction } from "./actions/payment.ts";

export const paymentsPlugin: Plugin = {
	name: "payments",
	description:
		"Payment action: create / deliver / verify / settle / await / cancel a payment request.",
	actions: [paymentAction],
	init: async () => {
		logger.info("[PaymentsPlugin] Initialized");
	},
};

export default paymentsPlugin;
