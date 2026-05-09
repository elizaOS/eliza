import { logger } from "../../../logger.ts";
import type {
	Action as ElizaAction,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import { parseJSONObjectFromText } from "../../../utils.ts";
import type { TrustEngineServiceWrapper } from "../services/wrappers.ts";
import { TrustEvidenceType, type TrustInteraction } from "../types/trust.ts";
import { hasTrustEngine } from "./hasTrustEngine.ts";

export const recordTrustInteractionAction: ElizaAction = {
	name: "RECORD_TRUST_INTERACTION",
	contexts: ["admin", "settings", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	description: "Records a trust-affecting interaction between entities",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "type",
			description: "Trust evidence type to record.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "targetEntityId",
			description: "Target entity ID. Defaults to the agent ID.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "impact",
			description: "Numerical trust impact. Defaults to 10.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "description",
			description: "Optional interaction description.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: Record<string, unknown>,
	): Promise<boolean> => {
		try {
			if (!hasTrustEngine(runtime)) return false;
			const params =
				options?.parameters && typeof options.parameters === "object"
					? (options.parameters as Record<string, unknown>)
					: {};
			const hasStructuredType =
				typeof params.type === "string" && params.type.trim().length > 0;
			return (
				hasStructuredType ||
				hasActionContextOrKeyword(message, state, {
					contexts: ["admin", "settings", "agent_internal"],
					keywords: [
						"record trust",
						"trust interaction",
						"trust evidence",
						"kept their promise",
					],
				})
			);
		} catch {
			return false;
		}
	},

	handler: async (runtime: IAgentRuntime, message: Memory, _state, options) => {
		const trustEngineService =
			runtime.getService<TrustEngineServiceWrapper>("trust-engine");

		if (!trustEngineService) {
			throw new Error("Trust engine service not available");
		}

		const params =
			options?.parameters && typeof options.parameters === "object"
				? (options.parameters as Record<string, unknown>)
				: {};
		const text = message.content.text || "";
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = parseJSONObjectFromText(text);
		} catch {
			// Not JSON
		}
		const parsedContent = { ...(parsed ?? {}), ...params } as {
			type?: string;
			targetEntityId?: string;
			impact?: number;
			description?: string;
			verified?: boolean;
		};

		if (!parsedContent.type) {
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
			await trustEngineService.trustEngine.recordInteraction(interaction);

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
