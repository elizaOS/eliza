/**
 * Implements the NONE action of the basic-capabilities bundle: the no-op the
 * planner selects when a turn needs a response but no further action. handler()
 * performs no side effects and returns a success ActionResult.
 */
import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";

// Get text content from centralized specs
const spec = requireActionSpec("NONE");

export const noneAction: Action = {
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
	): Promise<ActionResult> => {
		return {
			text: "",
			values: {
				success: true,
				actionType: "NONE",
			},
			data: {
				actionName: "NONE",
				description: "Response without additional action",
			},
			success: true,
		};
	},
	examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
