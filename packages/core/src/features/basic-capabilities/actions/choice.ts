/**
 * Implements the CHOOSE_OPTION action of the basic-capabilities bundle: the
 * agent's way to resolve a pending choice task (tasks tagged AWAITING_CHOICE
 * whose metadata carries `options`). validate() gates on the declared
 * `roleGate: { minRole: "ADMIN" }` plus the existence of such a task — it never
 * re-derives the role itself. handler() matches the caller's complete taskId
 * and selectedOption, then runs the matching task
 * worker (or deletes the task on the "ABORT" option); with no valid selection it
 * replies with the formatted menu of tasks and their options. Task identifiers
 * remain complete in both the menu and lookup so chat context cannot hide a
 * distinguishing suffix or create an eight-character collision.
 */
import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";

const spec = requireActionSpec("CHOOSE_OPTION");

function _readChoiceParameters(
	message: Memory,
	options?: HandlerOptions,
): { taskId?: string; selectedOption?: string } {
	const params =
		options?.parameters && typeof options.parameters === "object"
			? (options.parameters as Record<string, unknown>)
			: {};
	const taskId = params.taskId ?? message.content.taskId;
	const selectedOption =
		params.selectedOption ??
		params.option ??
		message.content.selectedOption ??
		message.content.option;
	return {
		taskId:
			typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined,
		selectedOption:
			typeof selectedOption === "string" && selectedOption.trim()
				? selectedOption.trim()
				: undefined,
	};
}

