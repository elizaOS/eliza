/**
 * LIST_AGENTS action - List active task-agent sessions and task progress.
 *
 * Returns information about running PTY sessions together with the current
 * coordinator task state so the main agent can keep the user updated while
 * background work continues.
 *
 * @module actions/list-agents
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { getCoordinator, type PTYService } from "../services/pty-service.ts";
import type { SessionInfo } from "../services/pty-types.ts";
import {
	formatTaskAgentStatus,
	getTaskAgentFrameworkState,
	TASK_AGENT_FRAMEWORK_LABELS,
	truncateTaskAgentText,
} from "../services/task-agent-frameworks.ts";
import { requireTaskAgentAccess } from "../services/task-policy.ts";

interface TaskLike {
	sessionId: string;
	agentType: string;
	label: string;
	originalTask: string;
	status: string;
	decisions: Array<{ reasoning?: string }>;
	completionSummary?: string;
	registeredAt: number;
}

function uniqueTasks(tasks: TaskLike[]): TaskLike[] {
	const seen = new Set<string>();
	const result: TaskLike[] = [];
	for (const task of tasks) {
		if (seen.has(task.sessionId)) continue;
		seen.add(task.sessionId);
		result.push(task);
	}
	return result;
}

export const listAgentsAction: Action = {
	name: "LIST_AGENTS",

	similes: [
		"LIST_CODING_AGENTS",
		"SHOW_CODING_AGENTS",
		"GET_ACTIVE_AGENTS",
		"LIST_SESSIONS",
		"SHOW_CODING_SESSIONS",
		"SHOW_TASK_AGENTS",
		"LIST_SUB_AGENTS",
		"SHOW_TASK_STATUS",
	],

	description:
		"List active task agents together with current task progress so the main agent can keep the user updated while work continues asynchronously.",

	examples: [
		[
			{
				name: "{{user1}}",
				content: {
					text: "What task agents are running right now and what are they doing?",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "I'll pull the current task-agent status.",
					action: "LIST_AGENTS",
				},
			},
		],
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
	): Promise<boolean> => {
		const ptyService = runtime.getService("PTY_SERVICE") as unknown as
			| PTYService
			| undefined;
		return ptyService != null;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult | undefined> => {
		const access = await requireTaskAgentAccess(runtime, message, "interact");
		if (!access.allowed) {
			if (callback) {
				await callback({
					text: access.reason,
				});
			}
			return { success: false, error: "FORBIDDEN", text: access.reason };
		}

		const ptyService = runtime.getService("PTY_SERVICE") as unknown as
			| PTYService
			| undefined;
		if (!ptyService) {
			if (callback) {
				await callback({
					text: "PTY Service is not available.",
				});
			}
			return { success: false, error: "SERVICE_UNAVAILABLE" };
		}

		const sessions = await ptyService.listSessions();
		const coordinator = getCoordinator(runtime);
		const tasks = uniqueTasks(
			((coordinator?.getAllTaskContexts?.() ?? []) as TaskLike[]).slice(),
		);
		const frameworkState = await getTaskAgentFrameworkState(
			runtime,
			ptyService,
		);

		if (sessions.length === 0 && tasks.length === 0) {
			const text =
				`No active task agents. Recommended default: ${TASK_AGENT_FRAMEWORK_LABELS[frameworkState.preferred.id]} (${frameworkState.preferred.reason}). ` +
				"Use CREATE_TASK when the user needs substantial background work.";
			if (callback) {
				await callback({ text });
			}
			return {
				success: true,
				text,
				data: {
					sessions: [],
					tasks: [],
					preferredTaskAgent: frameworkState.preferred,
				},
			};
		}

		const lines: string[] = [];
		if (sessions.length > 0) {
			lines.push(`Active task agents (${sessions.length}):`);
			for (const session of sessions) {
				const label =
					typeof session.metadata?.label === "string"
						? session.metadata.label
						: session.name;
				lines.push(
					`- "${label}" (${session.agentType}, ${formatTaskAgentStatus(session.status)}) [session: ${session.id}]`,
				);
			}
		}

		if (tasks.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push(`Current task status (${tasks.length}):`);
			for (const task of tasks
				.slice()
				.sort((left, right) => right.registeredAt - left.registeredAt)) {
				const detail =
					task.completionSummary ||
					task.decisions.at(-1)?.reasoning ||
					truncateTaskAgentText(task.originalTask, 110);
				lines.push(
					`- [${task.status}] "${task.label}" (${task.agentType}) -> ${detail}`,
				);
			}
		}

		const reusableSessions = sessions.filter((session) => {
			const currentTask = tasks.find((task) => task.sessionId === session.id);
			return !currentTask || currentTask.status !== "active";
		});
		if (reusableSessions.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push(
				`Reusable task agents (${reusableSessions.length}): assign a new tracked task with SEND_TO_AGENT.`,
			);
			for (const session of reusableSessions) {
				const label =
					typeof session.metadata?.label === "string"
						? session.metadata.label
						: session.name;
				lines.push(
					`- "${label}" (${session.agentType}) is ${formatTaskAgentStatus(session.status)} and can take a new task`,
				);
			}
		}

		const pending = coordinator?.getPendingConfirmations?.() ?? [];
		if (pending.length > 0) {
			lines.push("");
			lines.push(
				`Pending confirmations: ${pending.length} (${coordinator?.getSupervisionLevel?.() ?? "unknown"} supervision).`,
			);
		}

		const text = lines.join("\n");
		if (callback) {
			await callback({ text });
		}

		return {
			success: true,
			text,
			data: {
				sessions: sessions.map((session: SessionInfo) => ({
					id: session.id,
					agentType: session.agentType,
					status: session.status,
					workdir: session.workdir,
					createdAt: session.createdAt.toISOString(),
					lastActivity: session.lastActivityAt.toISOString(),
					label:
						typeof session.metadata?.label === "string"
							? session.metadata.label
							: session.name,
				})),
				tasks: tasks.map((task) => ({
					sessionId: task.sessionId,
					agentType: task.agentType,
					label: task.label,
					status: task.status,
					originalTask: task.originalTask,
					completionSummary: task.completionSummary,
				})),
				pendingConfirmations: pending.length,
				preferredTaskAgent: frameworkState.preferred,
			},
		};
	},

	parameters: [],
};

export const listTaskAgentsAction = listAgentsAction;
