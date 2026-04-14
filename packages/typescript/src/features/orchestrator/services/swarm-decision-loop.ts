/**
 * Swarm Coordinator — Decision Loop & Blocked/Turn-Complete Handlers
 *
 * Extracted from swarm-coordinator.ts for modularity.
 * All functions are pure async helpers that receive a SwarmCoordinatorContext
 * to access shared state and services.
 *
 * @module services/swarm-decision-loop
 */

import * as path from "node:path";
import { ModelType } from "@elizaos/core";
import { cleanForChat, extractCompletionSummary } from "./ansi-utils.ts";
import type {
	PendingDecision,
	SwarmCoordinatorContext,
	TaskContext,
} from "./swarm-coordinator.ts";
import {
	buildBlockedEventMessage,
	buildCoordinationPrompt,
	buildTurnCompletePrompt,
	type CoordinationLLMResponse,
	type DecisionHistoryEntry,
	parseCoordinationResponse,
	type SiblingTaskSummary,
	type TaskContextSummary,
} from "./swarm-coordinator-prompts.ts";
import { classifyEventTier, type TriageContext } from "./swarm-event-triage.ts";
import { validateTaskCompletion } from "./task-validation.ts";
import { runReadyTaskVerifiers } from "./task-verifier-runner.ts";
import { withTrajectoryContext } from "./trajectory-context.ts";

// ─── Constants ───

/** Timeout for agent decision pipeline callback (ms). */
const DECISION_CB_TIMEOUT_MS = 30_000;
const LOGIN_REQUIRED_PROMPT_RE =
	/\b(?:requires authentication|needs (?:a )?provider login|run\s+"?claude login"?|claude code requires authentication|login required|authenticate|sign in)\b/i;

/** Wrap a promise with a timeout. Rejects with an error if not resolved in time. */
function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms}ms`)),
			ms,
		);
		promise.then(
			(val) => {
				clearTimeout(timer);
				resolve(val);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** Maximum consecutive auto-responses before escalating to a human. */
const MAX_AUTO_RESPONSES = 10;

/**
 * Grace period after the coordinator sends input to an agent (ms).
 * During this window, stall and turn-complete events are suppressed
 * to give the agent time to process the input before re-assessment.
 */
export const POST_SEND_COOLDOWN_MS = 15_000;
const deferredTurnCompleteTimers = new Map<
	string,
	ReturnType<typeof setTimeout>
>();

/** Clear all deferred turn-complete timers (used during coordinator shutdown). */
export function clearDeferredTurnCompleteTimers(): void {
	for (const timer of deferredTurnCompleteTimers.values()) {
		clearTimeout(timer);
	}
	deferredTurnCompleteTimers.clear();
}

// ─── Helpers ───

/** Build a TaskContextSummary from a TaskContext. */
function toContextSummary(taskCtx: TaskContext): TaskContextSummary {
	return {
		sessionId: taskCtx.sessionId,
		agentType: taskCtx.agentType,
		label: taskCtx.label,
		originalTask: taskCtx.originalTask,
		workdir: taskCtx.workdir,
		repo: taskCtx.repo,
	};
}

/** Extract recent non-auto-resolved decisions as history entries. */
function toDecisionHistory(taskCtx: TaskContext): DecisionHistoryEntry[] {
	return taskCtx.decisions
		.filter((d) => d.decision !== "auto_resolved")
		.slice(-5)
		.map((d) => ({
			event: d.event,
			promptText: d.promptText,
			action: d.decision,
			response: d.response,
			reasoning: d.reasoning,
		}));
}

/** Collect sibling task summaries for cross-task context (excludes the current session). */
function collectSiblings(
	ctx: SwarmCoordinatorContext,
	currentSessionId: string,
): SiblingTaskSummary[] {
	const siblings: SiblingTaskSummary[] = [];
	for (const [sid, task] of ctx.tasks) {
		if (sid === currentSessionId) continue;

		// Find the most recent keyDecision from this sibling's decisions
		let lastKeyDecision: string | undefined;
		for (let i = task.decisions.length - 1; i >= 0; i--) {
			const d = task.decisions[i];
			if (d.reasoning && d.decision !== "auto_resolved") {
				lastKeyDecision = d.reasoning;
				break;
			}
		}

		// Also check shared decisions for this sibling's key decisions
		for (let i = ctx.sharedDecisions.length - 1; i >= 0; i--) {
			const sd = ctx.sharedDecisions[i];
			if (sd.agentLabel === task.label) {
				lastKeyDecision = sd.summary;
				break;
			}
		}

		siblings.push({
			label: task.label,
			agentType: task.agentType,
			originalTask: task.originalTask,
			status: task.status,
			lastKeyDecision,
			completionSummary: task.completionSummary,
		});
	}
	return siblings;
}

/**
 * Enrich a text response with any shared decisions the agent hasn't seen yet.
 * Returns the enriched response and the snapshot index to commit after send.
 * Short responses (like "y", "n", single-word approvals) are left untouched
 * to avoid confusing TUI prompts.
 */
function enrichWithSharedDecisions(
	ctx: SwarmCoordinatorContext,
	sessionId: string,
	response: string,
): { response: string; snapshotIndex?: number } {
	const taskCtx = ctx.tasks.get(sessionId);
	if (!taskCtx) return { response };

	const allDecisions = ctx.sharedDecisions;
	const lastSeen = taskCtx.lastSeenDecisionIndex;
	// Snapshot the current length so we don't skip decisions appended during send.
	const snapshotEnd = allDecisions.length;
	if (lastSeen >= snapshotEnd) return { response };

	// Don't inject context into short responses (approvals, single words)
	if (response.length < 20) {
		return { response };
	}

	const unseen = allDecisions.slice(lastSeen, snapshotEnd);

	const contextBlock = unseen
		.map((d) => `[${d.agentLabel}] ${d.summary}`)
		.join("; ");

	return {
		response: `${response}\n\n(Context from other agents: ${contextBlock})`,
		snapshotIndex: snapshotEnd,
	};
}

/** Advance the shared-decisions high-water mark for a session after a successful send. */
function commitSharedDecisionIndex(
	ctx: SwarmCoordinatorContext,
	sessionId: string,
	snapshotIndex: number,
): void {
	const taskCtx = ctx.tasks.get(sessionId);
	if (taskCtx) {
		taskCtx.lastSeenDecisionIndex = snapshotIndex;
	}
}

/** Record a key decision from an LLM response into the shared decisions list. */
function recordKeyDecision(
	ctx: SwarmCoordinatorContext,
	agentLabel: string,
	decision: CoordinationLLMResponse,
): void {
	if (!decision.keyDecision) return;
	ctx.sharedDecisions.push({
		agentLabel,
		summary: decision.keyDecision,
		timestamp: Date.now(),
	});
	ctx.log(`Shared decision from "${agentLabel}": ${decision.keyDecision}`);
}

/**
 * Drain a buffered task_complete event for a session after an in-flight
 * decision finishes. Prevents task_complete from being silently dropped
 * when it arrives during a slow handleBlocked/handleAutonomous LLM call.
 */
async function drainPendingTurnComplete(
	ctx: SwarmCoordinatorContext,
	sessionId: string,
): Promise<void> {
	if (!ctx.pendingTurnComplete.has(sessionId)) return;
	const pendingData = ctx.pendingTurnComplete.get(sessionId);
	ctx.pendingTurnComplete.delete(sessionId);

	const taskCtx = ctx.tasks.get(sessionId);
	if (
		!taskCtx ||
		(taskCtx.status !== "active" && taskCtx.status !== "tool_running")
	) {
		return;
	}

	ctx.log(`Draining buffered turn-complete for "${taskCtx.label}"`);
	await handleTurnComplete(ctx, sessionId, taskCtx, pendingData);
}

/**
 * Drain a buffered blocked event for a session after an in-flight
 * decision finishes. Prevents a distinct blocked prompt from being
 * silently dropped when it arrives during a slow LLM call.
 */
async function drainPendingBlocked(
	ctx: SwarmCoordinatorContext,
	sessionId: string,
): Promise<void> {
	if (!ctx.pendingBlocked.has(sessionId)) return;
	const pendingData = ctx.pendingBlocked.get(sessionId);
	ctx.pendingBlocked.delete(sessionId);

	const taskCtx = ctx.tasks.get(sessionId);
	// Mirror drainPendingTurnComplete: a buffered blocked event should still
	// drain if the task is in tool_running state (subagents using tools sit
	// there continuously). Without this, a blocked prompt that arrived during
	// an in-flight decision gets dropped silently when the lock releases.
	if (
		!taskCtx ||
		(taskCtx.status !== "active" && taskCtx.status !== "tool_running")
	) {
		return;
	}

	ctx.log(`Draining buffered blocked event for "${taskCtx.label}"`);
	await handleBlocked(ctx, sessionId, taskCtx, pendingData);
}

/** Format a decision's response for recording. */
function formatDecisionResponse(
	decision: CoordinationLLMResponse,
): string | undefined {
	if (decision.action !== "respond") return undefined;
	return decision.useKeys
		? `keys:${decision.keys?.join(",")}`
		: decision.response;
}

function truncateForUser(text: string, max = 140): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max)}...`;
}

