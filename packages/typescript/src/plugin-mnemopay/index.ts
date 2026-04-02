/**
 * MnemoPay Plugin
 *
 * Gives AI agents economic memory — they remember payment outcomes,
 * learn from settlements and refunds, and build reputation over time.
 *
 * Components:
 * - Service: MnemoPayService — manages the MnemoPayLite engine lifecycle
 * - Actions: REMEMBER_OUTCOME, CHARGE_PAYMENT, SETTLE_PAYMENT, REFUND_PAYMENT, RECALL_MEMORIES
 * - Provider: MnemoPayProvider — injects economic context into conversations
 * - Evaluator: MnemoPayEvaluator — auto-tracks financial outcomes
 *
 * @module plugin-mnemopay
 */

import type { Plugin } from "../types/index.ts";
import {
	chargePaymentAction,
	recallMemoriesAction,
	refundPaymentAction,
	rememberOutcomeAction,
	settlePaymentAction,
} from "./actions/index.ts";
import { mnemoPayEvaluator } from "./evaluators/index.ts";
import { mnemoPayProvider } from "./providers/index.ts";
import { MnemoPayService } from "./services/mnemopay-service.ts";

// Re-export all components for direct import
export {
	chargePaymentAction,
	recallMemoriesAction,
	refundPaymentAction,
	rememberOutcomeAction,
	settlePaymentAction,
} from "./actions/index.ts";
export { mnemoPayEvaluator } from "./evaluators/index.ts";
export { mnemoPayProvider } from "./providers/index.ts";
export { MnemoPayService } from "./services/mnemopay-service.ts";
export * from "./types.ts";

/**
 * Create the MnemoPay plugin.
 *
 * Registers the economic memory service, payment actions, context provider,
 * and auto-tracking evaluator. Configure via environment variables:
 *
 * - MNEMOPAY_AGENT_ID: Custom agent identifier (defaults to runtime.agentId)
 * - MNEMOPAY_REPUTATION_DELTA: Reputation change per settle/refund (default: 0.05)
 *
 * @example
 * ```typescript
 * import { createMnemoPayPlugin } from "./plugin-mnemopay";
 *
 * const agent: ProjectAgent = {
 *   character: myCharacter,
 *   plugins: [createMnemoPayPlugin()],
 * };
 * ```
 */
export function createMnemoPayPlugin(): Plugin {
	return {
		name: "mnemopay",
		description:
			"Economic memory for AI agents — tracks payments, learns from settlements/refunds, and builds reputation",
		services: [MnemoPayService],
		actions: [
			rememberOutcomeAction,
			chargePaymentAction,
			settlePaymentAction,
			refundPaymentAction,
			recallMemoriesAction,
		],
		providers: [mnemoPayProvider],
		evaluators: [mnemoPayEvaluator],
	};
}