export const choiceAction: Action = {
	name: spec.name,
	contexts: ["general", "tasks", "admin"],
	roleGate: { minRole: "ADMIN" },
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => {
		if (!state) {
			logger.error(
				{
					src: "plugin:basic-capabilities:action:choice",
					agentId: runtime.agentId,
				},
				"State is required for validating the action",
			);
			throw new Error("State is required for validating the action");
		}

		const room = state.data.room ?? (await runtime.getRoom(message.roomId));

		if (!room?.messageServerId) {
			return false;
		}

		// #12087 Item 17: authorization is the declared `roleGate: { minRole: "ADMIN" }`,
		// enforced by canActionRun through resolveEntityRole (which correctly grants a
		// canonical owner OWNER even with no stored world role). validate() must only
		// check the action's precondition — a pending choice — not re-derive the role
		// via getUserServerRole, which returned no role for a canonical owner and
		// wrongly rejected them.
		const pendingTasks = await runtime.getTasks({
			roomId: message.roomId,
			tags: ["AWAITING_CHOICE"],
			agentIds: [runtime.agentId],
		});

		return pendingTasks.some((task) => task.metadata?.options) === true;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
		_responses?: Memory[],
	): Promise<ActionResult> => {
		const pendingTasks = await runtime.getTasks({
			roomId: message.roomId,
			tags: ["AWAITING_CHOICE"],
			agentIds: [runtime.agentId],
		});

		if (!pendingTasks || pendingTasks.length === 0) {
			return {
				text: "No pending tasks with options found",
				values: {
					success: false,
					error: "NO_PENDING_TASKS",
				},
				data: {
					actionName: "CHOOSE_OPTION",
					error: "No pending tasks with options found",
				},
				success: false,
			};
		}

		const tasksWithOptions = pendingTasks.filter(
			(task) => task.metadata?.options,
		);

		if (!tasksWithOptions.length) {
			return {
				text: "No tasks currently have options to select from",
				values: {
					success: false,
					error: "NO_OPTIONS_AVAILABLE",
				},
				data: {
					actionName: "CHOOSE_OPTION",
					error: "No tasks currently have options to select from",
				},
				success: false,
			};
		}

		const formattedTasks = tasksWithOptions
			.filter(
				(task): task is typeof task & { id: NonNullable<typeof task.id> } => {
					if (!task.id) {
						throw new Error(`Task "${task.name}" is missing required id field`);
					}
					return true;
				},
			)
			.map((task) => {
				const taskMetadata = task.metadata;
				const taskOptions = taskMetadata?.options;

				return {
					taskId: task.id,
					name: task.name,
					options: taskOptions
						? taskOptions.map((opt) => ({
								name: typeof opt === "string" ? opt : opt.name,
								description:
									typeof opt === "string" ? opt : opt.description || opt.name,
							}))
						: [],
				};
			});

		const { taskId, selectedOption } = _readChoiceParameters(message, _options);

		if (taskId && selectedOption) {
			const taskMap = new Map(
				formattedTasks.map((task) => [task.taskId, task] as const),
			);
			const taskInfo = taskMap.get(taskId);

			if (!taskInfo) {
				// No visible callback: the model-emitted taskId is planner detail
				// the user never typed; the evaluator delivers the miss in voice.
				return {
					text: `Could not find task with ID: ${taskId}`,
					values: {
						success: false,
						error: "TASK_NOT_FOUND",
						taskId,
					},
					data: {
						actionName: "CHOOSE_OPTION",
						error: "Task not found",
						taskId,
					},
					success: false,
				};
			}

			// Find the actual task using the full UUID
			const selectedTask = tasksWithOptions.find(
				(task) => task.id === taskInfo.taskId,
			);

			if (!selectedTask) {
				if (callback) {
					await callback({
						text: "Error locating the selected task. Please try again.",
						actions: ["SELECT_OPTION_ERROR"],
						source: message.content.source,
					});
				}
				return {
					text: "Error locating the selected task",
					values: {
						success: false,
						error: "TASK_LOOKUP_ERROR",
					},
					data: {
						actionName: "CHOOSE_OPTION",
						error: "Failed to locate task",
					},
					success: false,
				};
			}

			if (!selectedTask.id) {
				throw new Error(
					`Selected task "${selectedTask.name}" is missing required id field`,
				);
			}
			const selectedTaskId = selectedTask.id;

			if (selectedOption === "ABORT") {
				await runtime.deleteTask(selectedTaskId);
				const cancelledText = `Task "${selectedTask.name}" has been cancelled.`;
				if (callback) {
					await callback({
						text: cancelledText,
						actions: ["CHOOSE_OPTION_CANCELLED"],
						source: message.content.source,
					});
				}
				// The cancellation confirmation is the complete answer to a
				// single-operation turn: verified + turnComplete make the callback
				// the sole delivery instead of double-messaging with the evaluator.
				return {
					text: cancelledText,
					userFacingText: cancelledText,
					verifiedUserFacing: true,
					turnComplete: true,
					values: {
						success: true,
						taskAborted: true,
						taskId: selectedTaskId,
						taskName: selectedTask.name,
					},
					data: {
						actionName: "CHOOSE_OPTION",
						selectedOption: "ABORT",
						taskId: selectedTaskId,
						taskName: selectedTask.name,
					},
					success: true,
				};
			}

			const taskWorker = runtime.getTaskWorker(selectedTask.name);
			if (taskWorker) {
				if (taskWorker.canExecute) {
					const stateForCanExecute = _state ?? ({} as State);
					const allowed = await taskWorker.canExecute(
						runtime,
						message,
						stateForCanExecute,
					);
					if (!allowed) {
						// No visible callback: the evaluator delivers the
						// permission denial in voice, once.
						return {
							text: "You don't have permission to execute this task.",
							values: { success: false, error: "FORBIDDEN" },
							data: {
								actionName: "CHOOSE_OPTION",
								error: "You don't have permission to execute this task.",
							},
							success: false,
						};
					}
				}
				await taskWorker.execute(
					runtime,
					{ option: selectedOption },
					selectedTask,
				);
			}
			// No visible callback: "Selected option: X for task: Y" is tool-speak,
			// and the evaluator's in-voice reply is the user's single answer. The
			// selection detail stays planner-facing in the result text.
			return {
				text: `Selected option: ${selectedOption} for task: ${selectedTask.name}`,
				values: {
					success: true,
					selectedOption,
					taskId: selectedTaskId,
					taskName: selectedTask.name,
					taskExecuted: true,
				},
				data: {
					actionName: "CHOOSE_OPTION",
					selectedOption,
					taskId: selectedTaskId,
					taskName: selectedTask.name,
				},
				success: true,
			};
		}

		let optionsText =
			"Please select a valid option from one of these tasks:\n\n";

		tasksWithOptions.forEach((task) => {
			optionsText += `**${task.name}** (ID: ${task.id}):\n`;
			const taskMetadata = task.metadata;
			const options = taskMetadata?.options
				? taskMetadata.options.map((opt) =>
						typeof opt === "string" ? opt : opt.name,
					)
				: [];
			options.push("ABORT");
			optionsText += options.map((opt) => `- ${opt}`).join("\n");
			optionsText += "\n\n";
		});

		if (callback) {
			await callback({
				text: optionsText,
				actions: ["SELECT_OPTION_INVALID"],
				source: message.content.source,
			});
		}

		// The options menu IS the designed ask the user must answer (same shape
		// as the two-phase confirm prompts): verified + turnComplete make it the
		// turn's sole delivery instead of pairing it with a second evaluator
		// reply. The un-selected state stays visible to the planner in data.
		return {
			text: "No valid option selected; asked the user to pick from the open task menus",
			userFacingText: optionsText,
			verifiedUserFacing: true,
			turnComplete: true,
			values: {
				success: true,
				awaitingSelection: true,
				availableTasksCount: tasksWithOptions.length,
			},
			data: {
				actionName: "CHOOSE_OPTION",
				error: "No valid selection made",
				availableTaskNames: formattedTasks.map((t) => t.name),
			},
			success: true,
		};
	},

	parameters: [
		{
			name: "taskId",
			description: "Complete ID of the pending choice task.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "selectedOption",
			description: "Option name to select for the pending task.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: (spec.examples ?? []) as ActionExample[][],
};

export default choiceAction;