function extractLoginInstructions(eventData: {
	promptInfo?: {
		instructions?: string;
		prompt?: string;
	};
}): string {
	const instructions =
		typeof eventData.promptInfo?.instructions === "string"
			? eventData.promptInfo.instructions.trim()
			: "";
	if (instructions) {
		return instructions;
	}
	return typeof eventData.promptInfo?.prompt === "string"
		? eventData.promptInfo.prompt.trim()
		: "";
}

function isLoginRequiredPrompt(
	promptText: string,
	promptType?: string,
): boolean {
	if (promptType === "login") {
		return true;
	}
	return LOGIN_REQUIRED_PROMPT_RE.test(promptText);
}

function formatSuggestedAction(
	decision: CoordinationLLMResponse | null,
): string {
	if (!decision) {
		return "Needs human review with no automatic suggestion.";
	}
	if (decision.action === "respond") {
		if (decision.useKeys && decision.keys?.length) {
			return `Suggested action: send keys ${decision.keys.join(", ")}.`;
		}
		if (decision.response?.trim()) {
			return `Suggested action: reply "${truncateForUser(decision.response, 80)}".`;
		}
	}
	return `Suggested action: ${decision.action}.`;
}

function decisionFromSuggestedResponse(
	suggestedResponse: string,
	reasoning = "Used adapter-provided auto-response for a routine blocking prompt.",
): CoordinationLLMResponse {
	if (suggestedResponse.startsWith("keys:")) {
		return {
			action: "respond",
			useKeys: true,
			keys: suggestedResponse
				.slice("keys:".length)
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean),
			reasoning,
		};
	}
	return {
		action: "respond",
		response: suggestedResponse,
		reasoning,
	};
}

function inferRoutinePromptResponse(
	promptText: string,
	promptType?: string,
): { suggestedResponse: string; reasoning: string } | null {
	if (
		promptType === "project_select" &&
		/project|workspace/i.test(promptText)
	) {
		return {
			suggestedResponse: "keys:enter",
			reasoning:
				"Accepted the current workspace so a routine project-selection prompt does not stall the task.",
		};
	}

	if (
		promptType === "config" &&
		/claude (?:dialog awaiting navigation|menu navigation required)/i.test(
			promptText,
		)
	) {
		return {
			suggestedResponse: "keys:enter",
			reasoning:
				"Accepted Claude's default dialog action so the replacement session can continue without exiting the CLI.",
		};
	}

	if (promptType && promptType !== "unknown") {
		return null;
	}

	if (
		/should i open (?:the )?(?:page|link|url).*(?:new tab|browser tab).*instead\??/i.test(
			promptText,
		)
	) {
		return {
			suggestedResponse: "yes",
			reasoning:
				"Accepted routine browser follow-up so the agent can keep using its web tool without human intervention.",
		};
	}

	if (
		/cheaper,\s*faster,\s*but less capable/i.test(promptText) &&
		/keep current model/i.test(promptText)
	) {
		return {
			suggestedResponse: "2",
			reasoning:
				"Kept the current Codex model so a routine model-selection prompt does not stall the task.",
		};
	}

	return null;
}

/** Check if a permission prompt references paths outside the workspace. */
export function isOutOfScopeAccess(
	promptText: string,
	workdir: string,
): boolean {
	// Strip URLs so we don't false-positive on https://example.com/foo/bar
	const stripped = promptText.replace(/https?:\/\/\S+/g, "");

	// Match absolute paths: multi-segment (/dir/file) or well-known single-segment
	// roots that agents should never touch (/etc, /tmp, /var, /usr, /opt, /sys, /proc).
	const multiSegment = /\/[\w.-]+(?:\/[\w.-]+)+/g;
	const sensitiveRoots = /\b\/(etc|tmp|var|usr|opt|sys|proc|root)\b/g;
	const homeTilde = /~\/[\w.-]+/g;

	const matches = [
		...(stripped.match(multiSegment) ?? []),
		...(stripped.match(sensitiveRoots) ?? []).map((m) => m.trimStart()),
		...(stripped.match(homeTilde) ?? []).map((m) =>
			m.replace("~", process.env.HOME ?? "/home/user"),
		),
	];
	if (matches.length === 0) return false;

	const resolvedWorkdir = path.resolve(workdir);
	return matches.some((p) => {
		const resolved = path.resolve(p);
		return (
			!resolved.startsWith(resolvedWorkdir + path.sep) &&
			resolved !== resolvedWorkdir
		);
	});
}

/**
 * Check if all registered tasks have reached a terminal state.
 * If so, send a swarm-wide summary message to the chat.
 */
export function checkAllTasksComplete(ctx: SwarmCoordinatorContext): void {
	void checkAllTasksCompleteAsync(ctx);
}

