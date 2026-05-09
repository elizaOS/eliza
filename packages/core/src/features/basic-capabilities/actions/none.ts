import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";

// Get text content from centralized specs
const spec = requireActionSpec("NONE");

export const noneAction: Action = {
	name: spec.name,
	contexts: ["general"],
	roleGate: { minRole: "USER" },
	similes: spec.similes ? [...spec.similes] : [],
	parameters: [],
	validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) =>
		hasActionContextOrKeyword(message, state, {
			contexts: ["general"],
			keywords: ["nothing", "no action", "no tool", "just respond", "none"],
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
