/**
 * Implements the IGNORE action of the basic-capabilities bundle: the agent's way
 * to intentionally stop responding — spam, hostility, or a thread it was asked
 * to leave. handler() re-emits the pre-composed response content (if any) via the
 * callback and returns a success result flagged `ignored`.
 */
import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import type {
	Action,
	ActionExample,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";

// Get text content from centralized specs
const spec = requireActionSpec("IGNORE");

export const ignoreAction: Action = {
	name: spec.name,
	contexts: ["general"],
	roleGate: { minRole: "USER" },
	similes: spec.similes ? [...spec.similes] : [],
	parameters: [],
	validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) =>
		hasActionContext(message, state, {
			contexts: ["general"],
		}),
	description: spec.description,
	handler: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
		responses?: Memory[],
	) => {
		if (callback && responses?.[0]?.content) {
			await callback(responses[0].content);
		}
		return {
			text: "",
			values: { success: true, ignored: true },
			data: { actionName: "IGNORE" },
			success: true,
		};
	},
	examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