async function checkAllTasksCompleteAsync(
	ctx: SwarmCoordinatorContext,
): Promise<void> {
	const tasks = Array.from(ctx.tasks.values());
	if (tasks.length === 0) return;

	const terminalStates = new Set(["completed", "stopped", "error"]);
	const allDone = tasks.every((t) => terminalStates.has(t.status));

	if (!allDone) {
		const statuses = tasks.map((t) => `${t.label}=${t.status}`).join(", ");
		ctx.log(`checkAllTasksComplete: not all done yet — ${statuses}`);
		return;
	}

	const threadIds = [...new Set(tasks.map((task) => task.threadId))];
	const failingThreads: Array<{
		threadId: string;
		failedGoals: string[];
		failedVerifiers: string[];
	}> = [];
	for (const threadId of threadIds) {
		await runReadyTaskVerifiers(ctx.runtime, ctx.taskRegistry, threadId);
		const thread = await ctx.taskRegistry.getThread(threadId);
		if (!thread || thread.nodes.length === 0) {
			continue;
		}
		const goalNodes = thread.nodes.filter((node) => node.kind === "goal");
		const failedGoals = goalNodes
			.filter(
				(node) =>
					node.status === "failed" ||
					node.status === "canceled" ||
					node.status === "interrupted",
			)
			.map((node) => `${node.title}=${node.status}`);
		const incompleteGoals = goalNodes
			.filter(
				(node) =>
					node.status !== "completed" &&
					node.status !== "failed" &&
					node.status !== "canceled" &&
					node.status !== "interrupted",
			)
			.map((node) => `${node.title}=${node.status}`);
		if (incompleteGoals.length > 0) {
			const pendingGoals = goalNodes
				.filter((node) => node.status !== "completed")
				.map((node) => `${node.title}=${node.status}`)
				.join(", ");
			ctx.log(
				`checkAllTasksComplete: thread ${threadId} still has non-terminal goal nodes — ${pendingGoals}`,
			);
			return;
		}
		const runningVerifiers = thread.verifierJobs.filter(
			(job) => job.status === "running",
		);
		if (runningVerifiers.length > 0) {
			ctx.log(
				`checkAllTasksComplete: thread ${threadId} still has running verifier jobs`,
			);
			return;
		}
		const pendingVerifiers = thread.verifierJobs.filter(
			(job) => job.status === "pending",
		);
		if (pendingVerifiers.length > 0) {
			ctx.log(
				`checkAllTasksComplete: thread ${threadId} still has pending verifier jobs`,
			);
			return;
		}
		const failedVerifiers = thread.verifierJobs
			.filter((job) => job.status === "failed")
			.map((job) => `${job.title}=failed`);
		if (failedGoals.length > 0 || failedVerifiers.length > 0) {
			failingThreads.push({
				threadId,
				failedGoals,
				failedVerifiers,
			});
		}
	}

	if (failingThreads.length > 0) {
		if (ctx.swarmCompleteNotified) {
			ctx.log(
				"checkAllTasksComplete: failure notification already sent — skipping",
			);
			return;
		}
		ctx.swarmCompleteNotified = true;
		const summary = failingThreads
			.map((thread) =>
				[
					`thread ${thread.threadId}`,
					thread.failedGoals.length > 0
						? `failed goals: ${thread.failedGoals.join(", ")}`
						: "",
					thread.failedVerifiers.length > 0
						? `failed verifiers: ${thread.failedVerifiers.join(", ")}`
						: "",
				]
					.filter(Boolean)
					.join(" | "),
			)
			.join("; ");
		ctx.log(
			`checkAllTasksComplete: sessions are terminal but acceptance failed — ${summary}`,
		);
		ctx.broadcast({
			type: "swarm_attention_required",
			sessionId: "",
			timestamp: Date.now(),
			data: {
				summary,
				threads: failingThreads,
			},
		});
		ctx.sendChatMessage(
			`Task agents finished running, but the coordinator could not prove completion. ${summary}`,
			"task-agent",
		);
		return;
	}

	// Guard: only fire once per swarm (reset by coordinator on stop/new swarm)
	if (ctx.swarmCompleteNotified) {
		ctx.log("checkAllTasksComplete: already notified — skipping");
		return;
	}
	ctx.swarmCompleteNotified = true;

	const completed = tasks.filter((t) => t.status === "completed");
	const stopped = tasks.filter((t) => t.status === "stopped");
	const errored = tasks.filter((t) => t.status === "error");

	const parts: string[] = [];
	if (completed.length > 0) {
		parts.push(`${completed.length} completed`);
	}
	if (stopped.length > 0) {
		parts.push(`${stopped.length} stopped`);
	}
	if (errored.length > 0) {
		parts.push(`${errored.length} errored`);
	}

	ctx.log(
		`checkAllTasksComplete: all ${tasks.length} tasks terminal (${parts.join(", ")}) — firing swarm_complete`,
	);

	ctx.broadcast({
		type: "swarm_complete",
		sessionId: "",
		timestamp: Date.now(),
		data: {
			total: tasks.length,
			completed: completed.length,
			stopped: stopped.length,
			errored: errored.length,
		},
	});

	// Fire swarm complete callback for synthesis — if wired, the host
	// (milaidy) will use this to generate a synthesized overview.
	const swarmCompleteCb = ctx.getSwarmCompleteCallback();
	const sendFallbackSummary = () => {
		ctx.sendChatMessage(
			`All ${tasks.length} task agents finished (${parts.join(", ")}). Review their work when you're ready.`,
			"task-agent",
		);
	};

	if (swarmCompleteCb) {
		ctx.log(
			"checkAllTasksComplete: swarm complete callback is wired — calling synthesis",
		);
		const taskSummaries = tasks.map((t) => {
			// Fold in shared decisions relevant to this task so the synthesis
			// prompt includes the agent's actual findings, not just PR URLs.
			const decisions = ctx.sharedDecisions
				.filter((sd) => sd.agentLabel === t.label)
				.map((sd) => sd.summary);
			const summaryParts: string[] = [];
			if (decisions.length > 0) summaryParts.push(decisions.join("; "));
			if (t.completionSummary) summaryParts.push(t.completionSummary);
			return {
				sessionId: t.sessionId,
				label: t.label,
				agentType: t.agentType,
				originalTask: t.originalTask,
				status: t.status,
				completionSummary: summaryParts.join("\n") || "",
			};
		});
		// Wrap in Promise.resolve().then() to catch sync throws, and race against
		// a timeout to guard against callbacks that never settle.
		void withTimeout(
			Promise.resolve().then(() =>
				swarmCompleteCb({
					tasks: taskSummaries,
					total: tasks.length,
					completed: completed.length,
					stopped: stopped.length,
					errored: errored.length,
				}),
			),
			DECISION_CB_TIMEOUT_MS,
			"swarmCompleteCb",
		).catch((err) => {
			ctx.log(
				`Swarm complete callback failed: ${err} — falling back to generic summary`,
			);
			sendFallbackSummary();
		});
	} else {
		ctx.log(
			"checkAllTasksComplete: no synthesis callback — sending generic message",
		);
		sendFallbackSummary();
	}
}

/** Fetch recent PTY output, returning empty string on failure. */
async function fetchRecentOutput(
	ctx: SwarmCoordinatorContext,
	sessionId: string,
	lines = 50,
): Promise<string> {
	if (!ctx.ptyService) return "";
	try {
		return await ctx.ptyService.getSessionOutput(sessionId, lines);
	} catch {
		return "";
	}
}

// ─── LLM Decision ───

/**
 * Ask the LLM to make a coordination decision about a blocked agent.
 */
export async function makeCoordinationDecision(
	ctx: SwarmCoordinatorContext,
	taskCtx: TaskContext,
	promptText: string,
	recentOutput: string,
): Promise<CoordinationLLMResponse | null> {
	const prompt = buildCoordinationPrompt(
		toContextSummary(taskCtx),
		promptText,
		recentOutput,
		toDecisionHistory(taskCtx),
		collectSiblings(ctx, taskCtx.sessionId),
		ctx.sharedDecisions,
		ctx.getSwarmContext(),
	);

	try {
		const result = await withTrajectoryContext(
			ctx.runtime,
			{
				source: "orchestrator",
				decisionType: "coordination",
				sessionId: taskCtx.sessionId,
				taskLabel: taskCtx.label,
				repo: taskCtx.repo,
				workdir: taskCtx.workdir,
				originalTask: taskCtx.originalTask,
			},
			() => ctx.runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
		);
		return parseCoordinationResponse(result);
	} catch (err) {
		ctx.log(`LLM coordination call failed: ${err}`);
		return null;
	}
}

/**
 * Execute a coordination decision — send response, complete session, escalate, or ignore.
 */
