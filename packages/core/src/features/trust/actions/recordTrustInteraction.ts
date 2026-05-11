import { logger } from "../../../logger.ts";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { parseJSONObjectFromText } from "../../../utils.ts";
import type { TrustEngineServiceWrapper } from "../services/wrappers.ts";
import { TrustEvidenceType, type TrustInteraction } from "../types/trust.ts";

type ActionOptions = Record<string, unknown>;

function readNestedParameters(
	options: ActionOptions | undefined,
): ActionOptions {
	const nested = options?.parameters;
	if (
		typeof nested === "object" &&
		nested !== null &&
		!Array.isArray(nested)
	) {
		return nested as ActionOptions;
	}
	return {};
}

export async function recordTrustInteractionHandler(
	runtime: IAgentRuntime,
	message: Memory,
	_state: State | undefined,
	options: ActionOptions | undefined,
): Promise<ActionResult> {
	const trustEngineService =
		runtime.getService<TrustEngineServiceWrapper>("trust-engine");

	if (!trustEngineService) {
		return {
			success: false,
			text: "Trust engine service is not available.",
			error: "Trust engine service not available",
			data: { actionName: "TRUST", subaction: "record_interaction" },
		};
	}

	const params = readNestedParameters(options);
	const text = message.content.text || "";
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = parseJSONObjectFromText(text);
	} catch {
		// Not JSON
	}
	const parsedContent = { ...(parsed ?? {}), ...params } as {
		type?: string;
		entityId?: string;
		targetEntityId?: string;
		impact?: number;
		description?: string;
		verified?: boolean;
	};

	if (!parsedContent.type) {
		return {
			success: false,
			text: "Could not parse trust interaction details. Please provide type and optionally: entityId, impact, description",
			error: "Invalid or missing interaction type",
			data: { actionName: "TRUST", subaction: "record_interaction" },
		};
	}

	const evidenceType = parsedContent.type as TrustEvidenceType;
	const targetEntityId = (parsedContent.entityId ??
		parsedContent.targetEntityId) as UUID | undefined;
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
			data: { actionName: "TRUST", subaction: "record_interaction" },
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
				actionName: "TRUST",
				subaction: "record_interaction",
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
			data: { actionName: "TRUST", subaction: "record_interaction" },
		};
	}
}
