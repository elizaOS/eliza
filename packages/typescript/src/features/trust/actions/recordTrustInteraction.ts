import { logger } from "../../../logger.ts";
import type {
	Action as ElizaAction,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../../types/index.ts";
import { parseJSONObjectFromText } from "../../../utils.ts";
import { TrustEvidenceType, type TrustInteraction } from "../types/trust.ts";
import { hasTrustEngine } from "./hasTrustEngine.ts";

export const recordTrustInteractionAction: ElizaAction = {
	name: "RECORD_TRUST_INTERACTION",
	description: "Records a trust-affecting interaction between entities",
	suppressPostActionContinuation: true,

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: unknown,
		options?: Record<string, unknown>,
	): Promise<boolean> => {
		const __avTextRaw =
			typeof message?.content?.text === "string" ? message.content.text : "";
		const __avText = __avTextRaw.toLowerCase();
		const __avKeywords = ["record", "trust", "interaction"];
		const __avKeywordOk =
			__avKeywords.length > 0 &&
			__avKeywords.some((word) => word.length > 0 && __avText.includes(word));
		const __avRegex = /\b(?:record|trust|interaction)\b/i;
		const __avRegexOk = __avRegex.test(__avText);
		const __avSource = String(message?.content?.source ?? "");
		const __avExpectedSource = "";
		const __avSourceOk = __avExpectedSource
			? __avSource === __avExpectedSource
			: Boolean(
					__avSource ||
						state ||
						runtime?.agentId ||
						runtime?.getService ||
						runtime?.getSetting,
				);
		const __avOptions = options && typeof options === "object" ? options : {};
		const __avInputOk =
			__avText.trim().length > 0 ||
			Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
			Boolean(message?.content && typeof message.content === "object");

		if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
			return false;
		}

		const __avLegacyValidate = async (
			legacyRuntime: IAgentRuntime,
			legacyMessage: Memory,
			legacyState?: unknown,
			legacyOptions?: Record<string, unknown>,
		): Promise<boolean> => {
			const __avTextRaw =
				typeof legacyMessage?.content?.text === "string"
					? legacyMessage.content.text
					: "";
			const __avText = __avTextRaw.toLowerCase();
			const __avKeywords = ["record", "trust", "interaction"];
			const __avKeywordOk =
				__avKeywords.length > 0 &&
				__avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
			const __avRegex = /\b(?:record|trust|interaction)\b/i;
			const __avRegexOk = __avRegex.test(__avText);
			const __avSource = String(legacyMessage?.content?.source ?? "");
			const __avExpectedSource = "";
			const __avSourceOk = __avExpectedSource
				? __avSource === __avExpectedSource
				: Boolean(
						__avSource ||
							legacyState ||
							legacyRuntime?.agentId ||
							legacyRuntime?.getService,
					);
			const __avOptions =
				legacyOptions && typeof legacyOptions === "object" ? legacyOptions : {};
			const __avInputOk =
				__avText.trim().length > 0 ||
				Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
				Boolean(
					legacyMessage?.content && typeof legacyMessage.content === "object",
				);

			if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
				return false;
			}

			try {
				return hasTrustEngine(legacyRuntime);
			} catch {
				return false;
			}
		};
		try {
			return Boolean(
				await __avLegacyValidate(runtime, message, state, options),
			);
		} catch {
			return false;
		}
	},

	handler: async (runtime: IAgentRuntime, message: Memory) => {
		const trustEngine = runtime.getService("trust-engine") as unknown as {
			recordInteraction: (interaction: TrustInteraction) => Promise<void>;
		} | null;

		if (!trustEngine) {
			throw new Error("Trust engine service not available");
		}

		const text = message.content.text || "";
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = parseJSONObjectFromText(text);
		} catch {
			// Not JSON
		}
		const parsedContent = parsed as {
			type?: string;
			targetEntityId?: string;
			impact?: number;
			description?: string;
			verified?: boolean;
		} | null;

		if (!parsedContent?.type) {
				return {
					success: false,
					text: "Could not parse trust interaction details. Please provide type and optionally: targetEntityId, impact, description",
					error: "Invalid or missing interaction type",
					data: { actionName: "RECORD_TRUST_INTERACTION" },
				};
		}

		const evidenceType = parsedContent.type as TrustEvidenceType;
		const targetEntityId = parsedContent.targetEntityId as UUID;
		const impact = parsedContent.impact as number;

		const validTypes = Object.values(TrustEvidenceType);
		const normalizedType = evidenceType?.toUpperCase();
		const matchedType = validTypes.find(
			(type) => type.toUpperCase() === normalizedType,
		);

		if (!matchedType) {
			logger.error(
				{ evidenceType },
				"[RecordTrustInteraction] Invalid evidence type:",
			);
				return {
					success: false,
					text: `Invalid interaction type. Valid types are: ${validTypes.join(", ")}`,
					error: "Invalid evidence type provided",
					data: { actionName: "RECORD_TRUST_INTERACTION" },
				};
		}

		const finalTargetEntityId = targetEntityId || runtime.agentId;
		const finalImpact = impact ?? 10;

		const interaction: TrustInteraction = {
			sourceEntityId: message.entityId,
			targetEntityId: finalTargetEntityId,
			type: matchedType,
			timestamp: Date.now(),
			impact: finalImpact,
			details: {
				description:
					parsedContent.description || `Trust interaction: ${matchedType}`,
				messageId: message.id,
				roomId: message.roomId,
			},
			context: {
				evaluatorId: runtime.agentId,
				roomId: message.roomId,
			},
		};

		try {
			await trustEngine.recordInteraction(interaction);

			logger.info(
				{
					type: matchedType,
					source: message.entityId,
					target: interaction.targetEntityId,
					impact: interaction.impact,
				},
				"[RecordTrustInteraction] Recorded interaction:",
			);

			return {
				success: true,
					text: `Trust interaction recorded: ${matchedType} with impact ${interaction.impact > 0 ? "+" : ""}${interaction.impact}`,
					data: {
						actionName: "RECORD_TRUST_INTERACTION",
						interaction,
					success: true,
				},
			};
		} catch (error) {
			logger.error(
				{ error },
				"[RecordTrustInteraction] Error recording interaction:",
			);
			return {
				success: false,
					text: "Failed to record trust interaction. Please try again.",
					error: error instanceof Error ? error.message : "Unknown error",
					data: { actionName: "RECORD_TRUST_INTERACTION" },
				};
		}
	},

	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "Record that Alice kept their promise to help with the project",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Trust interaction recorded: PROMISE_KEPT with impact +15",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Log suspicious behavior from Bob who is spamming the channel",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Trust interaction recorded: SPAM_BEHAVIOR with impact -10",
				},
			},
		],
	],

	similes: [
		"record trust event",
		"log trust interaction",
		"track behavior",
		"note trustworthy action",
		"report suspicious activity",
		"document promise kept",
		"mark helpful contribution",
	],
};