export async function executeDecision(
	ctx: SwarmCoordinatorContext,
	sessionId: string,
	decision: CoordinationLLMResponse,
): Promise<void> {
	if (!ctx.ptyService) return;

	switch (decision.action) {
		case "respond": {
			const taskCtx = ctx.tasks.get(sessionId);
			if (taskCtx) {
				taskCtx.status = "active";
			}
			if (decision.useKeys && decision.keys) {
				await ctx.ptyService.sendKeysToSession(sessionId, decision.keys);
			} else if (decision.response !== undefined) {
				// Proactive injection: append unseen shared decisions to text responses
				const { response: enriched, snapshotIndex } = enrichWithSharedDecisions(
					ctx,
					sessionId,
					decision.response,
				);
				await ctx.ptyService.sendToSession(sessionId, enriched);
				// Only advance the high-water mark after send succeeds — if the send
				// fails, the decisions will be retried on the next enrichment.
				if (snapshotIndex !== undefined) {
					commitSharedDecisionIndex(ctx, sessionId, snapshotIndex);
				}
			}
			// Mark the send time so stall/turn-complete events are suppressed
			// during the grace period while the agent processes this input.
			if (taskCtx) {
				taskCtx.lastInputSentAt = Date.now();
				await ctx.syncTaskContext(taskCtx);
			}
			break;
		}

		case "complete": {
			const taskCtx = ctx.tasks.get(sessionId);

			// Extract meaningful artifacts (PR URLs, commits) instead of
			// dumping raw terminal output which is full of TUI noise.
			let summary = "";
			try {
				const rawOutput = await ctx.ptyService.getSessionOutput(sessionId, 50);
				summary = extractCompletionSummary(rawOutput);
			} catch {
				/* ignore */
			}

			if (!taskCtx) {
				ctx.broadcast({
					type: "task_complete",
					sessionId,
					timestamp: Date.now(),
					data: { reasoning: decision.reasoning },
				});
				ctx.ptyService.stopSession(sessionId, /* force */ true).catch((err) => {
					ctx.log(
						`Failed to stop session after LLM-detected completion: ${err}`,
					);
				});
				break;
			}

			taskCtx.completionSummary = summary || decision.reasoning || "";
			taskCtx.status = "tool_running";
			await Promise.all([
				ctx.syncTaskContext(taskCtx),
				ctx.taskRegistry.appendEvent({
					threadId: taskCtx.threadId,
					sessionId,
					eventType: "validation_started",
					summary: `Validation started for "${taskCtx.label}"`,
					data: {
						completionReasoning: decision.reasoning,
						completionSummary: taskCtx.completionSummary,
					},
				}),
			]);
			ctx.broadcast({
				type: "tool_running",
				sessionId,
				timestamp: Date.now(),
				data: {
					description: "validation",
				},
			});

			const verifierJob = taskCtx.taskNodeId
				? await ctx.taskRegistry.createTaskVerifierJob({
						threadId: taskCtx.threadId,
						nodeId: taskCtx.taskNodeId,
						status: "running",
						verifierType: "task_completion",
						title: `Validate ${taskCtx.label}`,
						instructions: [
							`Task: ${taskCtx.originalTask}`,
							taskCtx.completionSummary
								? `Completion summary: ${taskCtx.completionSummary}`
								: "",
							decision.reasoning ? `Reasoning: ${decision.reasoning}` : "",
						]
							.filter(Boolean)
							.join("\n"),
						config: {
							sessionId,
							agentType: taskCtx.agentType,
						},
						metadata: {
							source: "swarm-decision-loop",
						},
						startedAt: new Date().toISOString(),
					})
				: null;

			const validation = await validateTaskCompletion(ctx, {
				sessionId,
				taskCtx,
				completionReasoning: decision.reasoning,
				completionSummary: taskCtx.completionSummary,
				turnOutput: taskCtx.completionSummary,
			}).catch(
				(err) =>
					({
						verdict: "escalate" as const,
						summary:
							err instanceof Error
								? `Validation failed: ${err.message}`
								: `Validation failed: ${String(err)}`,
						followUpPrompt: undefined,
						reportPath: "",
						artifacts: [],
					}) satisfies Awaited<ReturnType<typeof validateTaskCompletion>>,
			);

			for (const artifact of validation.artifacts) {
				await ctx.taskRegistry.recordArtifact({
					threadId: taskCtx.threadId,
					sessionId,
					artifactType: artifact.artifactType,
					title: artifact.title,
					path: artifact.path ?? null,
					uri: artifact.uri ?? null,
					mimeType: artifact.mimeType ?? null,
					metadata: artifact.metadata ?? {},
				});
				if (taskCtx.taskNodeId && verifierJob) {
					await ctx.taskRegistry.recordTaskEvidence({
						threadId: taskCtx.threadId,
						nodeId: taskCtx.taskNodeId,
						sessionId,
						verifierJobId: verifierJob.id,
						evidenceType: artifact.artifactType,
						title: artifact.title,
						summary: validation.summary,
						path: artifact.path ?? null,
						uri: artifact.uri ?? null,
						content:
							artifact.metadata &&
							typeof artifact.metadata === "object" &&
							!Array.isArray(artifact.metadata)
								? (artifact.metadata as Record<string, unknown>)
								: {},
						metadata: {
							mimeType: artifact.mimeType ?? null,
						},
					});
				}
			}

			if (validation.verdict !== "pass") {
				const followUpPrompt =
					validation.followUpPrompt?.trim() ||
					`Validation found the task incomplete. Continue working until this is resolved:\n\n${validation.summary}`;
				const nextStatus =
					validation.verdict === "escalate" ? "blocked" : "active";
				taskCtx.status = nextStatus;
				await Promise.all([
					ctx.syncTaskContext(taskCtx),
					verifierJob
						? ctx.taskRegistry.updateTaskVerifierJob(verifierJob.id, {
								status: "failed",
								completedAt: new Date().toISOString(),
								metadata: {
									verdict: validation.verdict,
									summary: validation.summary,
								},
							})
						: Promise.resolve(),
					taskCtx.taskNodeId && verifierJob
						? ctx.taskRegistry.recordTaskEvidence({
								threadId: taskCtx.threadId,
								nodeId: taskCtx.taskNodeId,
								sessionId,
								verifierJobId: verifierJob.id,
								evidenceType: "validation_summary",
								title: `Validation ${validation.verdict} for ${taskCtx.label}`,
								summary: validation.summary,
								content: {
									followUpPrompt:
										validation.verdict === "revise" ? followUpPrompt : null,
									reportPath: validation.reportPath || null,
									verdict: validation.verdict,
								},
								metadata: {
									source: "task-validation",
								},
							})
						: Promise.resolve(),
					ctx.taskRegistry.appendEvent({
						threadId: taskCtx.threadId,
						sessionId,
						eventType: "validation_failed",
						summary: `Validation did not approve "${taskCtx.label}"`,
						data: {
							verdict: validation.verdict,
							summary: validation.summary,
							followUpPrompt:
								validation.verdict === "revise" ? followUpPrompt : null,
							reportPath: validation.reportPath || null,
						},
					}),
				]);

				if (validation.verdict === "revise") {
					await ctx.ptyService.sendToSession(sessionId, followUpPrompt);
					taskCtx.lastInputSentAt = Date.now();
					await ctx.syncTaskContext(taskCtx);
					ctx.sendChatMessage(
						`[${taskCtx.label}] Validation asked the agent to continue: ${validation.summary}`,
						"coding-agent",
					);
				} else {
					ctx.broadcast({
						type: "escalation",
						sessionId,
						timestamp: Date.now(),
						data: {
							reason: "validation_escalation",
							summary: validation.summary,
						},
					});
					ctx.sendChatMessage(
						`[${taskCtx.label}] Validation needs human review: ${validation.summary}`,
						"coding-agent",
					);
				}
				break;
			}

			taskCtx.status = "completed";
			await Promise.all([
				ctx.syncTaskContext(taskCtx),
				verifierJob
					? ctx.taskRegistry.updateTaskVerifierJob(verifierJob.id, {
							status: "passed",
							completedAt: new Date().toISOString(),
							metadata: {
								summary: validation.summary,
								reportPath: validation.reportPath || null,
							},
						})
					: Promise.resolve(),
				taskCtx.taskNodeId && verifierJob
					? ctx.taskRegistry.recordTaskEvidence({
							threadId: taskCtx.threadId,
							nodeId: taskCtx.taskNodeId,
							sessionId,
							verifierJobId: verifierJob.id,
							evidenceType: "validation_summary",
							title: `Validation passed for ${taskCtx.label}`,
							summary: validation.summary,
							content: {
								completionSummary: taskCtx.completionSummary,
								reportPath: validation.reportPath || null,
							},
							metadata: {
								source: "task-validation",
							},
						})
					: Promise.resolve(),
				ctx.taskRegistry.updateThreadSummary(
					taskCtx.threadId,
					taskCtx.completionSummary,
				),
				ctx.taskRegistry.appendEvent({
					threadId: taskCtx.threadId,
					sessionId,
					eventType: "validation_passed",
					summary: `Validation passed for "${taskCtx.label}"`,
					data: {
						summary: validation.summary,
						reportPath: validation.reportPath || null,
					},
				}),
				ctx.taskRegistry.appendEvent({
					threadId: taskCtx.threadId,
					sessionId,
					eventType: "task_status_changed",
					summary: `Task "${taskCtx.label}" completed`,
					data: {
						status: "completed",
						completionSummary: taskCtx.completionSummary,
						validationSummary: validation.summary,
					},
				}),
			]);

			// Log to persistent history (non-blocking but observed)
			(ctx as { history?: { append: (e: unknown) => Promise<void> } }).history
				?.append({
					timestamp: Date.now(),
					type: "task_completed",
					sessionId,
					label: taskCtx.label,
					agentType: taskCtx.agentType,
					repo: taskCtx.repo,
					workdir: taskCtx.workdir,
					completionSummary: taskCtx.completionSummary,
					validationSummary: validation.summary,
				})
				.catch((err) => {
					ctx.log(
						`Failed to persist task completion for "${taskCtx.label}" (${sessionId}): ${err}`,
					);
				});

			ctx.broadcast({
				type: "task_complete",
				sessionId,
				timestamp: Date.now(),
				data: {
					reasoning: decision.reasoning,
					validationSummary: validation.summary,
				},
			});

			ctx.sendChatMessage(
				taskCtx.completionSummary
					? `Finished "${taskCtx.label}".\n\n${taskCtx.completionSummary}`
					: `Finished "${taskCtx.label}".`,
				"coding-agent",
			);

			// Force-kill the session — task is done, nothing to save.
			// SIGKILL ensures the PTY and all child processes exit immediately,
			// preventing orphaned workspace processes.
			ctx.ptyService.stopSession(sessionId, /* force */ true).catch((err) => {
				ctx.log(`Failed to stop session after LLM-detected completion: ${err}`);
			});

			// Check if all tasks are now done — send a swarm-wide summary if so
			checkAllTasksComplete(ctx);
			break;
		}

		case "escalate":
			ctx.broadcast({
				type: "escalation",
				sessionId,
				timestamp: Date.now(),
				data: {
					reasoning: decision.reasoning,
				},
			});
			break;

		case "ignore":
			// No action needed
			break;
	}
}

