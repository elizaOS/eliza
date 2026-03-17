/**
 * Execution facade for autonomy: runs the same post-LLM steps as the message
 * pipeline (processActions, memory creation, evaluators) given batcher result
 * fields and a synthetic autonomy message.
 *
 * WHY: The batcher delivers the Reason phase output; we must run Run actions +
 * Evaluate without duplicating message.ts. One facade keeps schema and semantics
 * aligned and gives a single place to change post-LLM behavior.
 */

import { v4 as uuidv4 } from "uuid";
import { createUniqueUuid } from "../entities";
import type {
	Content,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "../types";
import { stringToUuid } from "../utils";

/**
 * Normalize batcher result fields into Content shape expected by processActions
 * and the message pipeline. WHY: The dispatcher returns namespace-stripped
 * fields; processActions expects Content (thought, actions array, text, simple,
 * providers). We accept array or comma-separated string for actions/providers
 * so we tolerate both schema encodings.
 */
function fieldsToContent(fields: Record<string, unknown>): Content {
	const actionsRaw = fields.actions;
	const normalizedActions = (() => {
		if (Array.isArray(actionsRaw)) {
			return (actionsRaw as unknown[])
				.map((a) => String(a).trim())
				.filter((a) => a.length > 0);
		}
		if (typeof actionsRaw === "string") {
			return actionsRaw
				.split(",")
				.map((a) => String(a).trim())
				.filter((a) => a.length > 0);
		}
		return [];
	})();
	// WHY: Empty actions would break processActions expectations; IGNORE is the safe no-op.
	const finalActions =
		normalizedActions.length > 0 ? normalizedActions : ["IGNORE"];

	const providers = Array.isArray(fields.providers)
		? (fields.providers as unknown[]).filter(
				(p): p is string => typeof p === "string",
			)
		: typeof fields.providers === "string"
			? fields.providers
					.split(",")
					.map((p) => String(p).trim())
					.filter((p) => p.length > 0)
			: [];

	return {
		thought: String(fields.thought ?? ""),
		actions: finalActions,
		text: String(fields.text ?? ""),
		simple: fields.simple === true || fields.simple === "true",
		providers,
	};
}

/**
 * Run the same post-LLM steps as the message pipeline for an autonomy response:
 * build response content and messages, save to memory, process actions, run
 * evaluators. Call this from the autonomy batcher section's onResult.
 *
 * @param runtime - Agent runtime
 * @param autonomousMessage - Synthetic message representing the autonomy prompt (entityId = autonomy entity, roomId = autonomous room, content.metadata isAutonomous etc.)
 * @param fields - Batcher result fields (thought, actions, text, simple, etc.; namespace already stripped)
 * @param callback - Optional handler callback (e.g. for logging or downstream consumers)
 */
export async function runAutonomyPostResponse(
	runtime: IAgentRuntime,
	autonomousMessage: Memory,
	fields: Record<string, unknown>,
	callback?: HandlerCallback,
): Promise<void> {
	const responseContent = fieldsToContent(fields);

	// WHY: inReplyTo links the response to the autonomy "prompt" message so threading and callbacks are consistent.
	if (autonomousMessage.id) {
		responseContent.inReplyTo = createUniqueUuid(runtime, autonomousMessage.id);
	}

	const responseId = stringToUuid(uuidv4());
	// WHY: processActions expects Memory[] with content; one item matches the message pipeline's single-shot response shape.
	const responseMessages: Memory[] = [
		{
			id: responseId,
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			content: responseContent,
			roomId: autonomousMessage.roomId,
			createdAt: Date.now(),
		},
	];

	// WHY: Same provider list as message pipeline before processActions/evaluate so action names and evaluator context are available.
	const state: State = await runtime.composeState(autonomousMessage, [
		"ACTIONS",
		"RECENT_MESSAGES",
		"EVALUATORS",
	]);

	for (const responseMemory of responseMessages) {
		runtime.logger.debug(
			{ src: "autonomy:facade", memoryId: responseMemory.id },
			"Saving autonomy response to memory",
		);
		await runtime.createMemory(responseMemory, "messages");
	}

	// WHY: Mirror message pipeline logic so we take the same branch (simple = callback only, actions = processActions).
	const isSimple =
		responseContent.actions?.length === 1 &&
		String(responseContent.actions[0]).toUpperCase() === "REPLY" &&
		(!responseContent.providers || responseContent.providers.length === 0);
	const mode = isSimple && responseContent.text ? "simple" : "actions";

	if (mode === "simple" && callback) {
		if (responseContent.text) {
			responseContent.text = runtime.redactSecrets(responseContent.text);
		}
		await callback(responseContent);
	} else if (mode === "actions") {
		await runtime.processActions(
			autonomousMessage,
			responseMessages,
			state,
			async (content) => {
				runtime.logger.debug(
					{ src: "autonomy:facade", content },
					"Autonomy action callback",
				);
				if (callback) {
					return callback(content);
				}
				return [];
			},
			{},
		);
	}

	// WHY: didRespond gates some evaluators; autonomy "responded" when there is text or non-IGNORE actions.
	const didRespond =
		(typeof responseContent.text === "string" &&
			responseContent.text.trim().length > 0) ||
		(responseContent.actions &&
			responseContent.actions.length > 0 &&
			responseContent.actions[0]?.toUpperCase() !== "IGNORE");

	await runtime.evaluate(
		autonomousMessage,
		state,
		didRespond,
		async (content) => {
			runtime.logger.debug(
				{ src: "autonomy:facade", content },
				"Autonomy evaluate callback",
			);
			if (callback && content.text) {
				content.text = runtime.redactSecrets(content.text);
				return callback(content);
			}
			return [];
		},
		responseMessages,
	);
}
