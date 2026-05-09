import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import { getUserServerRole } from "../../../roles.ts";
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
		params.selectedOption ?? message.content.selectedOption;
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

		const userRole = await getUserServerRole(
			runtime,
			message.entityId,
			room.messageServerId,
		);

		if (userRole !== "OWNER" && userRole !== "ADMIN") {
			return false;
		}

		const pendingTasks = await runtime.getTasks({
			roomId: message.roomId,
			tags: ["AWAITING_CHOICE"],
			agentIds: [runtime.agentId],
		});

		return pendingTasks?.some((task) => task.metadata?.options) === true;
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
				const shortId = task.id.substring(0, 8);
				const taskMetadata = task.metadata;
				const taskOptions = taskMetadata?.options;

				return {
					taskId: shortId,
					fullId: task.id,
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
				formattedTasks.map((task) => [task.taskId, task]),
			);
			const taskInfo = taskMap.get(taskId) as
				| (typeof formattedTasks)[0]
				| undefined;

			if (!taskInfo) {
				if (callback) {
					await callback({
						text: `Could not find a task matching ID: ${taskId}. Please try again.`,
						actions: ["SELECT_OPTION_ERROR"],
						source: message.content.source,
					});
				}
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
				(task) => task.id === taskInfo.fullId,
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
				if (callback) {
					await callback({
						text: `Task "${selectedTask.name}" has been cancelled.`,
						actions: ["CHOOSE_OPTION_CANCELLED"],
						source: message.content.source,
					});
				}
				return {
					text: `Task "${selectedTask.name}" has been cancelled`,
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
						if (callback) {
							await callback({
								text: "You don't have permission to execute this task.",
							});
						}
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
			if (callback) {
				await callback({
					text: `Selected option: ${selectedOption} for task: ${selectedTask.name}`,
					actions: ["CHOOSE_OPTION"],
					source: message.content.source,
				});
			}
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
			const shortId = task.id?.substring(0, 8);

			optionsText += `**${task.name}** (ID: ${shortId}):\n`;
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

		return {
			text: "No valid option selected",
			values: {
				success: false,
				error: "NO_SELECTION",
				availableTasksCount: tasksWithOptions.length,
			},
			data: {
				actionName: "CHOOSE_OPTION",
				error: "No valid selection made",
				availableTaskNames: formattedTasks.map((t) => t.name),
			},
			success: false,
		};
	},

	parameters: [
		{
			name: "taskId",
			description: "Short or full ID of the pending choice task.",
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
