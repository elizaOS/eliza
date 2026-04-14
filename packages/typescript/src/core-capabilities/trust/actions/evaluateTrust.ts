import { logger } from "../../../logger.ts";
import type {
	ActionResult,
	Action as ElizaAction,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../../types/index.ts";
import { parseJSONObjectFromText } from "../../../utils.ts";
import type { TrustProfile } from "../types/trust.ts";
import { hasTrustEngine } from "./hasTrustEngine.ts";

export const evaluateTrustAction: ElizaAction = {
	name: "EVALUATE_TRUST",
	description: "Evaluates the trust score and profile for a specified entity",

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: unknown,
		options?: Record<string, unknown>,
	): Promise<boolean> => {
		const __avTextRaw =
			typeof message?.content?.text === "string" ? message.content.text : "";
		const __avText = __avTextRaw.toLowerCase();
		const __avKeywords = ["evaluate", "trust"];
		const __avKeywordOk =
			__avKeywords.length > 0 &&
			__avKeywords.some((word) => word.length > 0 && __avText.includes(word));
		const __avRegex = /\b(?:evaluate|trust)\b/i;
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
			const __avKeywords = ["evaluate", "trust"];
			const __avKeywordOk =
				__avKeywords.length > 0 &&
				__avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
			const __avRegex = /\b(?:evaluate|trust)\b/i;
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

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state,
		_options,
		_callback,
	): Promise<ActionResult | undefined> => {
		const trustEngine = runtime.getService("trust-engine") as unknown as {
			evaluateTrust: (
				entityId: unknown,
				evaluatorId: unknown,
				context?: Record<string, unknown>,
			) => Promise<TrustProfile>;
		} | null;

		if (!trustEngine) {
			throw new Error("Trust engine service not available");
		}

		const text = message.content.text || "";
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = parseJSONObjectFromText(text);
		} catch {
			// Not JSON -- treat as plain text request
		}
		const requestData = parsed as {
			entityId?: string;
			entityName?: string;
			detailed?: boolean;
		} | null;

		let targetEntityId: UUID | undefined;
		if (requestData?.entityId) {
			targetEntityId = requestData.entityId as UUID;
		} else if (requestData?.entityName) {
			return {
				success: false,
				text: "Entity name resolution not yet implemented. Please provide entity ID.",
				error: "Entity name resolution not implemented",
			};
		} else {
			targetEntityId = message.entityId;
		}

		try {
			const trustContext = {
				evaluatorId: runtime.agentId,
				roomId: message.roomId,
			};

			const trustProfile: TrustProfile = await trustEngine.evaluateTrust(
				targetEntityId,
				runtime.agentId,
				trustContext,
			);

			const detailed = requestData?.detailed ?? false;

			if (detailed) {
				const dimensionText = Object.entries(trustProfile.dimensions)
					.map(([dim, score]) => `- ${dim}: ${score}/100`)
					.join("\n");

				const trendText =
					trustProfile.trend.direction === "increasing"
						? `Increasing (+${trustProfile.trend.changeRate.toFixed(1)} pts/day)`
						: trustProfile.trend.direction === "decreasing"
							? `Decreasing (${trustProfile.trend.changeRate.toFixed(1)} pts/day)`
							: "Stable";

				return {
					success: true,
					text: `Trust Profile for ${targetEntityId}:

Overall Trust: ${trustProfile.overallTrust}/100
Confidence: ${(trustProfile.confidence * 100).toFixed(0)}%
Interactions: ${trustProfile.interactionCount}
Trend: ${trendText}

Trust Dimensions:
${dimensionText}

Last Updated: ${new Date(trustProfile.lastCalculated).toLocaleString()}`,
					data: {
						entityId: trustProfile.entityId,
						overallTrust: trustProfile.overallTrust,
						confidence: trustProfile.confidence,
						interactionCount: trustProfile.interactionCount,
						calculationMethod: trustProfile.calculationMethod,
						lastCalculated: trustProfile.lastCalculated,
						evaluatorId: trustProfile.evaluatorId,
						dimensions: trustProfile.dimensions,
						evidence: trustProfile.evidence,
						trend: trustProfile.trend,
					},
				};
			} else {
				const trustLevel =
					trustProfile.overallTrust >= 80
						? "High"
						: trustProfile.overallTrust >= 60
							? "Good"
							: trustProfile.overallTrust >= 40
								? "Moderate"
								: trustProfile.overallTrust >= 20
									? "Low"
									: "Very Low";

				return {
					success: true,
					text: `Trust Level: ${trustLevel} (${trustProfile.overallTrust}/100) based on ${trustProfile.interactionCount} interactions`,
					data: {
						trustScore: trustProfile.overallTrust,
						trustLevel,
						confidence: trustProfile.confidence,
					},
				};
			}
		} catch (error) {
			logger.error({ error }, "[EvaluateTrust] Error evaluating trust:");
			return {
				success: false,
				text: "Failed to evaluate trust. Please try again.",
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	},

	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "What is my trust score?",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Trust Level: Good (65/100) based on 42 interactions",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Show detailed trust profile for Alice",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: `Trust Profile for Alice:

Overall Trust: 78/100
Confidence: 85%
Interactions: 127
Trend: Increasing (+0.5 pts/day)

Trust Dimensions:
- reliability: 82/100
- competence: 75/100
- integrity: 80/100
- benevolence: 85/100
- transparency: 70/100

Last Updated: 12/20/2024, 3:45:00 PM`,
				},
			},
		],
	],

	similes: [
		"check trust score",
		"evaluate trust",
		"show trust level",
		"trust rating",
		"trust profile",
		"trust assessment",
		"check reputation",
		"show trust details",
	],
};
