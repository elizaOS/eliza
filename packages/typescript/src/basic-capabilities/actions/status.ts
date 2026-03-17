/**
 * Status Action
 *
 * Displays agent name, ID, room name, optional compaction timestamp,
 * and pending/queued task counts.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../types/index.ts";
import type { Task } from "../../types/task.ts";

export const statusAction: Action = {
	name: "STATUS",
	similes: ["STATUS", "INFO", "ABOUT"],
	description:
		"Show agent status: name, ID, room, last compaction time (if any), and pending/queued task counts.",

	validate: async (): Promise<boolean> => {
		return true;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
		_responses?: Memory[],
	): Promise<ActionResult> => {
		const room = state?.data?.room ?? (await runtime.getRoom(message.roomId));
		const roomName = room?.name ?? "Unknown";

		const agentName = runtime.character?.name ?? "Agent";
		const agentId = runtime.agentId;
		const shortId = agentId.substring(0, 10);

		const tasks = message.roomId
			? await runtime.getTasks({
					roomId: message.roomId,
					agentIds: [agentId],
				})
			: [];

		const awaitingChoice = tasks.filter((t: Task) =>
			t.tags?.includes("AWAITING_CHOICE"),
		).length;
		const queued = tasks.filter((t: Task) => t.tags?.includes("queue")).length;

		const lines: string[] = [];
		lines.push(`**Agent:** ${agentName}`);
		lines.push(`**ID:** ${shortId}`);
		if (room?.metadata?.lastCompactionAt != null) {
			const lastCompactionAt = room.metadata.lastCompactionAt as number;
			lines.push(
				`**Last Reset:** ${new Date(lastCompactionAt).toLocaleString()}`,
			);
		}
		lines.push(`**Room:** ${roomName}`);

		if (tasks.length === 0) {
			lines.push("**Pending Tasks:** No pending tasks");
		} else {
			if (awaitingChoice > 0) {
				lines.push(`**Pending Tasks:** Awaiting choice: ${awaitingChoice}`);
				tasks
					.filter((t: Task) => t.tags?.includes("AWAITING_CHOICE"))
					.forEach((t: Task) => {
						lines.push(`  - ${t.name}`);
					});
			}
			if (queued > 0) {
				lines.push(`Queued: ${queued}`);
			}
			if (awaitingChoice === 0 && queued === 0) {
				lines.push("**Pending Tasks:** No pending tasks");
			}
		}

		const text = lines.join("\n");

		if (callback) {
			await callback({
				text,
				actions: ["STATUS"],
				source: message.content?.source,
			});
		}

		return {
			success: true,
			text,
			values: {
				agentId,
				agentName,
				tasks: {
					total: tasks.length,
					awaitingChoice,
					queued,
				},
			},
		};
	},
};

export default statusAction;
