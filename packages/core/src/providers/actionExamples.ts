import {
	composeActionExamples,
	formatActionNames,
	formatActions,
} from "../actions";
import { addHeader } from "../prompts";
import type { Action, IAgentRuntime, Memory, Provider, State } from "../types";

export const actionsProvider: Provider = {
	name: "ACTIONS",
	description: "Possible response actions",
	position: -1,
	get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
		// Get actions that validate for this message
		const actionPromises = runtime.actions.map(async (action: Action) => {
			const result = await action.validate(runtime, message, state);
			if (result) {
				return action;
			}
			return null;
		});

		const resolvedActions = await Promise.all(actionPromises);

		const actionsData = resolvedActions.filter(Boolean) as Action[];

		// Format action-related texts
		const actionNames = `Possible response actions: ${formatActionNames(
			actionsData,
		)}`;

		const actions =
			actionsData.length > 0
				? addHeader("# Available Actions", formatActions(actionsData))
				: "";

		const actionExamples =
			actionsData.length > 0
				? addHeader("# Action Examples", composeActionExamples(actionsData, 10))
				: "";

		const data = {
			actionsData,
		};

		const values = {
			actions,
			actionNames,
			actionExamples,
		};

		// Combine all text sections
		const text = [actionNames, actionExamples, actions]
			.filter(Boolean)
			.join("\n\n");

		return {
			data,
			values,
			text,
		};
	},
};
