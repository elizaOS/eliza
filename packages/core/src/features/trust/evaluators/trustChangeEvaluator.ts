import { logger } from "../../../logger.ts";
import type {
	Evaluator,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import type { TrustEngineServiceWrapper } from "../services/wrappers.ts";
import { TrustEvidenceType } from "../types/trust.ts";

/** Track last evaluation time per entity to prevent rapid-fire trust changes */
const lastEvaluationTime: Map<string, number> = new Map();
const EVALUATION_COOLDOWN_MS = 60_000; // 60 seconds

export const trustChangeEvaluator: Evaluator = {
	name: "trustChangeEvaluator",
	description:
		"Evaluates interactions to detect and record trust-affecting behaviors",
	alwaysRun: true,

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
	) => {
		const trustEngine = runtime.getService("trust-engine");
		return !!trustEngine;
	},

	handler: async (runtime: IAgentRuntime, message: Memory) => {
		const trustEngineWrapper = runtime.getService("trust-engine") as
			| TrustEngineServiceWrapper
			| undefined;

		if (!trustEngineWrapper) {
			return;
		}
		const trustEngine = trustEngineWrapper.trustEngine;

		const entityId = message.entityId;
		const lastTime = lastEvaluationTime.get(entityId as string);
		if (lastTime && Date.now() - lastTime < EVALUATION_COOLDOWN_MS) {
			return;
		}
		lastEvaluationTime.set(entityId as string, Date.now());

		try {
			const content = message.content.text?.toLowerCase() || "";

			const positivePatterns = [
				{
					pattern: /thank you|thanks|appreciate|grateful/i,
					type: TrustEvidenceType.HELPFUL_ACTION,
					impact: 5,
				},
				{
					pattern: /helped|assisted|supported|solved/i,
					type: TrustEvidenceType.HELPFUL_ACTION,
					impact: 10,
				},
				{
					pattern: /kept.*promise|delivered|followed through/i,
					type: TrustEvidenceType.PROMISE_KEPT,
					impact: 15,
				},
				{
					pattern: /contributed|shared|provided/i,
					type: TrustEvidenceType.COMMUNITY_CONTRIBUTION,
					impact: 8,
				},
			];

			const negativePatterns = [
				{
					pattern: /spam|flood|repeat/i,
					type: TrustEvidenceType.SPAM_BEHAVIOR,
					impact: -10,
				},
				{
					pattern: /broke.*promise|failed to|didn't deliver/i,
					type: TrustEvidenceType.PROMISE_BROKEN,
					impact: -15,
				},
				{
					pattern: /hack|exploit|cheat/i,
					type: TrustEvidenceType.SECURITY_VIOLATION,
					impact: -25,
				},
				{
					pattern: /harass|abuse|threat/i,
					type: TrustEvidenceType.HARMFUL_ACTION,
					impact: -20,
				},
			];

			for (const { pattern, type, impact } of positivePatterns) {
				if (pattern.test(content)) {
					await trustEngine.recordInteraction({
						sourceEntityId: entityId,
						targetEntityId: runtime.agentId,
						type,
						timestamp: Date.now(),
						impact,
						details: {
							description: `Positive behavior detected: ${type}`,
							messageId: message.id,
							roomId: message.roomId,
							autoDetected: true,
						},
						context: {
							evaluatorId: runtime.agentId,
							roomId: message.roomId,
						},
					});

					logger.info(
						{
							entityId,
							type,
							impact,
						},
						"[TrustChangeEvaluator] Recorded positive behavior:",
					);

					return {
						success: true,
						text: `Noted positive behavior: ${type} (+${impact} trust)`,
						data: { type, impact, positive: true },
					};
				}
			}

			for (const { pattern, type, impact } of negativePatterns) {
				if (pattern.test(content)) {
					await trustEngine.recordInteraction({
						sourceEntityId: entityId,
						targetEntityId: runtime.agentId,
						type,
						timestamp: Date.now(),
						impact,
						details: {
							description: `Negative behavior detected: ${type}`,
							messageId: message.id,
							roomId: message.roomId,
							autoDetected: true,
						},
						context: {
							evaluatorId: runtime.agentId,
							roomId: message.roomId,
						},
					});

					logger.warn(
						{
							entityId,
							type,
							impact,
						},
						"[TrustChangeEvaluator] Recorded negative behavior:",
					);

					return {
						success: false,
						text: `Noted concerning behavior: ${type} (${impact} trust)`,
						data: { type, impact, positive: false },
					};
				}
			}

			try {
				const recentMessages = await runtime.getMemories({
					tableName: "messages",
					roomId: message.roomId,
					count: 50,
				});

				const oneMinuteAgo = Date.now() - 60_000;
				const recentFromEntity = recentMessages.filter(
					(m) =>
						m.entityId === entityId &&
						m.createdAt &&
						m.createdAt > oneMinuteAgo,
				);

				if (recentFromEntity.length > 10) {
					await trustEngine.recordInteraction({
						sourceEntityId: entityId,
						targetEntityId: runtime.agentId,
						type: TrustEvidenceType.SPAM_BEHAVIOR,
						timestamp: Date.now(),
						impact: -5,
						details: {
							description: "High message frequency detected",
							messageCount: recentFromEntity.length,
							roomId: message.roomId,
							autoDetected: true,
						},
						context: {
							evaluatorId: runtime.agentId,
							roomId: message.roomId,
						},
					});

					logger.warn(
						{ entityId, messageCount: recentFromEntity.length },
						"[TrustChangeEvaluator] High message frequency detected",
					);
				}
			} catch (spamErr) {
				logger.debug(
					{ error: spamErr },
					"[TrustChangeEvaluator] Spam detection check failed",
				);
			}

			return;
		} catch (error) {
			logger.error(
				{ error },
				"[TrustChangeEvaluator] Error evaluating trust changes:",
			);
			return;
		}
	},

	examples: [
		{
			prompt: "User sends a helpful message",
			messages: [
				{
					name: "{{name1}}",
					content: {
						text: "Thanks for helping me understand the trust system!",
					},
				},
			],
			outcome: "Positive behavior detected and trust increased",
		},
		{
			prompt: "User exhibits spam behavior",
			messages: [
				{
					name: "{{name1}}",
					content: {
						text: "SPAM SPAM SPAM SPAM SPAM",
					},
				},
			],
			outcome: "Negative behavior detected and trust decreased",
		},
	],
};