// ─── Event Handlers ───

/**
 * Handle a "blocked" session event — auto-resolved, escalated, or routed to decision loop.
 */
export async function handleBlocked(
	ctx: SwarmCoordinatorContext,
	sessionId: string,
	taskCtx: TaskContext,
	data: unknown,
): Promise<void> {
	// Event data from pty-init: { promptInfo: BlockingPromptInfo, autoResponded: boolean }
	const eventData = data as {
		promptInfo?: {
			type?: string;
			prompt?: string;
			canAutoRespond?: boolean;
			suggestedResponse?: string;
			instructions?: string;
			url?: string;
		};
		autoResponded?: boolean;
	};

	// Extract prompt text from promptInfo (the actual blocking prompt info object)
	const promptText =
		eventData.promptInfo?.prompt ?? eventData.promptInfo?.instructions ?? "";

	if (isLoginRequiredPrompt(promptText, eventData.promptInfo?.type)) {
		const instructions = extractLoginInstructions(eventData);
		const url =
			typeof eventData.promptInfo?.url === "string" &&
			eventData.promptInfo.url.trim().length > 0
				? eventData.promptInfo.url.trim()
				: null;

		taskCtx.status = "blocked";
		await ctx.syncTaskContext(taskCtx);
		await ctx.recordDecision(taskCtx, {
			timestamp: Date.now(),
			event: "blocked",
			promptText,
			decision: "escalate",
			reasoning:
				"Provider login is required before the task agent can continue.",
		});
		await ctx.taskRegistry.appendEvent({
			threadId: taskCtx.threadId,
			sessionId,
			eventType: "task_status_changed",
			summary: `Task "${taskCtx.label}" is waiting for login`,
			data: {
				status: "blocked",
				reason: "login_required",
				instructions: instructions || null,
				url,
				promptType: eventData.promptInfo?.type ?? null,
			},
		});
		ctx.broadcast({
			type: "login_required",
			sessionId,
			timestamp: Date.now(),
			data: {
				instructions: instructions || null,
				url,
				prompt: promptText,
				promptType: eventData.promptInfo?.type,
			},
		});
		const loginParts = [
			`"${taskCtx.label}" needs a provider login before it can continue.`,
			instructions || "",
			url ? `Login link: ${url}` : "",
		].filter(Boolean);
		ctx.sendChatMessage(loginParts.join(" "), "coding-agent");
		return;
	}

	// Auto-responded by rules — log and broadcast, no LLM needed
	if (eventData.autoResponded) {
		// Safety: check if the auto-approved prompt accessed out-of-scope paths.
		// The approval already happened in pty-manager, but we can stop the session
		// and alert the user to prevent further damage.
		if (isOutOfScopeAccess(promptText, taskCtx.workdir)) {
			taskCtx.status = "error";
			await ctx.recordDecision(taskCtx, {
				timestamp: Date.now(),
				event: "blocked",
				promptText,
				decision: "escalate",
				reasoning: `SECURITY: Auto-response approved access outside workspace (${taskCtx.workdir}). Session stopped.`,
			});

			ctx.broadcast({
				type: "escalation",
				sessionId,
				timestamp: Date.now(),
				data: {
					prompt: promptText,
					reason: "out_of_scope_auto_approved",
					workdir: taskCtx.workdir,
				},
			});

			ctx.sendChatMessage(
				`[${taskCtx.label}] WARNING: Auto-approved access to path outside workspace (${taskCtx.workdir}). ` +
					`Prompt: "${promptText.slice(0, 150)}". Stopping session for safety.`,
				"coding-agent",
			);

			// Force-kill the session to prevent further out-of-scope access
			ctx.ptyService?.stopSession(sessionId, /* force */ true).catch((err) => {
				ctx.log(
					`Failed to stop session after out-of-scope auto-approval: ${err}`,
				);
			});
			return;
		}

		taskCtx.autoResolvedCount++;
		await ctx.recordDecision(taskCtx, {
			timestamp: Date.now(),
			event: "blocked",
			promptText,
			decision: "auto_resolved",
			reasoning: "Handled by auto-response rules",
		});

		ctx.broadcast({
			type: "blocked_auto_resolved",
			sessionId,
			timestamp: Date.now(),
			data: {
				prompt: promptText,
				promptType: eventData.promptInfo?.type,
				autoResolvedCount: taskCtx.autoResolvedCount,
			},
		});

		// Log auto-approvals server-side only — don't persist to chat.
		const count = taskCtx.autoResolvedCount;
		if (count <= 2 || count % 5 === 0) {
			const excerpt =
				promptText.length > 120 ? `${promptText.slice(0, 120)}...` : promptText;
			ctx.log(`[${taskCtx.label}] Approved: ${excerpt}`);
		}
		return;
	}

	const adapterSuggestedResponse =
		typeof eventData.promptInfo?.suggestedResponse === "string" &&
		eventData.promptInfo.suggestedResponse.trim().length > 0
			? eventData.promptInfo.suggestedResponse.trim()
			: eventData.promptInfo?.canAutoRespond &&
					eventData.promptInfo?.type === "permission"
				? "keys:enter"
				: undefined;
	const inferredPromptResponse = inferRoutinePromptResponse(
		promptText,
		eventData.promptInfo?.type,
	);
	const routineSuggestedResponse =
		adapterSuggestedResponse ?? inferredPromptResponse?.suggestedResponse;

	if (
		ctx.getSupervisionLevel() === "autonomous" &&
		(eventData.promptInfo?.canAutoRespond || inferredPromptResponse) &&
		routineSuggestedResponse
	) {
		const fastDecision = decisionFromSuggestedResponse(
			routineSuggestedResponse,
			inferredPromptResponse?.reasoning,
		);

		taskCtx.autoResolvedCount++;
		await ctx.recordDecision(taskCtx, {
			timestamp: Date.now(),
			event: "blocked",
			promptText,
			decision: "auto_resolved",
			response: formatDecisionResponse(fastDecision),
			reasoning: fastDecision.reasoning,
		});

		ctx.broadcast({
			type: "blocked_auto_resolved",
			sessionId,
			timestamp: Date.now(),
			data: {
				prompt: promptText,
				promptType: eventData.promptInfo?.type,
				autoResolvedCount: taskCtx.autoResolvedCount,
				strategy: "adapter_suggested_response",
			},
		});

		await executeDecision(ctx, sessionId, fastDecision);
		return;
	}

	// Deduplicate: if an LLM decision is already in-flight for this session
	// AND the prompt text matches the one already being handled, skip.
	// TUI re-renders fire the same prompt many times; a *different* prompt
	// (theoretically possible if the agent resolves one prompt and immediately
	// hits another) should not be dropped.
	const promptFingerprint = promptText.slice(0, 200);
	if (ctx.inFlightDecisions.has(sessionId)) {
		if (ctx.lastBlockedPromptFingerprint.get(sessionId) === promptFingerprint) {
			ctx.log(
				`Skipping duplicate blocked event for ${taskCtx.label} (decision in-flight, same prompt)`,
			);
			return;
		}
		// Different prompt — buffer it so it's replayed after the current decision completes.
		ctx.log(
			`New blocked prompt for ${taskCtx.label} while decision in-flight — buffering`,
		);
		ctx.pendingBlocked.set(sessionId, data);
		ctx.lastBlockedPromptFingerprint.set(sessionId, promptFingerprint);
		return;
	}
	ctx.lastBlockedPromptFingerprint.set(sessionId, promptFingerprint);
	taskCtx.status = "blocked";
	await ctx.syncTaskContext(taskCtx);

	// Broadcast that the agent is blocked (for all supervision levels)
	ctx.broadcast({
		type: "blocked",
		sessionId,
		timestamp: Date.now(),
		data: {
			prompt: promptText,
			promptType: eventData.promptInfo?.type,
			supervisionLevel: ctx.getSupervisionLevel(),
		},
	});

	// Safety check: escalate after too many consecutive auto-responses
	if (taskCtx.autoResolvedCount >= MAX_AUTO_RESPONSES) {
		await ctx.recordDecision(taskCtx, {
			timestamp: Date.now(),
			event: "blocked",
			promptText,
			decision: "escalate",
			reasoning: `Escalating after ${MAX_AUTO_RESPONSES} consecutive auto-responses`,
		});
		ctx.broadcast({
			type: "escalation",
			sessionId,
			timestamp: Date.now(),
			data: {
				prompt: promptText,
				reason: "max_auto_responses_exceeded",
			},
		});
		ctx.sendChatMessage(
			`[${taskCtx.label}] Paused for your attention after ${MAX_AUTO_RESPONSES} consecutive automatic approvals. Prompt: ${truncateForUser(promptText, 180)}`,
			"coding-agent",
		);
		return;
	}

	// Route based on supervision level
	switch (ctx.getSupervisionLevel()) {
		case "autonomous":
			await handleAutonomousDecision(
				ctx,
				sessionId,
				taskCtx,
				promptText,
				"",
				eventData.promptInfo?.type,
			);
			break;

		case "confirm":
			await handleConfirmDecision(
				ctx,
				sessionId,
				taskCtx,
				promptText,
				"",
				eventData.promptInfo?.type,
			);
			break;

		case "notify":
			// Notify mode — broadcast only, no action
			await ctx.recordDecision(taskCtx, {
				timestamp: Date.now(),
				event: "blocked",
				promptText,
				decision: "escalate",
				reasoning: "Supervision level is notify — broadcasting only",
			});
			ctx.sendChatMessage(
				`[${taskCtx.label}] Waiting on a blocked prompt: ${truncateForUser(promptText, 180)}`,
				"coding-agent",
			);
			break;
	}
}

