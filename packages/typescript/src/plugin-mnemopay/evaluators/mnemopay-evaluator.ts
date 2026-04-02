/**
 * MnemoPay Evaluator
 *
 * Runs after every agent response to detect financial actions and
 * automatically store outcomes in economic memory. This creates a
 * passive learning loop where the agent builds knowledge from every
 * payment interaction without explicit user instructions.
 */

import { logger } from "../../logger.ts";
import type {
	ActionResult,
	Evaluator,
	EvaluationExample,
	IAgentRuntime,
	Memory,
	State,
} from "../../types/index.ts";
import type { MnemoPayService } from "../services/mnemopay-service.ts";

/** Keywords that indicate a financial action occurred in the conversation */
const FINANCIAL_KEYWORDS = [
	"payment",
	"charge",
	"settle",
	"refund",
	"escrow",
	"wallet",
	"transaction",
	"paid",
	"invoiced",
	"billed",
	"cost",
	"price",
	"fee",
	"deposit",
];

function containsFinancialContent(text: string): boolean {
	const lower = text.toLowerCase();
	return FINANCIAL_KEYWORDS.some((kw) => lower.includes(kw));
}

export const mnemoPayEvaluator: Evaluator = {
	name: "MNEMOPAY_OUTCOME_TRACKER",
	description:
		"Automatically detects financial actions in conversations and stores outcomes in economic memory. Runs after agent responses to build a passive learning loop.",
	alwaysRun: true,

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> => {
		const service = runtime.getService("mnemopay") as MnemoPayService | null;
		if (!service) {
			return false;
		}

		const text = typeof message.content === "string"
			? message.content
			: message.content?.text ?? "";

		return containsFinancialContent(text);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<ActionResult | undefined> => {
		try {
			const service = runtime.getService("mnemopay") as MnemoPayService;
			const engine = service.getEngine();

			const text = typeof message.content === "string"
				? message.content
				: message.content?.text ?? "";

			if (!containsFinancialContent(text)) {
				return undefined;
			}

			// Determine the nature of the financial action
			const lower = text.toLowerCase();
			const tags: string[] = ["auto-tracked"];

			if (lower.includes("settle") || lower.includes("confirmed") || lower.includes("completed")) {
				tags.push("settlement", "positive");
			} else if (lower.includes("refund") || lower.includes("dispute") || lower.includes("cancel")) {
				tags.push("refund", "negative");
			} else if (lower.includes("charge") || lower.includes("paid") || lower.includes("payment")) {
				tags.push("payment");
			}

			// Determine importance based on action type
			let importance = 0.5;
			if (tags.includes("settlement")) {
				importance = 0.7; // Positive outcomes are moderately important
			} else if (tags.includes("refund")) {
				importance = 0.9; // Negative outcomes are very important to remember
			}

			// Store the financial interaction as economic memory
			const truncated = text.length > 200 ? `${text.substring(0, 200)}...` : text;
			await engine.remember(
				`[Auto-tracked] ${truncated}`,
				{ importance, tags },
			);

			logger.debug(
				{
					src: "evaluator:mnemopay",
					tags,
					importance,
				},
				"Financial outcome auto-tracked in economic memory",
			);

			return {
				success: true,
				text: "Financial outcome tracked",
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "evaluator:mnemopay", error: errorMessage },
				"Failed to auto-track financial outcome",
			);
			return undefined;
		}
	},

	examples: [
		{
			messages: [
				{
					name: "user",
					content: { text: "The payment to vendor X was settled successfully" },
				},
				{
					name: "agent",
					content: { text: "Payment settled. I have recorded this positive outcome for future reference." },
				},
			],
			outcome: "Financial outcome auto-stored: settlement, positive, importance 0.7",
		},
		{
			messages: [
				{
					name: "user",
					content: { text: "I need to refund the last transaction, the service was terrible" },
				},
				{
					name: "agent",
					content: { text: "Processing refund. I will remember this negative experience." },
				},
			],
			outcome: "Financial outcome auto-stored: refund, negative, importance 0.9",
		},
	] as EvaluationExample[],
};
