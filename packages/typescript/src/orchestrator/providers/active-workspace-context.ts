/**
 * Provider that injects active workspace and task-agent context into every prompt.
 *
 * Eliza needs to know what workspaces exist, which agents are running, and
 * their current status without having to call LIST_AGENTS every message. This
 * provider reads from the workspace service, PTY service, and coordinator to
 * build a live context summary that's always available in the prompt.
 *
 * @module providers/active-workspace-context
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { PTYService } from "../services/pty-service.ts";
import { getCoordinator } from "../services/pty-service.ts";
import type { SessionInfo } from "../services/pty-types.ts";
import {
	formatTaskAgentStatus,
	getTaskAgentFrameworkState,
	TASK_AGENT_FRAMEWORK_LABELS,
	truncateTaskAgentText,
} from "../services/task-agent-frameworks.ts";
import type {
	CodingWorkspaceService,
	WorkspaceResult,
} from "../services/workspace-service.ts";

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

export const activeWorkspaceContextProvider: Provider = {
	name: "ACTIVE_WORKSPACE_CONTEXT",
	description:
		"Live status of active workspaces, task-agent sessions, and current task progress",
	position: 1,

	get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
		const ptyService = runtime.getService("PTY_SERVICE") as unknown as
			| PTYService
			| undefined;
		const wsService = runtime.getService(
			"CODING_WORKSPACE_SERVICE",
		) as unknown as CodingWorkspaceService | undefined;
		const coordinator = getCoordinator(runtime);
		const frameworkState = await getTaskAgentFrameworkState(
			runtime,
			ptyService,
		);

		const sessions = ptyService
			? await Promise.race([
					ptyService.listSessions(),
					new Promise<SessionInfo[]>((resolve) =>
						setTimeout(() => resolve([]), 2000),
					),
				])
			: [];
		const workspaces = wsService?.listWorkspaces() ?? [];
		const tasks = uniqueTasks(
			((coordinator?.getAllTaskContexts?.() ?? []) as TaskLike[]).slice(),
		);
		const reusableSessions = sessions.filter((session) => {
			const currentTask = tasks.find((task) => task.sessionId === session.id);
			return !currentTask || currentTask.status !== "active";
		});

		const lines: string[] = ["# Active Workspaces & Task Agents"];
		lines.push(
			`Preferred framework: ${TASK_AGENT_FRAMEWORK_LABELS[frameworkState.preferred.id]} (${frameworkState.preferred.reason}).`,
		);

		if (
			workspaces.length === 0 &&
			sessions.length === 0 &&
			tasks.length === 0
		) {
			lines.push("No active workspaces or task-agent sessions.");
			lines.push(
				"Use CREATE_TASK when the user needs anything more involved than a simple direct reply.",
			);
		} else {
			if (workspaces.length > 0) {
				lines.push("");
				lines.push(`## Workspaces (${workspaces.length})`);
				for (const workspace of workspaces) {
					const workspaceSessions = sessions.filter(
						(session) => session.workdir === workspace.path,
					);
					const agentSummary =
						workspaceSessions.length > 0
							? workspaceSessions
									.map(
										(session) =>
											`${session.agentType}:${formatTaskAgentStatus(session.status)}`,
									)
									.join(", ")
							: "no task agents";
					lines.push(
						`- "${workspace.label ?? workspace.id.slice(0, 8)}" -> ${workspace.repo ?? "scratch"} (${workspace.branch ?? "no branch"}, ${agentSummary})`,
					);
				}
			}

			const trackedPaths = new Set(
				workspaces.map((workspace) => workspace.path),
			);
			const standaloneSessions = sessions.filter(
				(session) => !trackedPaths.has(session.workdir),
			);

			if (standaloneSessions.length > 0) {
				lines.push("");
				lines.push(`## Standalone Sessions (${standaloneSessions.length})`);
				for (const session of standaloneSessions) {
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
				lines.push("");
				lines.push(`## Current Task Status (${tasks.length})`);
				for (const task of tasks
					.slice()
					.sort((left, right) => right.registeredAt - left.registeredAt)) {
					const latestDecision = task.decisions.at(-1);
					const detail =
						task.completionSummary ||
						latestDecision?.reasoning ||
						truncateTaskAgentText(task.originalTask, 110);
					lines.push(
						`- [${task.status}] "${task.label}" (${task.agentType}) -> ${detail}`,
					);
				}
			}

			const pending = coordinator?.getPendingConfirmations?.() ?? [];
			if (pending.length > 0) {
				lines.push("");
				lines.push(
					`## Pending Confirmations (${pending.length}) - supervision: ${coordinator?.getSupervisionLevel?.() ?? "unknown"}`,
				);
				for (const confirmation of pending) {
					lines.push(
						`- "${confirmation.taskContext.label}" blocked on "${truncateTaskAgentText(confirmation.promptText, 140)}" -> suggested: ${confirmation.llmDecision.action ?? "review"}`,
					);
				}
			}

			if (reusableSessions.length > 0) {
				lines.push("");
				lines.push(`## Reusable Agents (${reusableSessions.length})`);
				for (const session of reusableSessions) {
					const label =
						typeof session.metadata?.label === "string"
							? session.metadata.label
							: session.name;
					lines.push(
						`- "${label}" (${session.agentType}) is ${formatTaskAgentStatus(session.status)} and can take a new tracked task via SEND_TO_AGENT`,
					);
				}
			}
		}

		if (sessions.length > 0 || tasks.length > 0) {
			lines.push("");
			lines.push(
				"Use SEND_TO_AGENT to unblock a running agent or assign it a new tracked task, LIST_AGENTS to inspect progress, STOP_AGENT to cancel, and FINALIZE_WORKSPACE when the work should be published or wrapped up.",
			);
		}

		const text = lines.join("\n");
		return {
			data: {
				activeWorkspaces: workspaces.map((ws: WorkspaceResult) => ({
					id: ws.id,
					label: ws.label,
					repo: ws.repo,
					branch: ws.branch,
					path: ws.path,
				})),
				activeSessions: sessions.map((session) => ({
					id: session.id,
					label:
						typeof session.metadata?.label === "string"
							? session.metadata.label
							: session.name,
					agentType: session.agentType,
					status: session.status,
					workdir: session.workdir,
				})),
				currentTasks: tasks,
				preferredTaskAgent: frameworkState.preferred,
				frameworks: frameworkState.frameworks,
			},
			values: { activeWorkspaceContext: text },
			text,
		};
	},
};