// ─── Turn Completion Assessment ───

/**
 * Handle a turn completion event. Instead of immediately stopping the session,
 * ask the LLM whether the overall task is done or the agent needs more turns.
 */
export async function handleTurnComplete(
	ctx: SwarmCoordinatorContext,
	sessionId: string,
	taskCtx: TaskContext,
	data: unknown,
): Promise<void> {
	// Accept both "active" and "tool_running" — subagents using tools sit in
	// tool_running almost continuously, and we still want to run validation
	// when they hit task_complete. Only bail on truly terminal/blocked states.
	if (taskCtx.status !== "active" && taskCtx.status !== "tool_running") {
		return;
	}

	// If another decision (e.g. handleBlocked) is running for this session,
	// buffer the task_complete event so it's processed when the lock releases.
	// Without this, task_complete events are silently lost and sessions hang.
	if (ctx.inFlightDecisions.has(sessionId)) {
		ctx.log(
			`Buffering turn-complete for ${sessionId} (in-flight decision running)`,
		);
		ctx.pendingTurnComplete.set(sessionId, data);
		return;
	}

	// Suppress turn-complete events during the post-send cooldown period.
	// After the coordinator sends input, the agent needs time to process it.
	// Without this, stall-classified "task_complete" events from stale output
	// trigger cascading follow-ups before the agent starts responding.
	if (taskCtx.lastInputSentAt) {
		const elapsed = Date.now() - taskCtx.lastInputSentAt;
		if (elapsed < POST_SEND_COOLDOWN_MS) {
			ctx.pendingTurnComplete.set(sessionId, data);
			if (!deferredTurnCompleteTimers.has(sessionId)) {
				const delayMs = POST_SEND_COOLDOWN_MS - elapsed + 50;
				const timer = setTimeout(() => {
					deferredTurnCompleteTimers.delete(sessionId);
					const pendingData = ctx.pendingTurnComplete.get(sessionId);
					if (!pendingData) return;
					const currentTask = ctx.tasks.get(sessionId);
					if (
						!currentTask ||
						(currentTask.status !== "active" &&
							currentTask.status !== "tool_running")
					) {
						ctx.pendingTurnComplete.delete(sessionId);
						return;
					}
					void handleTurnComplete(
						ctx,
						sessionId,
						currentTask,
						pendingData,
					).catch((err) => {
						ctx.log(
							`Deferred turn-complete replay failed for ${sessionId}: ${err}`,
						);
					});
				}, delayMs);
				deferredTurnCompleteTimers.set(sessionId, timer);
			}
			ctx.log(
				`Suppressing turn-complete for "${taskCtx.label}" — ` +
					`${Math.round(elapsed / 1000)}s since last input (cooldown ${POST_SEND_COOLDOWN_MS / 1000}s)`,
			);
			return;
		}
	}

	const deferredTimer = deferredTurnCompleteTimers.get(sessionId);
	if (deferredTimer) {
		clearTimeout(deferredTimer);
		deferredTurnCompleteTimers.delete(sessionId);
	}
	ctx.pendingTurnComplete.delete(sessionId);

	ctx.inFlightDecisions.add(sessionId);
	try {
		ctx.log(
			`Turn complete for "${taskCtx.label}" — assessing whether task is done`,
		);

		// Get the turn output — prefer the captured response, fall back to PTY output
		const rawResponse = (data as { response?: string }).response ?? "";
		let turnOutput = cleanForChat(rawResponse);
		if (!turnOutput) {
			const raw = await fetchRecentOutput(ctx, sessionId);
			turnOutput = cleanForChat(raw);
		}

		// Fast-path: if the turn output contains a PR URL or "Created pull request",
		// the task is done — skip the LLM assessment entirely. The LLM (especially
		// Gemini Flash) tends to ignore "do not verify" instructions and sends
		// unnecessary verification follow-ups, adding 2-5 extra rounds per agent.
		// Only match explicit PR creation signals — not references to existing PRs.
		const PR_CREATED_RE =
			/(?:Created|Opened)\s+pull\s+request\s+#?\d+|gh\s+pr\s+create/i;
		if (PR_CREATED_RE.test(turnOutput)) {
			const fastDecision: CoordinationLLMResponse = {
				action: "complete",
				reasoning: "PR detected in turn output — task complete.",
			};
			ctx.log(
				`Turn assessment for "${taskCtx.label}": complete (fast-path: PR detected in output)`,
			);
			await ctx.recordDecision(taskCtx, {
				timestamp: Date.now(),
				event: "turn_complete",
				promptText: "Agent finished a turn",
				decision: "complete",
				response: "",
				reasoning: fastDecision.reasoning,
			});
			recordKeyDecision(ctx, taskCtx.label, fastDecision);
			ctx.broadcast({
				type: "turn_assessment",
				sessionId,
				timestamp: Date.now(),
				data: { action: "complete", reasoning: fastDecision.reasoning },
			});
			await executeDecision(ctx, sessionId, fastDecision);
			return;
		}

		// Turn completions always use the fast small-LLM path.
		// The assessment is a structured complete/continue/escalate decision
		// that doesn't benefit from the full Milaidy pipeline, and routing
		// through it risks hangs that block the inFlightDecisions lock.
		let decision: CoordinationLLMResponse | null = null;
		const decisionFromPipeline = false;

		const prompt = buildTurnCompletePrompt(
			toContextSummary(taskCtx),
			turnOutput,
			toDecisionHistory(taskCtx),
			collectSiblings(ctx, sessionId),
			ctx.sharedDecisions,
			ctx.getSwarmContext(),
		);
		try {
			const result = await withTrajectoryContext(
				ctx.runtime,
				{
					source: "orchestrator",
					decisionType: "turn-complete",
					sessionId,
					taskLabel: taskCtx.label,
					repo: taskCtx.repo,
					workdir: taskCtx.workdir,
					originalTask: taskCtx.originalTask,
				},
				() => ctx.runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
			);
			decision = parseCoordinationResponse(result);
		} catch (err) {
			ctx.log(`Turn-complete LLM call failed: ${err}`);
		}

		if (!decision) {
			// Both paths failed — escalate so a human can decide rather than
			// prematurely completing unfinished work on a transient LLM failure.
			ctx.log(
				`Turn-complete for "${taskCtx.label}": all decision paths failed — escalating`,
			);
			decision = {
				action: "escalate",
				reasoning:
					"All decision paths returned invalid response — escalating for human review",
			};
		}

		// Log the decision
		ctx.log(
			`Turn assessment for "${taskCtx.label}": ${decision.action}${
				decision.action === "respond"
					? ` → "${(decision.response ?? "").slice(0, 80)}"`
					: ""
			} — ${decision.reasoning.slice(0, 120)}`,
		);

		// Record
		await ctx.recordDecision(taskCtx, {
			timestamp: Date.now(),
			event: "turn_complete",
			promptText: "Agent finished a turn",
			decision: decision.action,
			response: formatDecisionResponse(decision),
			reasoning: decision.reasoning,
		});

		// Layer 2: capture significant decisions for cross-agent sharing
		recordKeyDecision(ctx, taskCtx.label, decision);

		ctx.broadcast({
			type: "turn_assessment",
			sessionId,
			timestamp: Date.now(),
			data: {
				action: decision.action,
				reasoning: decision.reasoning,
			},
		});

		if (ctx.pendingBlocked.has(sessionId)) {
			ctx.log(
				`Deferring turn assessment execution for "${taskCtx.label}" because a newer blocked prompt arrived during assessment`,
			);
			ctx.pendingTurnComplete.set(sessionId, data);
			return;
		}

		// Send chat message for small-LLM decisions only.
		// When Milaidy's pipeline handled it, she already spoke via WS broadcast.
		if (!decisionFromPipeline) {
			if (decision.action === "respond") {
				const instruction = decision.response ?? "";
				const preview =
					instruction.length > 120
						? `${instruction.slice(0, 120)}...`
						: instruction;
				ctx.log(`[${taskCtx.label}] Turn done, continuing: ${preview}`);
				ctx.sendChatMessage(
					`[${taskCtx.label}] Continuing work: ${preview || "sent follow-up instructions."}`,
					"coding-agent",
				);
			} else if (decision.action === "escalate") {
				ctx.sendChatMessage(
					`[${taskCtx.label}] Turn finished — needs your attention: ${decision.reasoning}`,
					"coding-agent",
				);
			}
		}
		// "complete" chat message is handled by executeDecision

		await executeDecision(ctx, sessionId, decision);
	} finally {
		ctx.inFlightDecisions.delete(sessionId);
		await drainPendingBlocked(ctx, sessionId);
		await drainPendingTurnComplete(ctx, sessionId);
	}
}

// ─── Autonomous / Confirm Decision Flows ───

/**
 * Handle an autonomous decision for a blocked session — call the LLM and execute immediately.
 */
export async function handleAutonomousDecision(
	ctx: SwarmCoordinatorContext,
	sessionId: string,
	taskCtx: TaskContext,
	promptText: string,
	recentOutput: string,
	promptType?: string,
): Promise<void> {
	// Debounce: skip if decision already in-flight for this session
	if (ctx.inFlightDecisions.has(sessionId)) {
		ctx.log(`Skipping duplicate decision for ${sessionId} (in-flight)`);
		return;
	}

	ctx.inFlightDecisions.add(sessionId);
	try {
		// Get recent output from PTY if not provided
		let output = recentOutput;
		if (!output) {
			output = await fetchRecentOutput(ctx, sessionId);
		}

		// Triage: route to small LLM (routine) or Milaidy pipeline (creative).
		// Track source so we skip duplicate chat messages when Milaidy already spoke.
		const agentDecisionCb = ctx.getAgentDecisionCallback();
		let decision: CoordinationLLMResponse | null = null;
		let decisionFromPipeline = false;

		const triageCtx: TriageContext = {
			eventType: "blocked",
			promptText,
			promptType,
			recentOutput: output,
			originalTask: taskCtx.originalTask,
		};
		const tier = agentDecisionCb
			? await classifyEventTier(ctx.runtime, triageCtx, ctx.log)
			: "routine"; // No pipeline → always small LLM

		if (tier === "routine") {
			decision = await makeCoordinationDecision(
				ctx,
				taskCtx,
				promptText,
				output,
			);
		} else {
			// Creative — try Milaidy pipeline, fall back to small LLM
			if (agentDecisionCb) {
				const eventMessage = buildBlockedEventMessage(
					toContextSummary(taskCtx),
					promptText,
					output,
					toDecisionHistory(taskCtx),
					collectSiblings(ctx, sessionId),
					ctx.sharedDecisions,
					ctx.getSwarmContext(),
				);
				try {
					decision = await withTimeout(
						agentDecisionCb(eventMessage, sessionId, taskCtx),
						DECISION_CB_TIMEOUT_MS,
						"agentDecisionCb",
					);
					if (decision) decisionFromPipeline = true;
				} catch (err) {
					ctx.log(
						`Agent decision callback failed: ${err} — falling back to small LLM`,
					);
				}
			}

			if (!decision) {
				decision = await makeCoordinationDecision(
					ctx,
					taskCtx,
					promptText,
					output,
				);
			}
		}

		if (!decision) {
			// All decision paths returned invalid response — escalate
			await ctx.recordDecision(taskCtx, {
				timestamp: Date.now(),
				event: "blocked",
				promptText,
				decision: "escalate",
				reasoning: "All decision paths returned invalid coordination response",
			});
			ctx.broadcast({
				type: "escalation",
				sessionId,
				timestamp: Date.now(),
				data: {
					prompt: promptText,
					reason: "invalid_llm_response",
				},
			});
			ctx.sendChatMessage(
				`[${taskCtx.label}] Needs your attention: the coordinator could not decide how to handle "${truncateForUser(promptText, 160)}".`,
				"coding-agent",
			);
			return;
		}

		// Guard: decline + redirect if the prompt references out-of-scope paths.
		// Instead of stalling via escalate, tell the agent "no" and point it to the
		// workspace. Also notify the human in case broader access was intended.
		if (
			decision.action === "respond" &&
			isOutOfScopeAccess(promptText, taskCtx.workdir)
		) {
			decision = {
				action: "respond",
				response: `No — that path is outside your workspace. Use ${taskCtx.workdir} instead. Create any files or directories you need there.`,
				reasoning: `Declined out-of-scope access (outside ${taskCtx.workdir}) and redirected agent to workspace.`,
			};
			// Surface to human so they can grant broader access if intended
			ctx.sendChatMessage(
				`[${taskCtx.label}] Declined out-of-scope access and redirected to workspace (${taskCtx.workdir}). If you intended broader access, send the agent an override.`,
				"coding-agent",
			);
		}

		// Record the decision
		taskCtx.autoResolvedCount = 0;
		await ctx.recordDecision(taskCtx, {
			timestamp: Date.now(),
			event: "blocked",
			promptText,
			decision: decision.action,
			response: formatDecisionResponse(decision),
			reasoning: decision.reasoning,
		});

		// Layer 2: capture significant decisions for cross-agent sharing
		recordKeyDecision(ctx, taskCtx.label, decision);

		// Broadcast the decision
		ctx.broadcast({
			type: "coordination_decision",
			sessionId,
			timestamp: Date.now(),
			data: {
				action: decision.action,
				response: decision.response,
				useKeys: decision.useKeys,
				keys: decision.keys,
				reasoning: decision.reasoning,
			},
		});

		// Send chat message for small-LLM decisions only.
		// When Milaidy's pipeline handled it, she already spoke via WS broadcast.
		if (!decisionFromPipeline) {
			if (decision.action === "respond") {
				const actionDesc = decision.useKeys
					? `Sent keys: ${decision.keys?.join(", ")}`
					: decision.response
						? `Responded: ${decision.response.length > 100 ? `${decision.response.slice(0, 100)}...` : decision.response}`
						: "Responded";
				const reasonExcerpt =
					decision.reasoning.length > 150
						? `${decision.reasoning.slice(0, 150)}...`
						: decision.reasoning;
				ctx.log(`[${taskCtx.label}] ${actionDesc} — ${reasonExcerpt}`);
			} else if (decision.action === "escalate") {
				ctx.sendChatMessage(
					`[${taskCtx.label}] Needs your attention: ${decision.reasoning}`,
					"coding-agent",
				);
			}
		}

		// Execute
		await executeDecision(ctx, sessionId, decision);
	} finally {
		ctx.inFlightDecisions.delete(sessionId);
		await drainPendingBlocked(ctx, sessionId);
		await drainPendingTurnComplete(ctx, sessionId);
	}
}

/**
 * Handle a confirm-mode decision — call LLM, then queue for human approval.
 */
export async function handleConfirmDecision(
	ctx: SwarmCoordinatorContext,
	sessionId: string,
	taskCtx: TaskContext,
	promptText: string,
	recentOutput: string,
	promptType?: string,
): Promise<void> {
	// Debounce
	if (ctx.inFlightDecisions.has(sessionId)) return;

	ctx.inFlightDecisions.add(sessionId);
	try {
		let output = recentOutput;
		if (!output) {
			output = await fetchRecentOutput(ctx, sessionId);
		}

		// Triage: route to small LLM (routine) or Milaidy pipeline (creative)
		const agentDecisionCb = ctx.getAgentDecisionCallback();
		let decision: CoordinationLLMResponse | null = null;
		let decisionFromPipeline = false;

		const triageCtx: TriageContext = {
			eventType: "blocked",
			promptText,
			promptType,
			recentOutput: output,
			originalTask: taskCtx.originalTask,
		};
		const tier = agentDecisionCb
			? await classifyEventTier(ctx.runtime, triageCtx, ctx.log)
			: "routine"; // No pipeline → always small LLM

		if (tier === "routine") {
			decision = await makeCoordinationDecision(
				ctx,
				taskCtx,
				promptText,
				output,
			);
		} else {
			// Creative — try Milaidy pipeline, fall back to small LLM
			if (agentDecisionCb) {
				const eventMessage = buildBlockedEventMessage(
					toContextSummary(taskCtx),
					promptText,
					output,
					toDecisionHistory(taskCtx),
					collectSiblings(ctx, sessionId),
					ctx.sharedDecisions,
					ctx.getSwarmContext(),
				);
				try {
					decision = await withTimeout(
						agentDecisionCb(eventMessage, sessionId, taskCtx),
						DECISION_CB_TIMEOUT_MS,
						"agentDecisionCb",
					);
					if (decision) decisionFromPipeline = true;
				} catch (err) {
					ctx.log(
						`Agent decision callback failed (confirm): ${err} — falling back to small LLM`,
					);
				}
			}

			if (!decision) {
				decision = await makeCoordinationDecision(
					ctx,
					taskCtx,
					promptText,
					output,
				);
			}
		}

		if (!decision) {
			// Queue for human with no suggestion
			taskCtx.status = "blocked";
			await ctx.syncTaskContext(taskCtx);
			const pendingDecision: PendingDecision = {
				sessionId,
				promptText,
				recentOutput: output,
				llmDecision: {
					action: "escalate",
					reasoning:
						"All decision paths returned invalid response — needs human review",
				},
				taskContext: taskCtx,
				createdAt: Date.now(),
			};
			ctx.pendingDecisions.set(sessionId, pendingDecision);
			await ctx.taskRegistry.upsertPendingDecision({
				sessionId,
				threadId: taskCtx.threadId,
				promptText,
				recentOutput: output,
				llmDecision: pendingDecision.llmDecision as unknown as Record<
					string,
					unknown
				>,
				taskContext: taskCtx as unknown as Record<string, unknown>,
				createdAt: pendingDecision.createdAt,
			});
		} else {
			// Queue the LLM's suggestion for human approval
			taskCtx.status = "blocked";
			await ctx.syncTaskContext(taskCtx);
			const pendingDecision: PendingDecision = {
				sessionId,
				promptText,
				recentOutput: output,
				llmDecision: decision,
				taskContext: taskCtx,
				createdAt: Date.now(),
			};
			ctx.pendingDecisions.set(sessionId, pendingDecision);
			await ctx.taskRegistry.upsertPendingDecision({
				sessionId,
				threadId: taskCtx.threadId,
				promptText,
				recentOutput: output,
				llmDecision: decision as unknown as Record<string, unknown>,
				taskContext: taskCtx as unknown as Record<string, unknown>,
				createdAt: pendingDecision.createdAt,
			});
		}

		await ctx.taskRegistry.appendEvent({
			threadId: taskCtx.threadId,
			sessionId,
			eventType: "pending_confirmation",
			summary: `Queued human confirmation for "${taskCtx.label}"`,
			data: {
				promptText,
				suggestedAction: decision?.action ?? "escalate",
			},
		});

		// When Milaidy's pipeline made the suggestion, she already spoke via WS broadcast.
		// Only broadcast the pending_confirmation event for small-LLM suggestions or
		// always broadcast it (the UI needs it regardless) but skip any chat messages.
		ctx.broadcast({
			type: "pending_confirmation",
			sessionId,
			timestamp: Date.now(),
			data: {
				prompt: promptText,
				suggestedAction: decision?.action,
				suggestedResponse: decision?.response,
				reasoning: decision?.reasoning,
				fromPipeline: decisionFromPipeline,
			},
		});
		ctx.sendChatMessage(
			[
				`[${taskCtx.label}] Waiting for your approval: ${truncateForUser(promptText, 180)}`,
				formatSuggestedAction(decision),
				decision?.reasoning
					? `Reason: ${truncateForUser(decision.reasoning, 180)}`
					: "",
			]
				.filter(Boolean)
				.join(" "),
			"coding-agent",
		);
	} finally {
		ctx.inFlightDecisions.delete(sessionId);
		await drainPendingTurnComplete(ctx, sessionId);
		await drainPendingBlocked(ctx, sessionId);
	}
}
