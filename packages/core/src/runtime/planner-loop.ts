/**
 * The planner's tool-calling agent loop: iteratively calls the planner model,
 * dispatches queued tool calls, and either gates or runs the trajectory
 * evaluator until a terminal signal, then synthesizes the final user-facing
 * message under trajectory / repeated-failure / prompt-token limits. Also owns
 * planner-output parsing (native plus text-recovered tool calls) and the
 * user-safe-message projection that keeps tool/control JSON and pre-tool
 * thoughts out of the reply.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { computeCallCostUsd } from "../features/trajectories/pricing";
import { logger } from "../logger";
import { parseInteractionBlocks } from "../messaging/interactions/parse";
import { plannerSchema, plannerTemplate } from "../prompts/planner";
import { resolveOptimizedPromptForRuntime } from "../services/optimized-prompt-resolver";
import {
	emitStreamingHook,
	getStreamingContext,
	runWithStreamingContext,
} from "../streaming-context";
import type {
	Action,
	ActionResult,
	ProviderDataRecord,
} from "../types/components";
import type { ContextEvent, ContextObjectTool } from "../types/context-object";
import {
	type ChatMessage,
	type GenerateTextResult,
	ModelType,
	type PromptSegment,
	type ResponseSkeleton,
	type SpanSamplerPlan,
	type TextGenerationModelType,
	type ToolCall,
	type ToolChoice,
	type ToolDefinition,
} from "../types/model";
import { isModelProviderError } from "../utils/model-errors";
import { resolveStateDir } from "../utils/state-dir";
import { computePrefixHashes } from "./context-hash";
import { appendContextEvent } from "./context-object";
import {
	buildStageChatMessages,
	cachePrefixSegments,
	normalizePromptSegments,
	renderContextObject,
} from "./context-renderer";
import { runEvaluator } from "./evaluator";
import {
	extractJsonObjects,
	parseJsonObject,
	stringifyForModel,
	stripJsonStructuralJunkReply,
} from "./json-output";
import {
	assertRepeatedFailureLimit,
	assertTrajectoryLimit,
	type ChainingLoopConfig,
	type FailureLike,
	mergeChainingLoopConfig,
	TrajectoryLimitExceeded,
} from "./limits";
import {
	buildModelInputBudget,
	type ModelInputBudget,
	withModelInputBudgetProviderOptions,
} from "./model-input-budget";
import {
	cacheProviderOptions,
	toolMessageContent,
	trajectoryStepsToMessages,
} from "./planner-rendering";
import type {
	ContextObject,
	EvaluatorOutput,
	PlannerLoopParams,
	PlannerLoopResult,
	PlannerRuntime,
	PlannerStep,
	PlannerToolCall,
	PlannerToolResult,
	PlannerTrajectory,
} from "./planner-types";
import {
	buildPlannerActionGrammarStrict,
	buildSpanSamplerPlan,
	withGuidedDecodeProviderOptions,
} from "./response-grammar";
import {
	buildProviderAttributionsFromState,
	flattenTrajectoryMessages,
} from "./trajectory-provider-attribution";
import type {
	RecordedStage,
	RecordedToolCall,
	RecordedUsage,
	TrajectoryRecorder,
} from "./trajectory-recorder";
import { captureToolStageIO } from "./trajectory-recorder";

export {
	cacheProviderOptions,
	trajectoryStepsToMessages,
} from "./planner-rendering";

// Test-only re-exports for the rendering memoization unit tests.
// Underscore-prefixed so they're impossible to mistake for production API.
export function __renderRoutingHintsBlockForTests(
	context: ContextObject,
): string | null {
	return renderRoutingHintsBlock(context);
}
export type {
	ContextObject,
	EvaluatorEffects,
	EvaluatorOutput,
	PlannerLoopParams,
	PlannerLoopResult,
	PlannerRuntime,
	PlannerStep,
	PlannerToolCall,
	PlannerToolResult,
	PlannerTrajectory,
} from "./planner-types";

const DEFAULT_PLANNER_MAX_TOKENS = 1024;

/**
 * Coding/full-surface mode is on when the eliza-code sub-agent sets
 * `ELIZA_PLANNER_FULL_ACTION_SURFACE` (the ACP server does). Centralized so the
 * tool-call ceiling, the queue-drain cadence, and the output-token cap all read
 * the same signal.
 */
function isCodingFullSurfaceMode(): boolean {
	const v = process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Default per-call output-token ceiling for a coding planner turn. A single
 * FILE/WRITE tool call must carry the entire file as a JSON-escaped argument —
 * a real single-file app (the reference `tetris.html` is ~4.6k tokens once
 * escaped) blows straight past the chat default of {@link DEFAULT_PLANNER_MAX_TOKENS}
 * (1024), which truncates the tool-call argument mid-stream so the model either
 * narrates without ever completing the call or the provider 400s. opencode on
 * the same Cerebras `zai-glm-4.7` builds the same app reliably precisely because
 * it does not clamp the file-emitting completion to a chat-sized budget.
 * Overridable via `ELIZA_CODING_PLANNER_MAX_TOKENS`. See issue #10132.
 */
const DEFAULT_CODING_PLANNER_MAX_TOKENS = 16384;

/**
 * Resolve the planner's per-call `maxTokens`: the small chat default, or — in
 * coding/full-surface mode — a budget large enough to emit a full file in one
 * tool call ({@link DEFAULT_CODING_PLANNER_MAX_TOKENS}, overridable via
 * `ELIZA_CODING_PLANNER_MAX_TOKENS`).
 */
function resolvePlannerMaxTokens(): number {
	if (!isCodingFullSurfaceMode()) return DEFAULT_PLANNER_MAX_TOKENS;
	const raw = Number(process.env.ELIZA_CODING_PLANNER_MAX_TOKENS);
	return Number.isFinite(raw) && raw > 0
		? Math.floor(raw)
		: DEFAULT_CODING_PLANNER_MAX_TOKENS;
}

interface RawPlannerOutput {
	action?: unknown;
	parameters?: unknown;
	thought?: unknown;
	toolCalls?: unknown;
	messageToUser?: unknown;
	text?: unknown;
	// Optional explicit completion signal. When emitted as a boolean,
	// `tryGateEvaluator` honors `completed=false` to fall through to the
	// full evaluator instead of synthesizing a FINISH. See gate
	// preconditions in `tryGateEvaluator`.
	completed?: unknown;
}

export async function runPlannerLoop(
	params: PlannerLoopParams,
): Promise<PlannerLoopResult> {
	const plannerContext = normalizePlannerContext(params.context);
	// Coding/full-surface mode (the eliza-code sub-agent sets
	// ELIZA_PLANNER_FULL_ACTION_SURFACE): a real build legitimately makes many
	// tool calls (read several files, write several, run tests). The chat default
	// (maxToolCalls=16) caps that mid-build, ending the turn on a
	// TrajectoryLimitExceeded with no terminal REPLY → an EMPTY relay to the user.
	// Raise the ceiling for coding builds (still bounded). Overridable via
	// ELIZA_CODING_MAX_TOOL_CALLS.
	const codingMode = isCodingFullSurfaceMode();
	const codingMaxToolCalls = ((): number => {
		const raw = Number(process.env.ELIZA_CODING_MAX_TOOL_CALLS);
		return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 80;
	})();
	// Weak coding models (e.g. Cerebras glm-4.7) sometimes answer a trivial build
	// with a terminal REPLY ("Creating the app now…") instead of calling FILE.
	// The action-first gate below re-prompts that, but the chat default of 3
	// misses gives up too soon to convert a stubborn narrator — give coding
	// builds more attempts to actually act. Overridable via
	// ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES.
	const codingMaxRequiredToolMisses = ((): number => {
		const raw = Number(process.env.ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES);
		return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
	})();
	const config = ((): ChainingLoopConfig => {
		const merged = mergeChainingLoopConfig(params.config);
		return codingMode
			? {
					...merged,
					maxToolCalls: Math.max(merged.maxToolCalls, codingMaxToolCalls),
					maxRequiredToolMisses: Math.max(
						merged.maxRequiredToolMisses,
						codingMaxRequiredToolMisses,
					),
				}
			: merged;
	})();
	const trajectory: PlannerTrajectory = {
		context: plannerContext,
		steps: [],
		archivedSteps: [],
		plannedQueue: [],
		evaluatorOutputs: [],
	};
	const failures: FailureLike[] = [];
	let terminalOnlyContinuations = 0;
	let requiredToolMisses = 0;
	let unavailableToolCallRetries = 0;
	let silentFailedFinishRecoveries = 0;
	let repeatedNonTerminalToolCalls = 0;
	// In coding mode the agent's whole job is to DO work via FILE/SHELL, so a
	// terminal REPLY before any non-terminal tool has run is almost always the
	// "Creating the app now…" narration that leaves nothing on disk. Force the
	// gate on (when real coding tools are exposed) so such a turn is re-prompted
	// into actually acting instead of being accepted as the final answer. A
	// genuinely blocking question still surfaces after the miss budget.
	const requireNonTerminalToolCall =
		(params.requireNonTerminalToolCall === true || codingMode) &&
		hasExposedNonTerminalTool(params.tools);
	// Stage 1's own answer for this turn, shape-guarded once up front. Consulted
	// only when the required-tool gate exhausts without a captured refusal — the
	// ground-truth answer Stage 1 already produced beats the caller's generic
	// apology (see PlannerLoopParams.stageOneReplyText).
	const stageOneAnswerText = requireNonTerminalToolCall
		? userSafeCapturedAnswerCandidate(params.stageOneReplyText)
		: undefined;

	// Cumulative gross prompt-token counter, summed across every planner
	// stage in this user turn. Tracked alongside the existing per-iter
	// counters (terminalOnlyContinuations, requiredToolMisses) so the
	// `maxTrajectoryPromptTokens` guard fires on the very call that crosses
	// the threshold rather than at the next-iteration check-in.
	let cumulativePromptTokens = 0;
	const observePlannerUsage = (usage: {
		promptTokens: number;
		completionTokens: number;
	}): void => {
		cumulativePromptTokens += usage.promptTokens;
		if (cumulativePromptTokens > config.maxTrajectoryPromptTokens) {
			throw new TrajectoryLimitExceeded({
				kind: "trajectory_token_budget",
				max: config.maxTrajectoryPromptTokens,
				observed: cumulativePromptTokens,
				message:
					`Trajectory prompt-token budget exceeded ` +
					`(${cumulativePromptTokens}/${config.maxTrajectoryPromptTokens}) — ` +
					`this turn is most likely stuck in a replan loop; aborting to bound cost.`,
			});
		}
	};
	// Tracks the most recent planner output's *explicit* `messageToUser` so the
	// post-tool evaluator gate can use it as the final response when the
	// trajectory ends cleanly. EXPLICIT means the planner's structured output
	// carried a `messageToUser` field — not a fallback inferred from a stray
	// `text` field on a native tool-call return (which can be a pre-tool thought
	// rather than a final answer). The gate refuses ambiguous signals to avoid
	// surfacing a thought as the user-facing reply.
	let lastPlannerExplicitMessageToUser: string | undefined;
	// Tracks the most recent planner output's explicit `completed` flag, when
	// emitted as a boolean. The gate (`tryGateEvaluator`) treats
	// `completed === false` as a hard veto on synthesizing a FINISH — the
	// planner is explicitly signaling that this turn's tool calls do not yet
	// achieve the goal (e.g. read-then-act, multi-step deploy). When the
	// field is absent the gate's other preconditions are honored as before.
	let lastPlannerExplicitCompleted: boolean | undefined;
	// Captures the most recent terminal-only refusal text the planner produced
	// across iterations gated by `requireNonTerminalToolCall`. When Stage 1
	// asserts `requiresTool=true` but no exposed tool can fulfill the request,
	// the planner repeatedly emits REPLY (or bare messageToUser) with a valid
	// honest refusal. Without this, the loop discards every refusal, exceeds
	// `maxRequiredToolMisses`, throws `TrajectoryLimitExceeded`, and the
	// caller surfaces a generic apology instead of the planner's real answer.
	let lastTerminalRefusalText: string | undefined;
	// The most recent REJECTED terminal ANSWER (non-refusal-shaped, explicit /
	// REPLY-call sources only) across required-tool misses — e.g. the planner
	// kept answering "391" via REPLY while the gate demanded a non-terminal
	// tool. Last-resort fallback when the miss budget exhausts with no captured
	// refusal and no Stage-1 replyText: the model's own discarded answer still
	// beats the generic apology.
	let lastRejectedTerminalAnswerText: string | undefined;
	// Sanitized widget-bearing terminal text from the previous required-tool
	// miss. When the model re-emits the identical widget reply after one
	// corrective retry it is deterministically committed to that answer —
	// finish with it instead of burning the remaining miss budget (which costs
	// four cold CLI spawns on the text-planner lane, #15230).
	let lastMissWidgetText: string | undefined;

	// Coding/full-surface mode (set above from ELIZA_PLANNER_FULL_ACTION_SURFACE):
	// when the model emits a batch of tool calls in a single response, execute
	// EVERY queued call before re-evaluating. A real build needs all of its
	// FILE/SHELL calls to run; a dedicated coding agent drains the whole batch and
	// feeds the results back together. Chat mode keeps its
	// re-evaluate-after-each-action cadence (one action, then evaluate).
	const codingDrainQueue = codingMode;

	for (let iteration = 1; ; iteration++) {
		if (trajectory.plannedQueue.length === 0) {
			const plannerOutput = await callPlanner({
				runtime: params.runtime,
				context: trajectory.context,
				trajectory,
				config,
				modelType: params.modelType,
				provider: params.provider,
				tools: params.tools,
				// Force a tool call ONLY while the turn's "use a real tool" requirement
				// is still unmet. Once a non-terminal tool has executed, relax to
				// "auto" so the planner is free to synthesize a terminal REPLY from
				// the result instead of being pushed to re-call a tool every
				// iteration. "auto" must be EXPLICIT: passing the caller's (undefined)
				// choice would be a no-op because callPlanner defaults undefined back
				// to "required".
				toolChoice: requireNonTerminalToolCall
					? hasExecutedNonTerminalTool(trajectory)
						? "auto"
						: "required"
					: params.toolChoice,
				recorder: params.recorder,
				trajectoryId: params.trajectoryId,
				parentStageId: params.parentStageId,
				providerAttributionState: params.providerAttributionState,
				iteration,
				onUsage: observePlannerUsage,
			});
			// Treat `messageToUser` as authoritative ONLY when the planner's structured
			// output carried it as an explicit field. The native-tool-call code path
			// in `parsePlannerOutput` falls back to `raw.text`, but in native mode
			// `text` can be a pre-tool thought rather than a final answer — too
			// ambiguous to drive the gate. We therefore probe `raw.messageToUser`
			// directly here; native-mode returns won't have that key, so the gate
			// stays inert in that path.
			const explicit = plannerOutput.raw.messageToUser;
			lastPlannerExplicitMessageToUser =
				typeof explicit === "string" && explicit.trim().length > 0
					? explicit
					: undefined;
			// Capture the planner's explicit `completed` boolean when present.
			// Any non-boolean (string "false", number, null, missing) is treated
			// as "unspecified" and does not influence the gate — only an actual
			// `false` boolean blocks. This keeps backward compat with planner
			// outputs that don't carry the field.
			const completedRaw = plannerOutput.raw.completed;
			lastPlannerExplicitCompleted =
				typeof completedRaw === "boolean" ? completedRaw : undefined;

			if (plannerOutput.toolCalls.length === 0) {
				if (
					requireNonTerminalToolCall &&
					!hasExecutedNonTerminalTool(trajectory)
				) {
					// Prefer the planner's EXPLICIT messageToUser refusal. When the
					// model emitted only native free text (no explicit field, no REPLY
					// call), fall back to that text ONLY if it survives the user-safe
					// refusal gate — which rejects reasoning/leak/fabrication AND
					// pre-tool deliberation — so an honest native-mode refusal reaches
					// the user instead of the caller's generic apology, without ever
					// surfacing a pre-tool thought (#9874 item 3; guarded by the "does
					// not capture native text fallback" test).
					const refusalCandidate =
						userSafeRefusalCandidate(lastPlannerExplicitMessageToUser) ??
						userSafeRefusalCandidate(plannerOutput.messageToUser);
					// A widget-bearing reply ([FORM]/[CHOICE]/…) is a legitimate
					// terminal answer that asks the user for input — capture it like a
					// refusal so it survives required-tool exhaustion, and finish
					// immediately when the model re-emits it verbatim after one
					// corrective retry (#15230).
					const widgetCandidate =
						refusalCandidate === undefined
							? (userSafeWidgetReplyCandidate(
									lastPlannerExplicitMessageToUser,
								) ?? userSafeWidgetReplyCandidate(plannerOutput.messageToUser))
							: undefined;
					if (widgetCandidate && widgetCandidate === lastMissWidgetText) {
						return finishWithCapturedRefusal({
							trajectory,
							iteration,
							thought: plannerOutput.thought,
							refusal: widgetCandidate,
						});
					}
					lastMissWidgetText = widgetCandidate;
					const captured = refusalCandidate ?? widgetCandidate;
					if (captured) lastTerminalRefusalText = captured;
					// Only the EXPLICIT messageToUser is a safe answer source in
					// this branch — the native free-text fallback can be a pre-tool
					// thought (#9874 item 3), so it is never captured as an answer.
					const rejectedAnswerCandidate =
						captured === undefined
							? userSafeCapturedAnswerCandidate(
									lastPlannerExplicitMessageToUser,
								)
							: undefined;
					if (rejectedAnswerCandidate) {
						lastRejectedTerminalAnswerText = rejectedAnswerCandidate;
					}
					requiredToolMisses++;
					const capturedFinishText =
						lastTerminalRefusalText ??
						stageOneAnswerText ??
						lastRejectedTerminalAnswerText;
					if (
						requiredToolMisses > config.maxRequiredToolMisses &&
						capturedFinishText
					) {
						return finishWithCapturedRefusal({
							trajectory,
							iteration,
							thought: plannerOutput.thought,
							refusal: capturedFinishText,
						});
					}
					assertTrajectoryLimit({
						kind: "required_tool_misses",
						max: config.maxRequiredToolMisses,
						observed: requiredToolMisses,
					});
					handleRequiredToolPlannerMiss({
						trajectory,
						iteration,
						plannerOutput,
						reason: "no_tool_calls",
						logger: params.runtime.logger,
					});
					continue;
				}
				trajectory.steps.push({
					iteration,
					thought: plannerOutput.thought,
					terminalMessage: plannerOutput.messageToUser,
					terminalOnly: true,
				});
				trajectory.context = appendTerminalPlannerOutputEvent({
					context: trajectory.context,
					iteration,
					message: plannerOutput.messageToUser,
				});
				if (trajectory.steps.some((step) => step.toolCall)) {
					// Coding mode: the model emitted a final text summary AFTER
					// executing build tools — it's signalling completion. Finish with
					// that message instead of running the chat completion-evaluator,
					// which can decline to FINISH and trip terminal_only_continuations
					// (observed live: a successful 4-file build threw 3/2 and relayed an
					// EMPTY reply). The model, not the evaluator, owns termination here.
					if (codingDrainQueue) {
						return {
							status: "finished",
							trajectory,
							finalMessage: userSafeFinalMessage(
								codingFinalMessage(trajectory, plannerOutput.messageToUser),
								trajectory,
							),
						};
					}
					const evaluator = await evaluateTrajectory(
						params,
						trajectory,
						iteration,
					);
					trajectory.evaluatorOutputs.push(evaluator);
					trajectory.context = appendEvaluationEvent({
						context: trajectory.context,
						iteration,
						evaluator,
					});

					if (evaluator.decision === "FINISH") {
						return {
							status: "finished",
							trajectory,
							evaluator,
							finalMessage: userSafeFinalMessage(
								preferredFinalMessageFromToolOrModel(
									trajectory,
									evaluator.messageToUser ?? plannerOutput.messageToUser,
								),
								trajectory,
							),
						};
					}

					if (evaluator.decision === "NEXT_RECOMMENDED") {
						const selected = preferRecommendedToolCall(trajectory, evaluator);
						if (!selected) {
							params.runtime.logger?.warn?.(
								{
									recommendedToolCallId: evaluator.recommendedToolCallId,
									queuedToolCallIds: trajectory.plannedQueue.map(
										(call) => call.id,
									),
								},
								"Evaluator requested NEXT_RECOMMENDED without a valid queued tool after terminal planner output; replanning",
							);
							trajectory.plannedQueue.length = 0;
						}
						continue;
					}

					terminalOnlyContinuations++;
					if (terminalOnlyContinuations > config.maxTerminalOnlyContinuations) {
						const relay =
							deterministicTerminalContinuationLimitRelay(trajectory);
						if (relay) {
							params.runtime.logger?.warn?.(
								{
									iteration,
									terminalOnlyContinuations,
									maxTerminalOnlyContinuations:
										config.maxTerminalOnlyContinuations,
								},
								"[planner-loop] terminal-only continuation limit reached; relaying the completed tool result instead of discarding the turn",
							);
							return {
								status: "finished",
								trajectory,
								evaluator,
								finalMessage: userSafeFinalMessage(relay, trajectory),
							};
						}
					}
					assertTrajectoryLimit({
						kind: "terminal_only_continuations",
						max: config.maxTerminalOnlyContinuations,
						observed: terminalOnlyContinuations,
					});
					trajectory.plannedQueue.length = 0;
					trajectory.context = appendTerminalContinuationEvent({
						context: trajectory.context,
						iteration,
						terminalOnlyContinuations,
						message: plannerOutput.messageToUser,
					});
					continue;
				}
				return {
					status: "finished",
					trajectory,
					finalMessage: userSafeFinalMessage(
						plannerOutput.messageToUser,
						trajectory,
					),
				};
			}

			if (plannerOutput.toolCalls.every(isTerminalToolCall)) {
				if (
					requireNonTerminalToolCall &&
					!hasExecutedNonTerminalTool(trajectory)
				) {
					const terminalText = terminalMessageFromToolCalls(
						plannerOutput.toolCalls,
						plannerOutput.messageToUser,
					);
					const refusalCandidate = userSafeRefusalCandidate(terminalText);
					// Same widget-reply escape hatch as the no_tool_calls branch above:
					// a planner that wraps its [FORM] answer in an explicit REPLY call
					// must not lose it to the required-tool gate either (#15230).
					const widgetCandidate =
						refusalCandidate === undefined
							? userSafeWidgetReplyCandidate(terminalText)
							: undefined;
					if (widgetCandidate && widgetCandidate === lastMissWidgetText) {
						return finishWithCapturedRefusal({
							trajectory,
							iteration,
							thought: plannerOutput.thought,
							refusal: widgetCandidate,
						});
					}
					lastMissWidgetText = widgetCandidate;
					const captured = refusalCandidate ?? widgetCandidate;
					if (captured) lastTerminalRefusalText = captured;
					// A REPLY tool call's OWN params text is user-directed by
					// construction; a STOP/IGNORE-only terminal's free text is scratch
					// reasoning (see the hasReplyCall comment below) and is never
					// captured. Deliberately NO messageToUser fallback here: a REPLY
					// call with empty params would otherwise capture the native
					// free-text fallback, which can be a pre-tool thought.
					const rejectedAnswerCandidate =
						captured === undefined
							? userSafeCapturedAnswerCandidate(
									terminalMessageFromToolCalls(plannerOutput.toolCalls),
								)
							: undefined;
					if (rejectedAnswerCandidate) {
						lastRejectedTerminalAnswerText = rejectedAnswerCandidate;
					}
					requiredToolMisses++;
					const capturedFinishText =
						lastTerminalRefusalText ??
						stageOneAnswerText ??
						lastRejectedTerminalAnswerText;
					if (
						requiredToolMisses > config.maxRequiredToolMisses &&
						capturedFinishText
					) {
						return finishWithCapturedRefusal({
							trajectory,
							iteration,
							thought: plannerOutput.thought,
							refusal: capturedFinishText,
						});
					}
					assertTrajectoryLimit({
						kind: "required_tool_misses",
						max: config.maxRequiredToolMisses,
						observed: requiredToolMisses,
					});
					handleRequiredToolPlannerMiss({
						trajectory,
						iteration,
						plannerOutput,
						reason: "terminal_only_tool_calls",
						logger: params.runtime.logger,
					});
					continue;
				}
				// The messageToUser fallback applies only when a REPLY call is
				// present (textless REPLY → the model's text is its reply). On
				// STOP/IGNORE-only terminals the model chose silence: free text
				// accompanying the call is scratch reasoning, not a user reply
				// ("We should wait for the sub-agent result before replying."
				// reached Discord verbatim, live 2026-06-12).
				const hasReplyCall = plannerOutput.toolCalls.some(
					(toolCall) => toolCall.name.toUpperCase() === "REPLY",
				);
				const finalMessage = hasReplyCall
					? terminalMessageFromToolCalls(
							plannerOutput.toolCalls,
							plannerOutput.messageToUser,
						)
					: undefined;
				trajectory.steps.push({
					iteration,
					thought: plannerOutput.thought,
					terminalMessage: finalMessage,
					terminalOnly: true,
				});
				const terminalEvaluator = terminalToolCallFinish(finalMessage);
				// Only record an evaluation stage when the trajectory already has
				// prior evaluator outputs. A terminal-only iteration on the very
				// first planner turn (e.g. REPLY) is purely terminal and should
				// not surface an `evaluation` stage in the recorded trajectory
				// — the happy path tests assert this.
				const shouldRecordTerminalEvaluation =
					trajectory.evaluatorOutputs.length > 0;
				trajectory.evaluatorOutputs.push(terminalEvaluator);
				trajectory.context = appendEvaluationEvent({
					context: trajectory.context,
					iteration,
					evaluator: terminalEvaluator,
				});
				if (shouldRecordTerminalEvaluation) {
					const terminalEvalStartedAt = Date.now();
					await recordGatedEvaluationStage({
						recorder: params.recorder,
						trajectoryId: params.trajectoryId,
						parentStageId: params.parentStageId,
						iteration,
						startedAt: terminalEvalStartedAt,
						endedAt: Date.now(),
						output: terminalEvaluator,
						reason: "terminal_tool_call",
						logger: params.runtime.logger,
					});
				}
				return {
					status: "finished",
					trajectory,
					evaluator: terminalEvaluator,
					finalMessage: userSafeFinalMessage(
						codingDrainQueue
							? codingFinalMessage(trajectory, finalMessage)
							: finalMessage,
						trajectory,
					),
				};
			}

			const nonTerminalCalls = plannerOutput.toolCalls
				.filter((toolCall) => !isTerminalToolCall(toolCall))
				.map((toolCall, index) => ensureToolCallId(toolCall, iteration, index));
			const unavailable = splitUnavailableToolCalls(
				nonTerminalCalls,
				params.tools,
			);
			if (unavailable.invalid.length > 0) {
				params.runtime.logger?.warn?.(
					{
						iteration,
						invalidToolCalls: unavailable.invalid.map(
							(toolCall) => toolCall.name,
						),
					},
					"Planner called unavailable tools; retrying without executing them",
				);
				trajectory.context = appendUnavailableToolCallEvent({
					context: trajectory.context,
					iteration,
					invalidToolCalls: unavailable.invalid,
					tools: params.tools,
				});
				if (unavailable.valid.length === 0) {
					unavailableToolCallRetries++;
					assertTrajectoryLimit({
						kind: "unavailable_tool_calls",
						max: config.maxUnavailableToolCallRetries,
						observed: unavailableToolCallRetries,
					});
					continue;
				}
			}
			// Loop-breaker: a non-terminal call that exactly repeats one already
			// SUCCEEDED this turn (same name + args) cannot return new data. Execute
			// only genuinely-fresh calls; when every call this iteration is such a
			// repeat, count a dead round and — past `maxRepeatedToolCalls` — force a
			// terminal synthesis instead of looping to the prompt-token budget.
			const { fresh: validNonTerminalCalls, redundant: redundantCalls } =
				partitionRedundantSucceededCalls(unavailable.valid, trajectory);
			if (validNonTerminalCalls.length === 0 && redundantCalls.length > 0) {
				repeatedNonTerminalToolCalls++;
				trajectory.context = appendContextEvent(trajectory.context, {
					id: `redundant-tool-call:${iteration}`,
					type: "instruction",
					source: "planner-loop",
					createdAt: Date.now(),
					content:
						"You already have a successful result this turn for " +
						`${redundantCalls.map((call) => call.name).join(", ")} with these ` +
						"exact arguments. Re-running it cannot return new information — " +
						"answer the user now from the results already gathered.",
				});
				if (repeatedNonTerminalToolCalls > config.maxRepeatedToolCalls) {
					return finishWithForcedSynthesis({
						loop: params,
						config,
						trajectory,
						iteration,
						onUsage: observePlannerUsage,
					});
				}
				trajectory.plannedQueue.length = 0;
				continue;
			}
			if (redundantCalls.length > 0) {
				params.runtime.logger?.debug?.(
					{ iteration, skipped: redundantCalls.map((call) => call.name) },
					"Skipping tool calls that already succeeded with identical args this turn",
				);
			}
			repeatedNonTerminalToolCalls = 0;
			trajectory.plannedQueue.push(...validNonTerminalCalls);
			trajectory.context = {
				...trajectory.context,
				plannedQueue: [
					...(trajectory.context.plannedQueue ?? []),
					...validNonTerminalCalls.map((toolCall) => ({
						id: toolCall.id,
						name: toolCall.name,
						args: stringifyForModel(toolCall.params ?? {}),
						status: "queued" as const,
						sourceStageId: `planner:${iteration}`,
					})),
				],
			};
			for (const toolCall of validNonTerminalCalls) {
				trajectory.context = appendContextEvent(trajectory.context, {
					id: `queue:${toolCall.id ?? toolCall.name}:${iteration}`,
					type: "planned_tool_call",
					source: "planner-loop",
					createdAt: Date.now(),
					metadata: {
						iteration,
						toolCallId: toolCall.id,
						name: toolCall.name,
						params: stringifyForModel(toolCall.params ?? {}),
						status: "queued",
					},
				});
			}
		}

		const toolCall = trajectory.plannedQueue.shift();
		if (!toolCall) {
			continue;
		}

		await executeQueuedToolCall({
			params,
			trajectory,
			toolCall,
			iteration,
			config,
			failures,
		});

		const latestResult = trajectory.steps[trajectory.steps.length - 1]?.result;
		if (latestResult?.continueChain === false) {
			// `suppressPlannerReply` from terminal actions blanks finalMessage so a
			// same-turn hallucinated `messageToUser` cannot leak past the transient
			// filter (which only masks it on the *next* turn).
			const suppressReply =
				(latestResult.data as { suppressPlannerReply?: unknown } | undefined)
					?.suppressPlannerReply === true;
			return {
				status: "finished",
				trajectory,
				finalMessage: suppressReply
					? ""
					: userSafeFinalMessage(
							// Coding mode: drop a junk/empty terminal reply and fall back to
							// a synthesized "what I did" summary so the sub-agent never
							// relays garbage or an empty reply after doing real work.
							codingDrainQueue
								? codingFinalMessage(trajectory, latestResult.text)
								: latestResult.text,
							trajectory,
						),
			};
		}

		// Coding mode: keep executing the rest of this model-emitted tool-call
		// batch before evaluating/re-planning. Terminal calls already returned
		// above, so anything still queued is non-terminal build work (more FILE
		// writes / SHELL runs) that the model asked for in the same response.
		if (codingDrainQueue && trajectory.plannedQueue.length > 0) {
			continue;
		}

		await maybeCompactBeforeNextModelCall({
			trajectory,
			config,
			tools: params.tools,
			recorder: params.recorder,
			trajectoryId: params.trajectoryId,
			parentStageId: params.parentStageId,
			iteration,
			logger: params.runtime.logger,
		});

		// Coding mode: the MODEL — not the chat completion-evaluator — owns
		// termination. After a tool batch is fully drained, re-plan (give the
		// model another tools round) so it can run the next step (e.g. SHELL
		// after writing files) and only ends the turn by emitting a terminal
		// call (REPLY/STOP), handled at the top of the loop. `maxToolCalls`
		// bounds runaway loops. This gives the eliza-code sub-agent a real
		// coding-agent loop instead of chat's evaluate-after-each-action — the
		// chat evaluator would otherwise prematurely FINISH after the first
		// file write (before the build's SHELL run / verification).
		if (codingDrainQueue) {
			trajectory.plannedQueue.length = 0;
			continue;
		}

		// Conservative gate (PR #7514): when a successful tool drained the queue
		// and the just-completed planner call gave us a clean explicit
		// `messageToUser`, synthesize a FINISH and skip the in-loop evaluator.
		// Falls through on any ambiguity. See `tryGateEvaluator` doc-comment.
		const gateStartedAt = Date.now();
		const gated = tryGateEvaluator({
			trajectory,
			failures,
			lastPlannerExplicitMessageToUser,
			lastPlannerExplicitCompleted,
		});
		if (gated) {
			trajectory.evaluatorOutputs.push(gated);
			trajectory.context = appendEvaluationEvent({
				context: trajectory.context,
				iteration,
				evaluator: gated,
			});
			await recordGatedEvaluationStage({
				recorder: params.recorder,
				trajectoryId: params.trajectoryId,
				parentStageId: params.parentStageId,
				iteration,
				startedAt: gateStartedAt,
				endedAt: Date.now(),
				output: gated,
				logger: params.runtime.logger,
			});
			return {
				status: "finished",
				trajectory,
				evaluator: gated,
				finalMessage: userSafeFinalMessage(
					preferredFinalMessageFromToolOrModel(trajectory, gated.messageToUser),
					trajectory,
				),
			};
		}

		let evaluator: EvaluatorOutput;
		try {
			evaluator = await evaluateTrajectory(params, trajectory, iteration);
		} catch (err) {
			// error-policy:J4 explicit user-facing degrade - only an EXPECTED
			// provider/model failure degrades to the completed tool's truthful
			// output; every other error shape propagates.
			// The in-loop evaluator is a MODEL call: it decides FINISH/CONTINUE and
			// synthesizes the user-facing reply from the tool results. When it fails
			// transiently (a provider 400/429/5xx or a network error) AFTER a
			// non-terminal tool already executed successfully this turn, propagating
			// the error discards the completed work and surfaces the generic
			// "something went wrong" apology — a lie, because the tool did the work
			// (e.g. FILE wrote the file). Relay the successful tool's own truthful
			// output deterministically (no further model call, so the same provider
			// failure cannot recur).
			// The gate is what keeps this a J4 "only expected error shapes degrade"
			// handler and not a bug-swallower: a TypeError, a SchemaValidationFailedError,
			// or any programmer error carries no HTTP status / network code, so it
			// rethrows and surfaces instead of being masked as a finished turn. With
			// no successful non-terminal tool to relay, rethrow too — never mask a
			// real failure.
			if (!isModelProviderError(err)) throw err;
			const relay = deterministicSuccessfulToolRelay(trajectory);
			if (!relay) throw err;
			params.runtime.logger?.warn?.(
				{ iteration, err: err instanceof Error ? err.message : String(err) },
				"[planner-loop] post-tool evaluator model call failed; relaying the completed tool result instead of discarding the turn",
			);
			return {
				status: "finished",
				trajectory,
				finalMessage: userSafeFinalMessage(relay, trajectory),
			};
		}
		trajectory.evaluatorOutputs.push(evaluator);
		appendEvaluatorContextEvent(trajectory, evaluator, iteration);

		if (evaluator.decision === "FINISH") {
			if (
				shouldRecoverSilentFailedFinish({
					evaluator,
					trajectory,
					recoveryCount: silentFailedFinishRecoveries,
				})
			) {
				silentFailedFinishRecoveries++;
				trajectory.context = appendSilentFailedFinishRecoveryEvent({
					context: trajectory.context,
					iteration,
					evaluator,
					trajectory,
				});
				continue;
			}
			return {
				status: "finished",
				trajectory,
				evaluator,
				finalMessage: userSafeFinalMessage(
					preferredFinalMessageFromToolOrModel(
						trajectory,
						evaluator.messageToUser,
						evaluator.success === false
							? failedToolFallbackMessage(trajectory)
							: undefined,
					),
					trajectory,
				),
			};
		}

		if (evaluator.decision === "NEXT_RECOMMENDED") {
			const selected = preferRecommendedToolCall(trajectory, evaluator);
			if (!selected) {
				params.runtime.logger?.warn?.(
					{
						recommendedToolCallId: evaluator.recommendedToolCallId,
						queuedToolCallIds: trajectory.plannedQueue.map((call) => call.id),
					},
					"Evaluator requested NEXT_RECOMMENDED without a valid queued tool; replanning",
				);
				trajectory.plannedQueue.length = 0;
			}
			continue;
		}

		trajectory.plannedQueue.length = 0;
	}
}

function normalizePlannerContext(context: ContextObject): ContextObject {
	return Array.isArray(context.events)
		? context
		: {
				...context,
				events: [],
			};
}

function renderPlannerModelInput(params: {
	context: ContextObject;
	trajectory: PlannerTrajectory;
	template?: string;
	runtime?: PlannerRuntime;
	/**
	 * Optional per-tool-result character cap. Forwarded directly to
	 * `trajectoryStepsToMessages` — caps the rendered tool-result
	 * string for each kept-verbatim step without mutating the
	 * trajectory itself.
	 */
	maxToolResultChars?: number;
}): {
	messages: ChatMessage[];
	promptSegments: PromptSegment[];
} {
	const renderedContext = renderContextObject(params.context);
	const template = params.template ?? plannerTemplate;
	const instructions = appendMandatoryPlannerPolicy(
		template.split("context_object:")[0] ?? template,
	).trim();
	const stepMessages = trajectoryStepsToMessages(params.trajectory.steps, {
		maxToolResultChars: params.maxToolResultChars,
	});
	// Action names + parameter schemas now ride directly on the tools array
	// (each Action is exposed as its own native tool), so there is no separate
	// available_actions block rendered into the prompt. Routing hints stay as a
	// dedicated section since they layer business advice on top of the bare
	// action descriptions.
	const routingHintsBlock = renderRoutingHintsBlock(params.context);
	const extraSegments: PromptSegment[] = [];
	if (routingHintsBlock) {
		extraSegments.push({ content: routingHintsBlock, stable: false });
	}
	const contextSegments =
		extraSegments.length > 0
			? [...renderedContext.promptSegments, ...extraSegments]
			: renderedContext.promptSegments;
	// The planner stage instructions are template-derived (`plannerTemplate`)
	// and structurally identical across iterations and across user turns, so they
	// belong in the cached prefix. Marking the segment `stable: true` lets the
	// Anthropic provider stamp `cache_control` on this block and lets the
	// cache-key prefix extend through these instructions.
	const promptSegments = normalizePromptSegments([
		...contextSegments,
		{ content: `planner_stage:\n${instructions}`, stable: true },
	]);
	// Native tool-call messages: assistant (with toolCalls) + tool (result) per
	// completed step. This grows append-only across planner iterations so the
	// base prefix remains byte-identical and Cerebras's prompt cache can hit.
	// The trajectory JSON is NOT included in dynamicBlocks here — it is conveyed
	// through stepMessages (proper assistant/tool pairs). Including it as a
	// dynamic block would re-introduce the JSON-dump anti-pattern in the user
	// message and invalidate the cache prefix on every iteration.
	const messages = buildStageChatMessages({
		contextSegments,
		stageLabel: "planner_stage",
		instructions,
		dynamicBlocks: [],
		stepMessages,
	});
	return { messages, promptSegments };
}

function compactionReserveForBudget(
	config: ChainingLoopConfig,
): number | undefined {
	if (
		config.contextWindowModelName &&
		config.compactionReserveTokensExplicit !== true
	) {
		return undefined;
	}
	return config.compactionReserveTokens;
}

function normalizePlannerToolName(name: string): string {
	return name
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
}

/**
 * Build a "Routing hints" block from each available action's
 * {@link Action.routingHint}. Each action carries its own one-line hint as
 * metadata, and the planner sees them only when the action is actually exposed
 * for this turn.
 *
 * Returns `null` when no exposed action has a `routingHint` set, so the
 * planner prompt simply omits the section.
 *
 * When `ELIZA_PROMPT_COMPRESS=1` is set, skip routing-hint rendering
 * entirely — the Cerebras compress-mode escape hatch trades these hints for a
 * tighter token budget. Memoized on `context.events` identity; the events
 * array is immutable per planner iteration (`appendContextEvent` returns a
 * new array each time).
 */
const ROUTING_HINTS_MEMO = new WeakMap<
	NonNullable<ContextObject["events"]>,
	string | null
>();

const MANDATORY_PLANNER_POLICY_LINES = [
	"messageToUser alone cannot save, schedule, send, update, remember, or complete anything",
	"SHELL is for filesystem/process work, not a fallback for chat-message search/recall, memory queries, or agent-history lookups.",
	"candidateActions naming a tool that is not in this turn's exposed tools list is a dead hint",
	"TASKS_SPAWN_AGENT is for delegating coding/build/repo work",
	"Structured chat markers are allowed in messageToUser",
	"messageToUser and REPLY text must NEVER claim or imply",
];

const MANDATORY_PLANNER_POLICY = [
	"mandatory planner policy:",
	'- messageToUser alone cannot save, schedule, send, update, remember, or complete anything. If an exposed tool can perform the requested side effect, call it. Never say "saved", "logged", "scheduled", "sent", "updated", or "done" unless a tool result this turn proves it.',
	"- Structured chat markers are allowed in messageToUser when they are the actual user-visible interaction payload: [FORM]\\n{json}\\n[/FORM], [CHOICE:scope id=id]\\nvalue=Label\\n[/CHOICE], [FOLLOWUPS id=id]\\nvalue=Label\\n[/FOLLOWUPS], or [TASK:threadId]Title[/TASK]. The JSON inside [FORM] is form data, not a tool attempt; keep JSON inside the marker and do not emit unrelated JSON.",
	"- SHELL is for filesystem/process work, not a fallback for chat-message search/recall, memory queries, or agent-history lookups. When the user wants chat-message search/recall, memory queries, or agent-history lookups and no dedicated search action (e.g. SEARCH_MESSAGES, MESSAGE_SEARCH, MEMORY_SEARCH) is exposed, do not run shell greps, echo placeholders, or simulate the search — set messageToUser explaining that the capability is not available this turn.",
	'- candidateActions naming a tool that is not in this turn\'s exposed tools list is a dead hint — do not invent SHELL/BROWSER/TASKS workarounds to fulfill it. Either an exposed tool genuinely resolves the user\'s intent (call it), or no tool fits (set messageToUser). Never emit echo-placeholder SHELL commands such as: echo "<intent-name>" / echo "placeholder for <ACTION>" / echo "search <X>" as a way to "trigger" a missing capability — placeholder echoes burn cost and produce no progress.',
	'- TASKS_SPAWN_AGENT is for delegating coding/build/repo work to a coding sub-agent (file edits, shell tooling, building/deploying apps, running tests, opening PRs). It is not a fallback for chat-message recall, memory queries, or agent-history lookups. Spawning a coding sub-agent to "search the Discord channel for messages mentioning X" routinely ends in sub-agent error/timeout and a generic "Sorry, something went wrong" reply to the user. When the user wants chat-message recall and no dedicated search action is exposed, set messageToUser explaining the capability is not available — do not spawn a sub-agent for it.',
	'- messageToUser and REPLY text must NEVER claim or imply an investigative OR task-execution action is happening, has happened, or is about to happen — "I\'m fetching X, please hold", "Let me look that up", "Pulling up the info", "Searching for the answer", "I\'m checking now", "I\'ll get back to you", "Spawning a sub-agent", "I\'m working on it", "I\'m fixing that now", "Let me get that done", "Wrapping it up", "Almost done", "Building it now", "I\'ll start on that" — when no tool call this turn is in flight to produce that content. A claim that you are working on / starting / fixing / building / wrapping up a task is only legitimate when a task-executing tool call (e.g. TASKS_SPAWN_AGENT) is actually in flight THIS turn; if you did not spawn a sub-agent or take an action this turn, do not say the task is underway. The planner does not run in the background after returning; once this turn ends, no further tool work happens unless a NEW user message arrives. If your tool iterations exhausted without a usable result (search returned nothing, fetch was blocked, scrape gave no usable HTML, RSS was empty), set messageToUser saying so plainly: "I tried web search via the available tools and couldn\'t find current info on X — try checking a news site directly" or "The searches returned no usable results". Never promise ongoing fetch when this turn is the planner\'s final iteration. This rule covers every grammatical form for both investigative and task-execution verbs (fetch/search/look up/check AND work on/start/fix/build/wrap up/finish): past-perfect ("I have fetched", "I have started fixing it"), bare past-tense ("I fetched", "I started on it"), present-continuous with subject ("I\'m fetching now", "I\'m checking", "I\'m working on it", "I\'m fixing it"), bare present-participle without subject ("Fetching latest info", "Looking it up", "Working on it", "Wrapping it up"), and "please hold" / "give me a sec" / "be right back" / "almost done" style stalling phrases.',
	'- messageToUser and REPLY text must NEVER fabricate a failure, error, or interruption that did not actually occur this turn. Do not claim something "glitched", "hiccuped", "broke", "went wrong", "snagged", "errored out", "got cut off", "didn\'t go through", "failed on my end", or invite the user to "give it another go / try that again / ask again" UNLESS a real tool call THIS turn actually returned an error or empty result. If you are choosing NOT to take an action this turn (no tool call in flight), do not invent a malfunction to excuse it: instead either (a) take the correct action (e.g. spawn the coding sub-agent for a build request), or (b) say plainly and truthfully what you can do and ask the user to confirm scope, e.g. "I can build that as a single-file site in its own folder, want me to start?". A fabricated "something glitched, give it another go" is a hallucinated failure and is forbidden when nothing failed.',
].join("\n");

function appendMandatoryPlannerPolicy(instructions: string): string {
	if (
		MANDATORY_PLANNER_POLICY_LINES.every((line) => instructions.includes(line))
	) {
		return instructions;
	}
	return `${instructions}\n\n${MANDATORY_PLANNER_POLICY}`;
}

function renderRoutingHintsBlock(context: ContextObject): string | null {
	if (process.env.ELIZA_PROMPT_COMPRESS === "1") return null;
	const events = context.events;
	if (events && ROUTING_HINTS_MEMO.has(events)) {
		return ROUTING_HINTS_MEMO.get(events) ?? null;
	}
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const event of events ?? []) {
		if (event.type !== "tool" || !("tool" in event)) continue;
		const tool = event.tool as ContextObjectTool;
		const hint = tool.action?.routingHint?.trim();
		if (!hint) continue;
		const key = normalizePlannerToolName(tool.name);
		if (seen.has(key)) continue;
		seen.add(key);
		lines.push(`- ${hint}`);
	}
	const result =
		lines.length === 0 ? null : ["# Routing hints", ...lines].join("\n");
	if (events) {
		ROUTING_HINTS_MEMO.set(events, result);
	}
	return result;
}

/**
 * Collect the tool/action events exposed for the current planner scope. Used
 * to drive the per-turn planner-action grammar emitter (response-grammar.ts)
 * and for sub-planner scoping (parent-action narrowing).
 */
function collectExposedTools(context: ContextObject): ContextObjectTool[] {
	const parentAction =
		typeof context.metadata?.subPlannerParentAction === "string"
			? context.metadata.subPlannerParentAction
			: "";
	const inSubPlanner = parentAction.length > 0;
	const tools: ContextObjectTool[] = [];
	const seen = new Set<string>();

	for (const event of context.events ?? []) {
		if (event.type !== "tool" || !("tool" in event)) {
			continue;
		}
		const tool = event.tool as ContextObjectTool;
		if (!tool.name) {
			continue;
		}
		const parentMatches =
			typeof tool.metadata?.parentAction === "string" &&
			tool.metadata.parentAction === parentAction;
		if (inSubPlanner) {
			if (event.source !== "sub-planner" && !parentMatches) {
				continue;
			}
		} else if (event.source === "sub-planner" || parentMatches) {
			continue;
		}
		const key = normalizePlannerToolName(tool.name);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		tools.push(tool);
	}
	return tools;
}

export function parsePlannerOutput(raw: string | GenerateTextResult): {
	thought?: string;
	toolCalls: PlannerToolCall[];
	messageToUser?: string;
	raw: Record<string, unknown>;
} {
	if (typeof raw === "string") {
		return parseJsonPlannerOutput(raw);
	}

	const nativeToolCalls = normalizeToolCalls(raw.toolCalls);
	const text = getNonEmptyString(raw.text);

	// Some provider/proxy combinations return planner/evaluator control JSON in
	// the native text channel (e.g. `{"decision":"CONTINUE","thought":...}`)
	// while tool calls are delivered out-of-band. That JSON is control data, not
	// a user-facing message, and must never leak into the channel verbatim. We
	// only treat the text this way when it actually looks like a planner/
	// evaluator envelope — a legitimate non-envelope JSON object reply (e.g. a
	// user asking for `{"foo":"bar"}`) carries no recognized planner field and
	// must fall through to round-trip as `messageToUser`.
	const controlText =
		text && looksLikePlannerControlJson(text)
			? parseJsonPlannerOutput(text)
			: undefined;
	// No native tool calls + the text channel is itself a control envelope:
	// consume it fully through the JSON planner parser so any embedded
	// REPLY/tool-call envelope still works and the raw JSON never reaches the
	// user.
	if (controlText && nativeToolCalls.length === 0) {
		return controlText;
	}

	let textRecoveredCalls: PlannerToolCall[] = [];
	const embeddedToolCalls = parseEmbeddedToolCalls(raw.text);
	const embeddedObjectCount =
		typeof raw.text === "string" ? extractJsonObjects(raw.text).length : 0;
	if (
		embeddedToolCalls.length > 0 &&
		(nativeToolCalls.length === 0 || embeddedObjectCount > 1)
	) {
		textRecoveredCalls = mergeToolCalls(textRecoveredCalls, embeddedToolCalls);
	}
	const toolCalls = mergeToolCalls(nativeToolCalls, textRecoveredCalls);

	return {
		toolCalls,
		// When `raw.text` was itself tool-call/control JSON it is not a
		// user-facing message — take the reply from a REPLY call, or the
		// control envelope's own `messageToUser`, rather than leaking the raw
		// JSON blob into the channel.
		messageToUser:
			textRecoveredCalls.length > 0
				? terminalMessageFromToolCalls(toolCalls)
				: controlText
					? controlText.messageToUser
					: text,
		thought: controlText?.thought,
		raw: {
			text: raw.text,
			toolCalls: raw.toolCalls,
			...(controlText ? { parsedText: controlText.raw } : {}),
		} as Record<string, unknown>,
	};
}

/**
 * True when `text` is a planner/evaluator CONTROL envelope that must be
 * consumed as data rather than surfaced to the user. This is narrow on
 * purpose: a bare user-requested JSON object (e.g. `{"foo":"bar"}`) carries no
 * recognized planner field, returns `false`, and is preserved as a visible
 * reply. Recognized either by the strict evaluator-envelope shape or by a
 * top-level planner field (`action` / `toolCalls` / `messageToUser` / `text` /
 * `decision`).
 */
function looksLikePlannerControlJson(text: string): boolean {
	if (looksLikeEvaluatorEnvelopeJson(text)) return true;
	const parsed = parseJsonObject<RawPlannerOutput & { decision?: unknown }>(
		text.trim(),
	);
	if (!parsed) return false;
	return (
		parsed.action !== undefined ||
		parsed.toolCalls !== undefined ||
		parsed.messageToUser !== undefined ||
		parsed.text !== undefined ||
		parsed.decision !== undefined
	);
}

function parseJsonPlannerOutput(raw: string): {
	thought?: string;
	toolCalls: PlannerToolCall[];
	messageToUser?: string;
	raw: Record<string, unknown>;
} {
	const trimmed = raw.trim();
	const repaired = appendMissingJsonObjectClosers(trimmed);
	const parsed =
		parseJsonObject<RawPlannerOutput>(trimmed) ??
		(repaired === trimmed ? null : parseJsonObject<RawPlannerOutput>(repaired));
	if (!parsed) {
		// Non-JSON output: a weak model emitted prose and/or `<tool_call>` markup
		// instead of the planner envelope. Recover the call it meant to make and
		// strip the markup from the user-facing text instead of leaking it.
		return {
			toolCalls: recoverEmbeddedToolCalls(trimmed),
			messageToUser: sanitizePlannerMessage(trimmed),
			raw: { text: trimmed },
		};
	}
	let messageToUser = sanitizePlannerMessage(
		parsed.messageToUser ?? parsed.text,
	);
	const toolCalls = normalizeToolCalls(parsed.toolCalls);
	const bareActionCalls =
		toolCalls.length === 0 ? normalizeBarePlannerAction(parsed) : [];
	let resolvedCalls = toolCalls.length > 0 ? toolCalls : bareActionCalls;
	if (resolvedCalls.length === 0) {
		const messageToolCalls = recoverMessageFieldToolCalls(
			parsed.messageToUser ?? parsed.text,
		);
		if (messageToolCalls.length > 0) {
			resolvedCalls = messageToolCalls;
			messageToUser = undefined;
		}
	}
	// `parseJsonObject` only returns the FIRST top-level object, so a weak
	// model that concatenated bare `{type, args}` calls — or emitted native
	// `<tool_call>` markup — would lose every call. Recover the full set from
	// the raw string.
	if (resolvedCalls.length === 0) {
		resolvedCalls = recoverEmbeddedToolCalls(trimmed);
	}
	return {
		thought: typeof parsed.thought === "string" ? parsed.thought : undefined,
		toolCalls: resolvedCalls,
		messageToUser,
		raw: parsed as Record<string, unknown>,
	};
}

function appendMissingJsonObjectClosers(text: string): string {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of text) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = inString;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) {
			continue;
		}
		if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
		}
	}
	if (depth <= 0 || depth > 4 || inString) {
		return text;
	}
	return `${text}${"}".repeat(depth)}`;
}

async function callPlanner(params: {
	runtime: PlannerRuntime;
	context: ContextObject;
	trajectory: PlannerTrajectory;
	config: ChainingLoopConfig;
	modelType?: TextGenerationModelType;
	provider?: string;
	tools?: ToolDefinition[];
	toolChoice?: ToolChoice;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	providerAttributionState?: PlannerLoopParams["providerAttributionState"];
	iteration?: number;
	/**
	 * Side-channel observer called once per model call with the gross
	 * `promptTokens` reported by the provider. Used by `runPlannerLoop`
	 * to enforce `ChainingLoopConfig.maxTrajectoryPromptTokens` without
	 * changing this function's return type. Errors thrown from the
	 * callback (e.g. `TrajectoryLimitExceeded`) propagate to the loop.
	 */
	onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}): Promise<ReturnType<typeof parsePlannerOutput>> {
	let renderedInput = renderPlannerModelInput({
		context: params.context,
		trajectory: params.trajectory,
		template: resolveOptimizedPlannerTemplate(params.runtime),
		runtime: params.runtime,
		maxToolResultChars: params.config.compactionMaxKeptStepChars,
	});
	let modelInputBudget = buildModelInputBudget({
		messages: renderedInput.messages,
		promptSegments: renderedInput.promptSegments,
		tools: params.tools,
		// `modelName` lets the per-model context-window lookup fire.
		// The lookup result wins over contextWindowTokens (see buildModelInputBudget
		// resolution order). Note: contextWindowTokens defaults to 128_000 so the
		// spread is always non-empty; the lookup will still override it when
		// contextWindowModelName resolves.
		modelName: params.config.contextWindowModelName,
		...(params.config.contextWindowTokens
			? { contextWindowTokens: params.config.contextWindowTokens }
			: {}),
		reserveTokens: compactionReserveForBudget(params.config),
	});
	if (modelInputBudget.shouldCompact && params.config.compactionEnabled) {
		const compacted = await maybeCompactPlannerTrajectory({
			trajectory: params.trajectory,
			budget: modelInputBudget,
			config: params.config,
			recorder: params.recorder,
			trajectoryId: params.trajectoryId,
			parentStageId: params.parentStageId,
			iteration: params.iteration ?? 1,
			logger: params.runtime.logger,
		});
		if (compacted) {
			renderedInput = renderPlannerModelInput({
				context: params.trajectory.context,
				trajectory: params.trajectory,
				template: resolveOptimizedPlannerTemplate(params.runtime),
				runtime: params.runtime,
				maxToolResultChars: params.config.compactionMaxKeptStepChars,
			});
			modelInputBudget = buildModelInputBudget({
				messages: renderedInput.messages,
				promptSegments: renderedInput.promptSegments,
				tools: params.tools,
				modelName: params.config.contextWindowModelName,
				...(params.config.contextWindowTokens
					? { contextWindowTokens: params.config.contextWindowTokens }
					: {}),
				reserveTokens: compactionReserveForBudget(params.config),
			});
		}
	}
	const prefixHashes = computePrefixHashes(renderedInput.promptSegments);
	const cachePrefixHashes = computePrefixHashes(
		cachePrefixSegments(renderedInput.promptSegments),
	);
	const prefixHash =
		cachePrefixHashes[cachePrefixHashes.length - 1]?.hash ??
		"no-context-segments";
	const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
	const modelParams: {
		messages: ChatMessage[];
		responseSchema?: unknown;
		promptSegments: PromptSegment[];
		providerOptions: Record<string, unknown>;
		tools?: ToolDefinition[];
		toolChoice?: ToolChoice;
		responseSkeleton?: ResponseSkeleton;
		grammar?: string;
		spanSamplerPlan?: SpanSamplerPlan;
		maxTokens?: number;
	} = {
		messages: renderedInput.messages,
		promptSegments: renderedInput.promptSegments,
		providerOptions: withModelInputBudgetProviderOptions(
			cacheProviderOptions({
				prefixHash,
				segmentHashes: prefixHashes.map((entry) => entry.segmentHash),
				promptSegments: renderedInput.promptSegments,
				provider: params.provider,
				hasTools,
				conversationId: params.trajectoryId,
			}),
			modelInputBudget,
		),
		// Chat planner turns stay at the small DEFAULT_PLANNER_MAX_TOKENS; a coding
		// turn must be able to emit a whole file in one tool call, so coding mode
		// raises the cap (see resolvePlannerMaxTokens / issue #10132).
		maxTokens: resolvePlannerMaxTokens(),
	};
	modelParams.providerOptions = {
		...modelParams.providerOptions,
		eliza: {
			...((modelParams.providerOptions as { eliza?: Record<string, unknown> })
				.eliza ?? {}),
			thinking: "off",
		},
	};
	if (hasTools) {
		modelParams.tools = params.tools;
		// Force a native tool call. With actions exposed directly as tools,
		// every viable planner outcome —
		// invoking an action, calling REPLY for a final message, or terminating
		// via IGNORE / STOP — corresponds to a tool. There is no "the model
		// shouldn't tool-call" case left, so `"required"` is the contract.
		// Models that can't comply fail loudly; we don't degrade to text mode.
		modelParams.toolChoice = params.toolChoice ?? "required";
		// Per-turn structure forcing for the PLAN_ACTIONS args: pin `action` to
		// the exact enum of actions exposed this turn and carry each action's
		// normalized parameter schema so the local engine (W4) can do the
		// second constrained pass (`parameters` against the chosen action's
		// schema). Cloud adapters may ignore local structured-output hints like
		// `responseSkeleton`, `grammar`, and
		// `providerOptions.eliza.plannerActionSchemas`; `tools` carries the
		// equivalent portable contract for them.
		const exposedTools = collectExposedTools(params.context);
		const plannerActions = exposedTools.map((tool) => ({
			name: tool.name,
			parameters: tool.action?.parameters ?? [],
			allowAdditionalParameters:
				tool.action?.allowAdditionalParameters === true,
		}));
		// Always use the per-action union grammar (P2-4) for the local engine:
		// the GBNF root is the alternation of per-action branches, each with
		// literal action name + a sub-grammar for that action's parameter
		// shape. Chosen `action` and parameter shape are co-determined by the
		// grammar in one call; the `validate-tool-args.ts` re-plan round
		// is skipped when the model lands inside the strict grammar.
		// Cloud adapters can use `tools` carrying the same schemas if they do not
		// honor local skeleton/grammar hints.
		const plannerActionGrammar =
			buildPlannerActionGrammarStrict(plannerActions);
		if (plannerActionGrammar) {
			modelParams.responseSkeleton = plannerActionGrammar.responseSkeleton;
			modelParams.grammar = plannerActionGrammar.grammar;
			// Per-span argmax sampling for the planner envelope: the `action`
			// enum span gets temperature=0 / topK=1 so the model never randomly
			// picks the minority action under non-zero call-level temperature.
			// `parameters` (free-json) and `thought` (free-string) keep the
			// call-level sampler. Engines that don't honor per-span sampling
			// ignore the field (grammar still constrains the same tokens).
			modelParams.spanSamplerPlan = buildSpanSamplerPlan(
				plannerActionGrammar.responseSkeleton,
			);
			modelParams.providerOptions = {
				...(modelParams.providerOptions as Record<string, unknown>),
				eliza: {
					...((
						modelParams.providerOptions as { eliza?: Record<string, unknown> }
					)?.eliza ?? {}),
					plannerActionSchemas: plannerActionGrammar.actionSchemas,
				},
			};
			// Guided structured decode on by default for the planner pass that
			// carries a forced PLAN_ACTIONS skeleton: the local engine derives the
			// deterministic-token prefill plan and the fork fast-forwards the forced
			// scaffold. Opt out with `ELIZA_LOCAL_GUIDED_DECODE=0`. Cloud adapters
			// ignore `providerOptions.eliza.guidedDecode`.
			withGuidedDecodeProviderOptions(modelParams.providerOptions);
		}
	} else {
		modelParams.responseSchema = plannerSchema;
	}

	const startedAt = Date.now();
	const modelType = params.modelType ?? ModelType.ACTION_PLANNER;
	const streamingContext = getStreamingContext();
	const raw = await runWithStreamingContext(
		streamingContext
			? {
					...streamingContext,
					onStreamChunk: async () => undefined,
				}
			: undefined,
		() => params.runtime.useModel(modelType, modelParams, params.provider),
	);
	const endedAt = Date.now();

	const parsed = parsePlannerOutput(raw);

	// Notify the cumulative-token observer first, BEFORE recording, so the
	// loop's `maxTrajectoryPromptTokens` guard fires immediately on the call
	// that crossed the line — not after we've already done another iteration
	// of bookkeeping. The recorder is observability and can tolerate the
	// minor reordering; the budget guard is load-bearing.
	//
	// CONSEQUENCE for trajectory consumers: when `observePlannerUsage` throws
	// `TrajectoryLimitExceeded(kind: "trajectory_token_budget")` the call
	// that crossed the line is intentionally **not** recorded as a planner
	// stage. The trajectory then ends one stage short of the actual model
	// activity. Downstream consumers that reconstruct totals from recorded
	// stages (the trajectory CLI cost report, cost-regression dashboards)
	// should treat the loop-level `metrics.totalPromptTokens` (populated by
	// the recorder on `endTrajectory`) as authoritative rather than summing
	// stage-level usages.
	if (params.onUsage) {
		const usage = extractUsage(raw);
		if (usage) {
			params.onUsage({
				promptTokens: usage.promptTokens,
				completionTokens: usage.completionTokens,
			});
		}
	}

	await recordPlannerStage({
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: params.parentStageId,
		iteration: params.iteration ?? 1,
		modelType,
		provider: params.provider,
		modelParams,
		raw,
		parsed,
		startedAt,
		endedAt,
		segmentHashes: prefixHashes.map((entry) => entry.segmentHash),
		prefixHash,
		logger: params.runtime.logger,
		providerAttributionState: params.providerAttributionState,
	});

	return parsed;
}

async function maybeCompactPlannerTrajectory(args: {
	trajectory: PlannerTrajectory;
	budget: ModelInputBudget;
	config: ChainingLoopConfig;
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	logger?: PlannerRuntime["logger"];
}): Promise<boolean> {
	const keepSteps = Math.max(0, Math.floor(args.config.compactionKeepSteps));
	const compactableStepCount = Math.max(
		0,
		args.trajectory.steps.length - keepSteps,
	);
	if (compactableStepCount === 0) {
		args.logger?.debug?.(
			{
				estimatedInputTokens: args.budget.estimatedInputTokens,
				compactionThresholdTokens: args.budget.compactionThresholdTokens,
				stepCount: args.trajectory.steps.length,
				keepSteps,
			},
			"Planner input crossed compaction threshold but no old steps are compactable",
		);
		return false;
	}

	const startedAt = Date.now();
	const compactedSteps = args.trajectory.steps.slice(0, compactableStepCount);
	const keptSteps = args.trajectory.steps.slice(compactableStepCount);
	const summary = buildCompactionSummary({
		compactedSteps,
		keptSteps,
		budget: args.budget,
	});
	args.trajectory.archivedSteps.push(...compactedSteps);
	args.trajectory.steps = keptSteps;
	args.trajectory.context = appendContextEvent(args.trajectory.context, {
		id: `compaction:${args.iteration}:${startedAt}`,
		type: "segment",
		source: "planner-loop",
		createdAt: startedAt,
		metadata: {
			reason: "input_budget",
			iteration: args.iteration,
			compactedStepCount: compactableStepCount,
			keptStepCount: keptSteps.length,
			estimatedInputTokens: args.budget.estimatedInputTokens,
			contextWindowTokens: args.budget.contextWindowTokens,
			reserveTokens: args.budget.reserveTokens,
			compactionThresholdTokens: args.budget.compactionThresholdTokens,
		},
		segment: {
			id: `compaction:${args.iteration}:${startedAt}`,
			label: "compaction",
			content: summary,
			stable: false,
			metadata: {
				reason: "input_budget",
				iteration: args.iteration,
				compactedStepCount: compactableStepCount,
				keptStepCount: keptSteps.length,
			},
		},
	});
	const endedAt = Date.now();
	await recordCompactionStage({
		recorder: args.recorder,
		trajectoryId: args.trajectoryId,
		parentStageId: args.parentStageId,
		iteration: args.iteration,
		startedAt,
		endedAt,
		summary,
		budget: args.budget,
		compactedStepCount: compactableStepCount,
		keptStepCount: keptSteps.length,
		logger: args.logger,
	});
	return true;
}

async function maybeCompactBeforeNextModelCall(args: {
	trajectory: PlannerTrajectory;
	config: ChainingLoopConfig;
	tools?: ToolDefinition[];
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	logger?: PlannerRuntime["logger"];
}): Promise<boolean> {
	if (!args.config.compactionEnabled) {
		return false;
	}
	const renderedInput = renderPlannerModelInput({
		context: args.trajectory.context,
		trajectory: args.trajectory,
		maxToolResultChars: args.config.compactionMaxKeptStepChars,
	});
	const budget = buildModelInputBudget({
		messages: renderedInput.messages,
		promptSegments: renderedInput.promptSegments,
		tools: args.tools,
		modelName: args.config.contextWindowModelName,
		...(args.config.contextWindowTokens
			? { contextWindowTokens: args.config.contextWindowTokens }
			: {}),
		reserveTokens: compactionReserveForBudget(args.config),
	});
	if (!budget.shouldCompact) {
		return false;
	}
	return maybeCompactPlannerTrajectory({
		trajectory: args.trajectory,
		budget,
		config: args.config,
		recorder: args.recorder,
		trajectoryId: args.trajectoryId,
		parentStageId: args.parentStageId,
		iteration: args.iteration,
		logger: args.logger,
	});
}

function buildCompactionSummary(args: {
	compactedSteps: readonly PlannerStep[];
	keptSteps: readonly PlannerStep[];
	budget: ModelInputBudget;
}): string {
	const lines = [
		"Compacted prior planner trajectory steps because estimated input approached the model context window.",
		`compacted_steps: ${args.compactedSteps.length}`,
		`kept_recent_steps_verbatim: ${args.keptSteps.length}`,
		`estimated_input_tokens_before_compaction: ${args.budget.estimatedInputTokens}`,
		`compaction_threshold_tokens: ${args.budget.compactionThresholdTokens}`,
		"",
		"Compacted step summaries:",
	];
	for (const step of args.compactedSteps) {
		lines.push(`- ${summarizePlannerStep(step)}`);
	}
	return lines.join("\n").trim();
}

function summarizePlannerStep(step: PlannerStep): string {
	const name = step.toolCall?.name ?? (step.terminalOnly ? "terminal" : "step");
	const status = step.result
		? step.result.success
			? "success"
			: "failed"
		: "no_result";
	const args =
		step.toolCall?.params && Object.keys(step.toolCall.params).length > 0
			? ` args=${compactText(stringifyForModel(step.toolCall.params), 180)}`
			: "";
	const result = step.result
		? ` result=${compactText(toolMessageContent(step.result), 360)}`
		: step.terminalMessage
			? ` message=${compactText(step.terminalMessage, 240)}`
			: "";
	return `iter ${step.iteration} ${name} ${status}${args}${result}`;
}

function compactText(value: string, maxLength: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length <= maxLength) {
		return text;
	}
	const headLength = Math.max(20, Math.floor(maxLength * 0.65));
	const tailLength = Math.max(20, maxLength - headLength - 24);
	return `${text.slice(0, headLength)} ...[${text.length - headLength - tailLength} chars compacted]... ${text.slice(-tailLength)}`;
}

/**
 * Synthesized recorder stage for the gated path. Emits a `kind: "evaluation"`
 * entry so the recorder timeline shows the iteration's outcome on the same
 * slot a model-produced evaluation would have occupied. The stage carries
 * `gated: true`, `llmCallSkipped: true`, and `reason: "explicit_terminal_reply"`
 * so replay/debug tools can distinguish gated decisions from real evaluator
 * calls without a string-match against the thought marker. No `model` block
 * is included — no LLM call happened.
 */
async function recordGatedEvaluationStage(args: {
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	startedAt: number;
	endedAt: number;
	output: EvaluatorOutput;
	reason?: string;
	logger?: PlannerRuntime["logger"];
}): Promise<void> {
	if (!args.recorder || !args.trajectoryId) return;
	try {
		const stage: RecordedStage = {
			stageId: `stage-eval-iter-${args.iteration}-${args.startedAt}-gated`,
			kind: "evaluation",
			iteration: args.iteration,
			parentStageId: args.parentStageId,
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			evaluation: {
				success: args.output.success,
				decision: args.output.decision,
				thought: args.output.thought,
				messageToUser: args.output.messageToUser,
				gated: true,
				llmCallSkipped: true,
				reason: args.reason ?? "explicit_terminal_reply",
			},
		};
		await args.recorder.recordStage(args.trajectoryId, stage);
	} catch (err) {
		args.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record gated evaluation stage",
		);
	}
}

async function recordCompactionStage(args: {
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	startedAt: number;
	endedAt: number;
	summary: string;
	budget: ModelInputBudget;
	compactedStepCount: number;
	keptStepCount: number;
	logger?: PlannerRuntime["logger"];
}): Promise<void> {
	if (!args.recorder || !args.trajectoryId) return;
	try {
		const stage: RecordedStage = {
			stageId: `stage-compaction-iter-${args.iteration}-${args.startedAt}`,
			kind: "compaction",
			iteration: args.iteration,
			parentStageId: args.parentStageId,
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			tool: {
				name: "CONTEXT_COMPACTION",
				args: {
					reason: "input_budget",
					estimatedInputTokens: args.budget.estimatedInputTokens,
					contextWindowTokens: args.budget.contextWindowTokens,
					reserveTokens: args.budget.reserveTokens,
					compactionThresholdTokens: args.budget.compactionThresholdTokens,
				},
				result: {
					summary: args.summary,
					compactedStepCount: args.compactedStepCount,
					keptStepCount: args.keptStepCount,
				},
				success: true,
				durationMs: args.endedAt - args.startedAt,
			},
		};
		await args.recorder.recordStage(args.trajectoryId, stage);
	} catch (err) {
		args.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record compaction stage",
		);
	}
}

async function recordPlannerStage(args: {
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	iteration: number;
	modelType: TextGenerationModelType;
	provider?: string;
	modelParams: {
		messages?: ChatMessage[];
		tools?: ToolDefinition[];
		toolChoice?: ToolChoice;
		providerOptions?: Record<string, unknown>;
	};
	raw: string | GenerateTextResult;
	parsed: ReturnType<typeof parsePlannerOutput>;
	startedAt: number;
	endedAt: number;
	segmentHashes: string[];
	prefixHash: string;
	providerAttributionState?: PlannerLoopParams["providerAttributionState"];
	logger?: PlannerRuntime["logger"];
}): Promise<void> {
	if (!args.recorder || !args.trajectoryId) return;

	try {
		const responseText =
			typeof args.raw === "string" ? args.raw : args.raw.text;
		const usage = extractUsage(args.raw);
		const finishReason = extractFinishReason(args.raw);
		const modelName = extractModelName(args.raw);
		// Flatten `messages` only to locate provider spans; the flattened form is
		// not persisted — `messages` is the canonical record and spans index into
		// `flattenTrajectoryMessages(messages)` reconstructed at read time.
		const providerAttribution = buildProviderAttributionsFromState({
			state: args.providerAttributionState,
			prompt: flattenTrajectoryMessages(args.modelParams.messages),
		});
		const stage: RecordedStage = {
			stageId: `stage-planner-iter-${args.iteration}-${args.startedAt}`,
			kind: "planner",
			iteration: args.iteration,
			parentStageId: args.parentStageId,
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			model: {
				modelType: String(args.modelType),
				modelName,
				provider: args.provider ?? "default",
				messages: args.modelParams.messages,
				tools: args.modelParams.tools,
				toolChoice: args.modelParams.toolChoice,
				providerOptions: args.modelParams.providerOptions,
				response: responseText,
				toolCalls: args.parsed.toolCalls.map<RecordedToolCall>((tc) => ({
					id: tc.id,
					name: tc.name,
					args: tc.params,
				})),
				usage,
				finishReason,
				costUsd: usage ? computeCallCostUsd(modelName, usage) : undefined,
				providerOrder: providerAttribution.providerOrder,
				providerAttributions: providerAttribution.providerAttributions,
			},
			cache: {
				segmentHashes: args.segmentHashes,
				prefixHash: args.prefixHash,
			},
		};
		await args.recorder.recordStage(args.trajectoryId, stage);
	} catch (err) {
		args.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record planner stage",
		);
	}
}

function extractUsage(
	raw: string | GenerateTextResult,
): RecordedUsage | undefined {
	if (typeof raw === "string") return undefined;
	if (!raw.usage) return undefined;
	const usage = raw.usage;
	const promptTokens = usage.promptTokens;
	const completionTokens = usage.completionTokens;
	const totalTokens = usage.totalTokens;
	const out: RecordedUsage = {
		promptTokens,
		completionTokens,
		totalTokens,
	};
	const cacheRead = usage.cacheReadInputTokens;
	if (typeof cacheRead === "number") {
		out.cacheReadInputTokens = cacheRead;
	} else {
		// Fall back to OpenAI plugin's `cachedPromptTokens` shape, which adapters
		// emitted before the shared schema landed.
		const cachedPrompt =
			"cachedPromptTokens" in usage ? usage.cachedPromptTokens : undefined;
		if (typeof cachedPrompt === "number") {
			out.cacheReadInputTokens = cachedPrompt;
		}
	}
	const cacheCreation = usage.cacheCreationInputTokens;
	if (typeof cacheCreation === "number") {
		out.cacheCreationInputTokens = cacheCreation;
	}
	return out;
}

function extractFinishReason(
	raw: string | GenerateTextResult,
): string | undefined {
	if (typeof raw === "string") return undefined;
	return raw.finishReason;
}

function extractModelName(
	raw: string | GenerateTextResult,
): string | undefined {
	if (typeof raw === "string") return undefined;
	const meta = raw.providerMetadata;
	if (meta && typeof meta === "object") {
		const direct = (meta as Record<string, unknown>).modelName;
		if (typeof direct === "string") return direct;
		const model = (meta as Record<string, unknown>).model;
		if (typeof model === "string") return model;
	}
	return undefined;
}

async function evaluateTrajectory(
	params: PlannerLoopParams,
	trajectory: PlannerTrajectory,
	iteration: number,
): Promise<EvaluatorOutput> {
	if (params.evaluate) {
		return params.evaluate({
			runtime: params.runtime,
			context: trajectory.context,
			trajectory,
		});
	}

	return runEvaluator({
		runtime: params.runtime,
		context: trajectory.context,
		trajectory,
		effects: params.evaluatorEffects,
		recorder: params.recorder,
		trajectoryId: params.trajectoryId,
		parentStageId: params.parentStageId,
		iteration,
	});
}

function appendEvaluationEvent(args: {
	context: ContextObject;
	iteration: number;
	evaluator: EvaluatorOutput;
}): ContextObject {
	const createdAt = Date.now();
	return appendContextEvent(args.context, {
		id: `evaluation:${args.iteration}:${createdAt}`,
		type: "evaluation",
		source: "planner-loop",
		createdAt,
		metadata: {
			iteration: args.iteration,
			success: args.evaluator.success,
			decision: args.evaluator.decision,
			thought: args.evaluator.thought,
			messageToUser: args.evaluator.messageToUser,
			recommendedToolCallId: args.evaluator.recommendedToolCallId,
		},
	});
}

function appendEvaluatorContextEvent(
	trajectory: PlannerTrajectory,
	evaluator: EvaluatorOutput,
	iteration: number,
): void {
	trajectory.context = appendEvaluationEvent({
		context: trajectory.context,
		iteration,
		evaluator,
	});
}

function appendTerminalPlannerOutputEvent(args: {
	context: ContextObject;
	iteration: number;
	message?: string;
}): ContextObject {
	const createdAt = Date.now();
	const unsafe = isUnsafeUserVisibleText(args.message);
	const content = [
		"planner_terminal_output:",
		compactText(args.message ?? "", 1_200),
		"",
		unsafe
			? "note: This output looked like internal planning or attempted tool-call text. It must not be shown directly to the user."
			: "note: Evaluate whether this user-visible output actually completes the request.",
	].join("\n");
	return appendContextEvent(args.context, {
		id: `terminal-planner-output:${args.iteration}:${createdAt}`,
		type: "segment",
		source: "planner-loop",
		createdAt,
		metadata: {
			iteration: args.iteration,
			unsafe,
		},
		segment: {
			id: `terminal-planner-output:${args.iteration}:${createdAt}`,
			label: "terminal_planner_output",
			content,
			stable: false,
			metadata: {
				iteration: args.iteration,
				unsafe,
			},
		},
	});
}

function appendTerminalContinuationEvent(args: {
	context: ContextObject;
	iteration: number;
	terminalOnlyContinuations: number;
	message?: string;
}): ContextObject {
	const createdAt = Date.now();
	const unsafe = isUnsafeUserVisibleText(args.message);
	const content = [
		"planner_retry_instruction:",
		`terminal_only_continuations: ${args.terminalOnlyContinuations}`,
		unsafe
			? "The previous planner output exposed internal tool planning. Emit native toolCalls for remaining work, or a concise user-safe message only if the request is complete."
			: "The evaluator found the previous terminal planner output partial. Emit native toolCalls for remaining work.",
		'If the user asked you to save, schedule, send, update, remember, or complete something, do not answer with "saved", "done", or similar prose unless a tool call result proves the side effect happened.',
	].join("\n");
	return appendContextEvent(args.context, {
		id: `terminal-planner-retry:${args.iteration}:${createdAt}`,
		type: "segment",
		source: "planner-loop",
		createdAt,
		metadata: {
			iteration: args.iteration,
			terminalOnlyContinuations: args.terminalOnlyContinuations,
			unsafe,
		},
		segment: {
			id: `terminal-planner-retry:${args.iteration}:${createdAt}`,
			label: "planner_retry_instruction",
			content,
			stable: false,
			metadata: {
				iteration: args.iteration,
				terminalOnlyContinuations: args.terminalOnlyContinuations,
				unsafe,
			},
		},
	});
}

function appendUnavailableToolCallEvent(args: {
	context: ContextObject;
	iteration: number;
	invalidToolCalls: readonly PlannerToolCall[];
	tools?: ToolDefinition[];
}): ContextObject {
	const createdAt = Date.now();
	const exposed = Array.from(exposedToolNameSet(args.tools) ?? []).sort();
	const invalid = args.invalidToolCalls.map((toolCall) => toolCall.name);
	const content = [
		"planner_retry_instruction:",
		`unavailable_tool_calls: ${JSON.stringify(invalid)}`,
		`available_tools: ${JSON.stringify(exposed)}`,
		"The previous planner output called tools that were not exposed for this turn. Retry using only available_tools, or return a terminal REPLY if no exposed tool fits.",
	].join("\n");
	return appendContextEvent(args.context, {
		id: `unavailable-tool-call-retry:${args.iteration}:${createdAt}`,
		type: "instruction",
		source: "planner-loop",
		createdAt,
		content,
		metadata: {
			iteration: args.iteration,
			invalidToolCalls: invalid,
			availableTools: exposed,
		},
	});
}

function appendSilentFailedFinishRecoveryEvent(args: {
	context: ContextObject;
	iteration: number;
	evaluator: EvaluatorOutput;
	trajectory: PlannerTrajectory;
}): ContextObject {
	const createdAt = Date.now();
	const failedStep = latestFailedToolStep(args.trajectory);
	const failedToolName = failedStep?.toolCall?.name;
	const content = [
		"planner_retry_instruction:",
		"silent_failed_finish: true",
		failedToolName ? `failed_tool: ${failedToolName}` : null,
		"The latest tool step failed, and the evaluator finished without a user-visible message. Retry once with a different available approach if possible; otherwise return a concise user-visible blocker instead of ending silently.",
	]
		.filter((line): line is string => line !== null)
		.join("\n");
	return appendContextEvent(args.context, {
		id: `silent-failed-finish-retry:${args.iteration}:${createdAt}`,
		type: "instruction",
		source: "planner-loop",
		createdAt,
		content,
		metadata: {
			iteration: args.iteration,
			evaluatorDecision: args.evaluator.decision,
			evaluatorSuccess: args.evaluator.success,
			failedToolName,
		},
	});
}

async function executeQueuedToolCall(params: {
	params: PlannerLoopParams;
	trajectory: PlannerTrajectory;
	toolCall: PlannerToolCall;
	iteration: number;
	config: ChainingLoopConfig;
	failures: FailureLike[];
}): Promise<void> {
	assertTrajectoryLimit({
		kind: "tool_calls",
		max: params.config.maxToolCalls,
		observed:
			params.trajectory.steps.filter((step) => step.toolCall).length + 1,
	});

	const streamingContext = getStreamingContext();
	const contextEvent = findToolContextEvent(
		params.trajectory.context,
		params.toolCall,
	);
	await emitStreamingHook(streamingContext, "onToolCall", {
		toolCall: plannerToolCallToStreamingToolCall(params.toolCall, "pending"),
		contextEvent,
		messageId: streamingContext?.messageId,
		metadata: { iteration: params.iteration },
	});

	await params.params.onToolCallEnqueued?.(params.toolCall, {
		iteration: params.iteration,
	});

	const startedAt = Date.now();
	let result: PlannerToolResult;
	try {
		result = await params.params.executeToolCall(params.toolCall, {
			trajectory: params.trajectory,
			iteration: params.iteration,
		});
	} catch (error) {
		result = {
			success: false,
			error,
		};
	}
	const endedAt = Date.now();

	// Parameter-validation rejections from `validateToolArgs` set
	// `result.data.parameterErrors`. A model that keeps the same tool but
	// shuffles its argument shape across retries (e.g. trying `action=create`
	// then `action=spawn_agent` then `action=update`) varies both the error
	// string and the params JSON, so the per-call repeatKey + per-call error
	// message both diverge and `assertRepeatedFailureLimit` never trips —
	// even though the failure category is identical and the model is just
	// hunting for a valid arg shape that does not exist on this action.
	// Collapse parameter-validation failures of a tool to a single canonical
	// signature so the existing repeated-failure guard catches that pattern.
	const isParameterValidationFailure = Array.isArray(
		(result.data as { parameterErrors?: unknown } | undefined)?.parameterErrors,
	);
	const failure = {
		toolName: params.toolCall.name,
		success: result.success,
		error: isParameterValidationFailure
			? "parameter_validation_failed"
			: (result.error ?? diagnosticFailureReason(result)),
		repeatKey: isParameterValidationFailure
			? "parameter_validation"
			: toolFailureRepeatKey(params.toolCall),
	};
	if (!result.success || result.error != null) {
		params.failures.push(failure);
		assertRepeatedFailureLimit({
			failures: params.failures,
			latestFailure: failure,
			maxRepeatedFailures: params.config.maxRepeatedFailures,
		});
	}

	params.trajectory.steps.push({
		iteration: params.iteration,
		toolCall: params.toolCall,
		result,
	});
	params.trajectory.context = {
		...params.trajectory.context,
		plannedQueue: (params.trajectory.context.plannedQueue ?? []).map((entry) =>
			entry.id === params.toolCall.id ||
			(!entry.id && entry.name === params.toolCall.name)
				? {
						...entry,
						status: result.success ? "completed" : "failed",
					}
				: entry,
		),
	};
	params.trajectory.context = appendContextEvent(params.trajectory.context, {
		id: `tool-result:${params.toolCall.id ?? params.toolCall.name}:${endedAt}`,
		type: "tool_result",
		source: "planner-loop",
		createdAt: endedAt,
		metadata: {
			iteration: params.iteration,
			toolCallId: params.toolCall.id,
			name: params.toolCall.name,
			params: stringifyForModel(params.toolCall.params ?? {}),
			result: stringifyForModel(result),
			status: result.success ? "completed" : "failed",
		},
	});

	const exposedTool = params.params.tools?.find(
		(tool) => tool.name === params.toolCall.name,
	);
	await recordToolStage({
		recorder: params.params.recorder,
		trajectoryId: params.params.trajectoryId,
		parentStageId: params.params.parentStageId,
		toolCall: params.toolCall,
		result,
		startedAt,
		endedAt,
		logger: params.params.runtime.logger,
		description: exposedTool?.description,
	});
}

async function recordToolStage(args: {
	recorder?: TrajectoryRecorder;
	trajectoryId?: string;
	parentStageId?: string;
	toolCall: PlannerToolCall;
	result: PlannerToolResult;
	startedAt: number;
	endedAt: number;
	logger?: PlannerRuntime["logger"];
	description?: string;
}): Promise<void> {
	if (!args.recorder || !args.trajectoryId) return;
	try {
		const inputParams = (args.toolCall.params ?? {}) as Record<string, unknown>;
		const io = captureToolStageIO({
			input: inputParams,
			output: args.result,
			error: args.result.error,
		});
		const stage: RecordedStage = {
			stageId: `stage-tool-${args.toolCall.name}-${args.startedAt}`,
			kind: "tool",
			parentStageId: args.parentStageId,
			startedAt: args.startedAt,
			endedAt: args.endedAt,
			latencyMs: args.endedAt - args.startedAt,
			tool: {
				name: args.toolCall.name,
				args: inputParams,
				result: args.result,
				success: args.result.success,
				durationMs: args.endedAt - args.startedAt,
				description: args.description,
				input: io.input,
				output: io.output,
				errorText: io.errorText,
				truncated: io.truncated,
			},
		};
		await args.recorder.recordStage(args.trajectoryId, stage);
	} catch (err) {
		args.logger?.warn?.(
			{ err: (err as Error).message, trajectoryId: args.trajectoryId },
			"[TrajectoryRecorder] failed to record tool stage",
		);
	}
}

function plannerToolCallToStreamingToolCall(
	toolCall: PlannerToolCall,
	status: "pending" | "completed" | "failed",
): ToolCall {
	return {
		id: toolCall.id ?? toolCall.name,
		name: toolCall.name,
		arguments: (toolCall.params ?? {}) as ToolCall["arguments"],
		status,
	};
}

function findToolContextEvent(
	context: ContextObject,
	toolCall: PlannerToolCall,
): ContextEvent | undefined {
	return context.events.find((event) => {
		if (event.type !== "tool" || !("tool" in event)) {
			return false;
		}
		const tool = (event as { tool?: { name?: string } }).tool;
		return tool?.name === toolCall.name;
	});
}

function normalizeToolCalls(value: unknown): PlannerToolCall[] {
	if (value == null || value === "") {
		return [];
	}

	const entries = Array.isArray(value) ? value : [value];
	const calls: PlannerToolCall[] = [];
	for (const entry of entries) {
		const call = normalizeToolCall(entry);
		if (call) {
			calls.push(call);
		}
	}
	return calls;
}

/**
 * Recover tool calls a weak model narrated as JSON text instead of — or in
 * addition to — native tool calls. gpt-oss-class models emit one
 * `{type, args}` object per intended call, concatenated
 * (`{...REPLY...}{...TASKS_SPAWN_AGENT...}`), and the provider's native
 * extraction captures only the first. Each top-level object is normalized
 * through the same `normalizeToolCall` path as native calls, so `{type, args}`,
 * `{action, parameters}`, and `{name, arguments}` shapes resolve identically.
 */
function parseEmbeddedToolCalls(text: string | undefined): PlannerToolCall[] {
	if (!text) {
		return [];
	}
	const calls: PlannerToolCall[] = [];
	for (const objectText of extractJsonObjects(text)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(objectText);
		} catch {
			continue;
		}
		const call = normalizeToolCall(parsed);
		if (call) {
			calls.push(call);
		}
	}
	return calls;
}

function recoverMessageFieldToolCalls(value: unknown): PlannerToolCall[] {
	if (value == null || value === "") {
		return [];
	}
	const parsed =
		typeof value === "string"
			? parseJsonObject<Record<string, unknown>>(value.trim())
			: value;
	const call = normalizeToolCall(parsed);
	return call ? [call] : [];
}

/**
 * Recover tool calls from the model's native `<tool_call>` markup —
 * `<tool_call>ACTION<arg_key>k</arg_key><arg_value>v</arg_value>...</tool_call>`
 * — emitted as text by weak open models (cerebras gpt-oss / zai) that fail to
 * route a structured call. Sibling of {@link parseEmbeddedToolCalls} (which
 * recovers JSON-object calls): same intent — honor the call the model meant to
 * make instead of dropping it and answering blind — for the one serialization
 * that isn't JSON. The same markup is removed from the user-facing message by
 * {@link stripJsonStructuralJunkReply}, so a recovered call never double-shows
 * as prose.
 */
function parseNativeMarkupToolCalls(
	text: string | undefined,
): PlannerToolCall[] {
	if (!text?.includes("<tool_call")) {
		return [];
	}
	const calls: PlannerToolCall[] = [];
	const blockRe = /<tool_call\b[^>]*>([\s\S]*?)(?:<\/tool_call>|$)/gi;
	const argRe =
		/<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
	for (const block of text.matchAll(blockRe)) {
		const body = block[1];
		// The action name is the leading token before the first <arg_key>.
		const name = body.match(/^\s*([A-Za-z][A-Za-z0-9_]*)/)?.[1];
		if (!name) continue;
		const params: Record<string, string> = {};
		for (const arg of body.matchAll(argRe)) {
			const key = arg[1].trim();
			if (key) params[key] = arg[2].trim();
		}
		const call = normalizeToolCall({
			action: name,
			parameters: Object.keys(params).length > 0 ? params : undefined,
		});
		if (call) calls.push(call);
	}
	return calls;
}

/**
 * Recover tool calls a weak model emitted as text — JSON objects first, then
 * the native `<tool_call>` markup — when no structured call was parsed.
 */
function recoverEmbeddedToolCalls(text: string): PlannerToolCall[] {
	const fromJson = parseEmbeddedToolCalls(text);
	return fromJson.length > 0 ? fromJson : parseNativeMarkupToolCalls(text);
}

/**
 * The user-facing planner message with any leaked tool-call / JSON-structural
 * markup removed (see {@link stripJsonStructuralJunkReply}). Applied at the one
 * parse boundary so every downstream consumer of `messageToUser` gets clean
 * text without each having to re-sanitize.
 */
function sanitizePlannerMessage(value: unknown): string | undefined {
	const text = getNonEmptyString(value);
	if (!text) return undefined;
	return getNonEmptyString(stripJsonStructuralJunkReply(text));
}

/**
 * Merge native tool calls with calls recovered from the model's text
 * narration, deduped by normalized name and parameters. Native calls are
 * authoritative and keep their order; text-recovered calls only fill in exact
 * calls the native extraction missed.
 */
function mergeToolCalls(
	native: PlannerToolCall[],
	fromText: PlannerToolCall[],
): PlannerToolCall[] {
	if (fromText.length === 0) {
		return native;
	}
	const callKey = (call: PlannerToolCall) =>
		`${call.name.toUpperCase()}:${JSON.stringify(call.params ?? {})}`;
	const seen = new Set(native.map(callKey));
	const merged = [...native];
	for (const call of fromText) {
		const key = callKey(call);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		merged.push(call);
	}
	return merged;
}

function normalizeBarePlannerAction(
	parsed: RawPlannerOutput,
): PlannerToolCall[] {
	if (typeof parsed.action !== "string" || parsed.action.trim().length === 0) {
		return [];
	}
	const call = normalizeToolCall(parsed);
	if (!call) return [];
	if (
		call.params === undefined &&
		"parameters" in parsed &&
		(parsed.parameters === null ||
			typeof parsed.parameters === "string" ||
			typeof parsed.parameters === "number" ||
			typeof parsed.parameters === "boolean")
	) {
		call.params = { parameters: parsed.parameters };
	}
	return [call];
}

/**
 * Normalize a single raw planner tool call to a `PlannerToolCall`. With actions
 * exposed directly as native tools the tool name IS the action name; the
 * universal terminal sentinels REPLY / IGNORE / STOP arrive under their own
 * names. We accept several legacy adjacent fields (`toolName`, `tool`,
 * `action`, `actionName`, `function`) so provider quirks don't surface as parse
 * failures, but no envelope unwrap or compound-name decoding happens here.
 */

function normalizeToolCall(entry: unknown): PlannerToolCall | null {
	if (typeof entry === "string") {
		const name = normalizeToolCallName(entry);
		return name ? { name } : null;
	}

	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return null;
	}

	const record = entry as ToolCall & Record<string, unknown>;
	const rawFunction =
		record.function && typeof record.function === "object"
			? (record.function as Record<string, unknown>)
			: null;
	const functionName =
		typeof record.function === "string" ? record.function : rawFunction?.name;
	const name = normalizeToolCallName(
		record.name ??
			record.toolName ??
			record.tool ??
			record.action ??
			record.actionName ??
			functionName ??
			// gpt-oss narrates calls as `{type: "ACTION", args: {...}}`. `type`
			// is the last-resort name source so the canonical OpenAI/Anthropic
			// envelope shapes, where `type` is "function"/"tool", still resolve
			// through `functionName`/`name` first.
			record.type ??
			"",
	);
	if (!name) {
		return null;
	}

	const args = stripPlannerControlParams(
		normalizeArgs(
			record.input ??
				record.args ??
				record.arguments ??
				record.params ??
				record.parameters ??
				rawFunction?.input ??
				rawFunction?.args ??
				rawFunction?.arguments ??
				rawFunction?.params ??
				rawFunction?.parameters,
		),
	);

	if (name.toUpperCase() === "PLAN_ACTIONS" && args) {
		const actionName = normalizeToolCallName(args.action);
		if (actionName) {
			return {
				id: typeof record.id === "string" ? record.id : undefined,
				name: actionName,
				params: stripPlannerControlParams(normalizeArgs(args.parameters)) ?? {},
			};
		}
	}

	return {
		id: typeof record.id === "string" ? record.id : undefined,
		name,
		params: args,
	};
}

function stripPlannerControlParams(
	args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!args || typeof args.thought !== "string") {
		return args;
	}
	const { thought: _thought, ...rest } = args;
	return rest;
}

function normalizeToolCallName(value: unknown): string {
	const raw = String(value ?? "").trim();
	if (!raw) return "";
	const withoutPrefix = raw.replace(/^(?:functions?|tools?)\./i, "");
	return withoutPrefix.trim();
}

function normalizeArgs(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		return parseJsonObject<Record<string, unknown>>(value) ?? undefined;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function isTerminalToolCall(toolCall: PlannerToolCall): boolean {
	// REPLY / IGNORE / STOP / NONE are the planner's terminal signals —
	// they mean "I have nothing further to dispatch, end the turn."
	// `NONE` was missing here, so when the planner emitted it after a
	// successful tool call the loop tried to EXECUTE NONE as a real
	// action. NONE's contextGate (`contexts: ["general"]`) commonly
	// fails when the surface narrowed to a non-general tier-A context,
	// the call returned "Action NONE is not allowed in the current
	// context", and the planner retried until hitting the
	// repeated-tool-failure limit — at which point the runtime
	// shipped a generic "something flaked" reply even though the
	// previous action's work had succeeded. Treating NONE as terminal
	// makes the loop stop cleanly instead.
	return ["REPLY", "IGNORE", "STOP", "NONE"].includes(
		toolCall.name.toUpperCase(),
	);
}

function getToolDefinitionName(tool: ToolDefinition): string | undefined {
	const maybeTool = tool as ToolDefinition & {
		function?: { name?: unknown };
		name?: unknown;
	};
	const name = maybeTool.name;
	return typeof name === "string" && name.trim().length > 0
		? name.trim()
		: undefined;
}

function hasExposedNonTerminalTool(
	tools: ToolDefinition[] | undefined,
): boolean {
	return (
		Array.isArray(tools) &&
		tools.some((tool) => {
			const name = getToolDefinitionName(tool);
			return Boolean(name && !isTerminalToolCall({ name }));
		})
	);
}

function hasExecutedNonTerminalTool(trajectory: PlannerTrajectory): boolean {
	return trajectory.steps.some(
		(step) => step.toolCall && !isTerminalToolCall(step.toolCall),
	);
}

function handleRequiredToolPlannerMiss(params: {
	trajectory: PlannerTrajectory;
	iteration: number;
	plannerOutput: ReturnType<typeof parsePlannerOutput>;
	reason: "no_tool_calls" | "terminal_only_tool_calls";
	logger?: PlannerRuntime["logger"];
}): void {
	const createdAt = Date.now();
	params.logger?.warn?.(
		{
			iteration: params.iteration,
			reason: params.reason,
			messageToUser: params.plannerOutput.messageToUser,
			toolCalls: params.plannerOutput.toolCalls.map((toolCall) => ({
				name: toolCall.name,
				id: toolCall.id,
			})),
		},
		"Planner returned terminal output before satisfying a required tool call; retrying",
	);
	params.trajectory.context = appendContextEvent(params.trajectory.context, {
		id: `required-tool-retry:${params.iteration}:${params.reason}`,
		type: "instruction",
		source: "planner-loop",
		createdAt,
		content:
			"The previous planner response was not valid because this turn is tool-required and no non-terminal tool has run yet. " +
			"Retry by calling one exposed non-terminal tool that can attempt the current request. " +
			"After that tool returns, use its result to decide whether to continue or answer the user. " +
			'If the user asked you to save, schedule, send, update, remember, or complete something, do not answer with "saved", "done", or similar prose unless a tool call result proves the side effect happened.',
		metadata: {
			iteration: params.iteration,
			reason: params.reason,
			messageToUser: params.plannerOutput.messageToUser,
			toolCalls: stringifyForModel(params.plannerOutput.toolCalls),
		},
	});
}

// Terminates the planner loop with a captured terminal-only refusal text in
// place of throwing `TrajectoryLimitExceeded({kind: "required_tool_misses"})`.
// Used when Stage 1 asserted `requiresTool=true` but no exposed tool can
// fulfill the request: the planner produces honest REPLY refusals across
// iterations, and surfacing the last one is materially better than the
// generic apology the caller would otherwise emit.
function canonicalParamsString(value: unknown): string {
	// Sorted-key serialization so two logically-identical tool calls that differ
	// only in key insertion order (common across LLM re-emissions) map to the
	// same identity — otherwise the redundant-call loop-breaker never trips.
	return JSON.stringify(value, (_key, val) =>
		val && typeof val === "object" && !Array.isArray(val)
			? Object.fromEntries(
					Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: val,
	);
}

function toolCallIdentity(toolCall: PlannerToolCall): string {
	return `${toolCall.name} ${canonicalParamsString(toolCall.params ?? {})}`;
}

/**
 * Split a set of planned non-terminal calls into those that are genuinely new
 * this turn and those that exactly repeat a call which already SUCCEEDED (same
 * tool name + arguments). A repeat of a successful call cannot return new
 * information, so the loop should not re-execute it.
 */
function partitionRedundantSucceededCalls(
	calls: PlannerToolCall[],
	trajectory: PlannerTrajectory,
): { fresh: PlannerToolCall[]; redundant: PlannerToolCall[] } {
	const succeeded = new Set<string>();
	for (const step of trajectory.steps) {
		if (step.toolCall && step.result?.success === true) {
			succeeded.add(toolCallIdentity(step.toolCall));
		}
	}
	const fresh: PlannerToolCall[] = [];
	const redundant: PlannerToolCall[] = [];
	for (const call of calls) {
		if (succeeded.has(toolCallIdentity(call))) redundant.push(call);
		else fresh.push(call);
	}
	return { fresh, redundant };
}

/**
 * Terminal escape hatch for a planner stuck re-issuing an identical successful
 * call. Makes one `toolChoice: "none"` planner call so the model MUST answer in
 * prose — synthesizing from the tool results already gathered — then returns
 * that as the final message. Bounded (one extra call, no tools) so it cannot
 * itself loop.
 */
async function finishWithForcedSynthesis(params: {
	loop: PlannerLoopParams;
	config: ChainingLoopConfig;
	trajectory: PlannerTrajectory;
	iteration: number;
	onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
}): Promise<PlannerLoopResult> {
	const { loop, config, trajectory, iteration } = params;
	trajectory.context = appendContextEvent(trajectory.context, {
		id: `force-synthesis:${iteration}`,
		type: "instruction",
		source: "planner-loop",
		createdAt: Date.now(),
		content:
			"Tool gathering for this turn is complete and the same call was repeated " +
			"without new results. Do not call any tool. Write the final answer to the " +
			"user now from the tool results already in this trajectory; if they do not " +
			"contain the answer, say plainly what you found and what was missing.",
	});
	const synthOutput = await callPlanner({
		runtime: loop.runtime,
		context: trajectory.context,
		trajectory,
		config,
		modelType: loop.modelType,
		provider: loop.provider,
		// No tools: forces free-text prose across both cloud ("none") and local
		// engines. Passing tools here would re-engage the per-action grammar /
		// responseSkeleton, fighting the "answer in prose, call no tool" intent.
		tools: undefined,
		recorder: loop.recorder,
		trajectoryId: loop.trajectoryId,
		parentStageId: loop.parentStageId,
		providerAttributionState: loop.providerAttributionState,
		iteration,
		onUsage: params.onUsage,
	});
	const finalMessage = preferredFinalMessageFromToolOrModel(
		trajectory,
		synthOutput.messageToUser,
	);
	trajectory.steps.push({
		iteration,
		thought: synthOutput.thought,
		terminalMessage: finalMessage,
		terminalOnly: true,
	});
	return {
		status: "finished",
		trajectory,
		finalMessage: userSafeFinalMessage(finalMessage, trajectory),
	};
}

function finishWithCapturedRefusal(params: {
	trajectory: PlannerTrajectory;
	iteration: number;
	thought: string | undefined;
	refusal: string;
}): {
	status: "finished";
	trajectory: PlannerTrajectory;
	finalMessage: string | undefined;
} {
	params.trajectory.steps.push({
		iteration: params.iteration,
		thought: params.thought,
		terminalMessage: params.refusal,
		terminalOnly: true,
	});
	return {
		status: "finished",
		trajectory: params.trajectory,
		finalMessage: userSafeFinalMessage(params.refusal, params.trajectory),
	};
}

function terminalMessageFromToolCalls(
	toolCalls: PlannerToolCall[],
	fallback?: string,
): string | undefined {
	const reply = toolCalls.find(
		(toolCall) => toolCall.name.toUpperCase() === "REPLY",
	);
	const params = reply?.params;
	return (
		getNonEmptyString(params?.text ?? params?.message ?? params?.reply) ??
		fallback
	);
}

/**
 * Latest user-safe projection of a tool's result, walking the trajectory
 * back-to-front. Returns ONLY the tool's `userFacingText` field — never
 * the diagnostic `text` field, because `text` is log-shaped (shell
 * prompts, exit codes, cwd, byte counts) and leaks the tool's wrapper
 * format into the user channel.
 *
 * Tools that produce real user-facing answers (Q&A, content generation,
 * mutation confirmations, vetted shell projections) must opt in by setting
 * `userFacingText`. Tools that only emit logs (raw shell transcripts, fetchers,
 * file readers) leave it unset; this function then returns undefined and the
 * caller falls through to the evaluator's synthesized reply instead of dumping
 * the log into the channel. The contract is structural: tools declare what is
 * safe to show, the framework never guesses by parsing wrapper text.
 */
function latestToolResultText(
	trajectory: PlannerTrajectory,
): string | undefined {
	for (const step of [...trajectory.steps].reverse()) {
		const text = step.result?.userFacingText?.trim();
		if (text) {
			return text;
		}
	}
	return undefined;
}

/**
 * Deterministic (no model call) relay of the most recent SUCCESSFUL non-terminal
 * tool result. Used when a model call LATER in the turn (the post-tool evaluator
 * synthesis/decision call) fails transiently AFTER a tool already did real work:
 * relay the tool's own truthful output instead of discarding the work and telling
 * the user "something went wrong".
 *
 * Reads ONLY the tool's opt-in `userFacingText`, upholding the same contract as
 * {@link latestToolResultText}: the diagnostic `text`/`summary` fields are
 * log-shaped (shell prompts, exit codes, cwd, raw fetch bodies) and must not be
 * guessed into the user channel. A tool declares its output safe to show by
 * setting `userFacingText` — FILE write/edit do so ("Wrote N bytes to <path>"),
 * as do narrowly vetted shell projections. Raw shell transcripts, fetchers, and
 * file readers leave it unset, so their logs never leak here. Returns undefined
 * when no successful non-terminal tool exposed a user-facing result, so genuine
 * failures still surface.
 */
function deterministicSuccessfulToolRelay(
	trajectory: PlannerTrajectory,
): string | undefined {
	for (const step of [...trajectory.steps].reverse()) {
		if (!step.toolCall || step.result?.success !== true) continue;
		if (isTerminalToolCall(step.toolCall)) continue;
		const candidate = getNonEmptyString(step.result.userFacingText);
		if (candidate) return candidate;
	}
	return undefined;
}

function deterministicTerminalContinuationLimitRelay(
	trajectory: PlannerTrajectory,
): string | undefined {
	return (
		deterministicSuccessfulToolRelay(trajectory) ??
		deterministicNoopClarificationRelay(trajectory)
	);
}

function deterministicNoopClarificationRelay(
	trajectory: PlannerTrajectory,
): string | undefined {
	for (const step of [...trajectory.steps].reverse()) {
		if (!step.toolCall || step.result?.success !== true) continue;
		if (isTerminalToolCall(step.toolCall)) continue;
		if (!hasNoopMarker(step.result)) continue;

		const candidate = sanitizePlannerMessage(
			step.result.userFacingText ?? step.result.text,
		);
		if (candidate && !isUnsafeUserVisibleText(candidate)) return candidate;
	}
	return undefined;
}

function hasNoopMarker(result: PlannerToolResult): boolean {
	const data = result.data;
	if (!data) return false;
	if (data.noop === true) return true;
	const values = data.values;
	return (
		values !== null &&
		typeof values === "object" &&
		!Array.isArray(values) &&
		(values as Record<string, unknown>).noop === true
	);
}

/**
 * Returns the canonical user-facing text from a trajectory whose
 * `verifiedUserFacing` opt-in is unambiguous: exactly one *successful*
 * tool step set `verifiedUserFacing: true` with a non-empty
 * `userFacingText`.
 *
 * Failed steps are intentionally ignored when counting toward the
 * uniqueness check — a plan whose first tool errored and whose second
 * tool emitted a verified canonical reply must still echo the verified
 * reply. (Counting failed steps would silently fall through to the
 * evaluator's `messageToUser`, defeating the whole point of the flag
 * for any tool that runs after a recoverable error.)
 *
 * Tools that emit structured data the evaluator could paraphrase
 * incorrectly (paths, ids, counts, numeric metrics) set the flag so the
 * framework echoes their output verbatim instead of trusting the
 * evaluator's rewording.
 */
// Exported for unit-test coverage of the success-filter / failed-step
// invariant; not part of the public runtime surface.
export function singleVerifiedUserFacingToolResultText(
	trajectory: PlannerTrajectory,
): string | undefined {
	const successfulToolSteps = trajectory.steps.filter(
		(step) => step.toolCall && step.result?.success === true,
	);
	if (successfulToolSteps.length !== 1) return undefined;
	const result = successfulToolSteps[0]?.result;
	if (result?.verifiedUserFacing !== true) return undefined;
	const text = result.userFacingText?.trim();
	return text || undefined;
}

/**
 * Synthesize a short "here's what I did" summary from action-owned result
 * summaries. Used as the LAST-resort fallback for the eliza-code coding
 * sub-agent so it always relays a result — a weak model can edit files
 * correctly then end the turn with no final text, which would otherwise surface
 * as an EMPTY reply even though the work succeeded (observed: a SWE-bench fix
 * applied perfectly but relayed nothing). Returns undefined when no action
 * declared a successful result summary (so chat turns are unaffected).
 */
function codingActionSummary(
	trajectory: PlannerTrajectory,
): string | undefined {
	const parts: string[] = [];
	for (const step of trajectory.steps) {
		if (step.result?.success === false) continue;
		const summary = step.result?.summary?.trim();
		if (summary) {
			parts.push(summary);
		}
	}
	if (parts.length === 0) return undefined;
	const unique = [...new Set(parts)].slice(0, 8);
	const summary = unique.join("; ");
	return `Done — ${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`;
}

/**
 * In coding mode a weak model sometimes ends a successful turn with a junk
 * "reply" — the literal word "None"/"null", or a tool-call emitted as text
 * (`<tool_call>…`, a raw JSON action blob). Treating those as a real
 * user-facing message surfaces garbage to the user even though the build
 * succeeded. Detect them so the caller can fall back to a synthesized summary.
 */
function isJunkCodingReply(text: unknown): boolean {
	if (typeof text !== "string") return true;
	const t = text.trim();
	if (t.length === 0) return true;
	const lower = t.toLowerCase();
	if (
		lower === "none" ||
		lower === "null" ||
		lower === "n/a" ||
		lower === "undefined"
	) {
		return true;
	}
	if (
		/^(<tool_call|<arg_key|<arg_value|```json|\[?\s*\{.*"(action|decision|tool_calls|thought)"\s*:)/.test(
			t,
		)
	) {
		return true;
	}
	return false;
}

/**
 * Strip reasoning-model scaffolding that leaks into a final reply: a
 * `<think>…</think>` block, or a stray closing `</think>` with the chain-of-
 * thought before it (keep only the answer after the last `</think>`). Observed
 * with glm-4.7 on Cerebras: "…Let me verify.</think>I've fixed both validators…".
 */
function stripReasoningArtifacts(text: string): string {
	let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const lastClose = out.toLowerCase().lastIndexOf("</think>");
	if (lastClose >= 0) out = out.slice(lastClose + "</think>".length);
	return out.replace(/<\/?think>/gi, "").trim();
}

/**
 * Coding-mode user-facing reply: strip reasoning artifacts, drop a junk model
 * message, and fall back to a synthesized "what I did" summary — so the
 * eliza-code sub-agent always relays a clean result for successful work
 * (matching a polished coding agent's output).
 */
function codingFinalMessage(
	trajectory: PlannerTrajectory,
	modelMessage: unknown,
): string | undefined {
	const cleaned =
		typeof modelMessage === "string"
			? stripReasoningArtifacts(modelMessage)
			: modelMessage;
	const clean = isJunkCodingReply(cleaned) ? undefined : cleaned;
	return preferredFinalMessageFromToolOrModel(
		trajectory,
		clean,
		codingActionSummary(trajectory),
	);
}

function preferredFinalMessageFromToolOrModel(
	trajectory: PlannerTrajectory,
	modelMessage?: unknown,
	fallback?: unknown,
): string | undefined {
	const modelText = getNonEmptyString(modelMessage);
	const usableModelText =
		modelText && !isToolMetaNarration(modelText) ? modelText : undefined;
	// Precedence:
	//   1. A single successful tool whose result was explicitly marked
	//      `verifiedUserFacing: true` — used for structured outputs
	//      (paths, ids, counts) where evaluator paraphrase risks
	//      hallucinating a value.
	//   2. The model/evaluator's explicit `messageToUser` — authoritative
	//      by default; the evaluator has seen the full trajectory and
	//      chose what the user should read.
	//   3. The most recent tool's `userFacingText` — fallback when neither
	//      the model nor any verified tool provided a clean reply.
	//   4. An explicit caller-provided fallback (e.g. failed-tool message).
	//
	// Regression coverage:
	//   - `planner-loop-user-facing-text.test.ts` → "does not regress
	//     evaluator's explicit messageToUser path" — evaluator wins when
	//     no tool sets `verifiedUserFacing`.
	//   - `planner-happy-path.test.ts` → "prefers a single tool's verified
	//     user-facing text over evaluator paraphrase" — tool wins when it
	//     opts in via `verifiedUserFacing: true`.
	return (
		singleVerifiedUserFacingToolResultText(trajectory) ??
		usableModelText ??
		latestToolResultText(trajectory) ??
		getNonEmptyString(fallback)
	);
}

function isToolMetaNarration(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	return (
		normalized.startsWith("the tool executed successfully") ||
		normalized.startsWith("tool executed successfully") ||
		normalized.startsWith("the tool returned") ||
		/^[a-z0-9_]+(?:\s+[a-z0-9_]+)?\s+was\s+called\b/.test(normalized) ||
		/^[a-z0-9_]+(?:\s+[a-z0-9_]+)?\s+action\s+executed\b/.test(normalized) ||
		/^planner\s+(?:drafted|called|routed|selected)\b/.test(normalized) ||
		normalized.includes(" via owner_goals") ||
		normalized.includes("tool's user-visible") ||
		normalized.includes("planner's user-visible message") ||
		normalized.includes("surface that question") ||
		normalized.includes("surface the draft")
	);
}

function latestFailedToolStep(
	trajectory: PlannerTrajectory,
): PlannerStep | undefined {
	return [...trajectory.steps]
		.reverse()
		.find((step) => step.result && step.result.success === false);
}

function shouldRecoverSilentFailedFinish(args: {
	evaluator: EvaluatorOutput;
	trajectory: PlannerTrajectory;
	recoveryCount: number;
}): boolean {
	if (args.recoveryCount >= 1) return false;
	if (args.evaluator.success !== false) return false;
	if (getNonEmptyString(args.evaluator.messageToUser)) return false;
	return latestFailedToolStep(args.trajectory) !== undefined;
}

function failedToolFallbackMessage(
	trajectory: PlannerTrajectory,
): string | undefined {
	if (!latestFailedToolStep(trajectory)) return undefined;
	return "I tried to complete that, but the available runtime step failed before it produced a usable result.";
}

function exposedToolNameSet(
	tools: ToolDefinition[] | undefined,
): Set<string> | null {
	if (!Array.isArray(tools) || tools.length === 0) return null;
	const names = tools
		.map(getToolDefinitionName)
		.filter((name): name is string => Boolean(name))
		.map((name) => name.toUpperCase());
	return names.length > 0 ? new Set(names) : null;
}

function splitUnavailableToolCalls(
	toolCalls: PlannerToolCall[],
	tools: ToolDefinition[] | undefined,
): { valid: PlannerToolCall[]; invalid: PlannerToolCall[] } {
	const exposed = exposedToolNameSet(tools);
	if (!exposed) return { valid: toolCalls, invalid: [] };
	const valid: PlannerToolCall[] = [];
	const invalid: PlannerToolCall[] = [];
	for (const toolCall of toolCalls) {
		if (exposed.has(toolCall.name.toUpperCase())) {
			valid.push(toolCall);
		} else {
			invalid.push(toolCall);
		}
	}
	return { valid, invalid };
}

function toolFailureRepeatKey(toolCall: PlannerToolCall): string {
	return `${toolCall.name}:${stringifyForModel(toolCall.params ?? {})}`;
}

/**
 * Recover a diagnostic failure reason from a tool result that reported
 * `success:false` but carried no typed `error`. The dominant action
 * convention in this codebase puts the human-readable reason in `text` and a
 * machine code in `data.error` — e.g. SCHEDULED_TASKS returning
 * `{ success:false, text:"I need a trigger (once | cron | ...)", data:{ error:"MISSING_TRIGGER" } }`.
 * The typed `error` field is reserved for thrown `Error`s, so those
 * validation failures reach the failure tracker with `error` unset.
 *
 * Without this recovery, `getFailureSignature` flattens every such failure to
 * the bare literal `"failed"`, so a repeated-failure abort surfaces the
 * useless `SCHEDULED_TASKS:failed` instead of naming what the model got wrong
 * (observed live: the news-heartbeat turn tripped `Repeated tool failure
 * limit exceeded for SCHEDULED_TASKS:failed`). That violates the
 * diagnostic-error doctrine (#14873) — a limit abort must read like a real
 * diagnosis. Prefer the human `text`; fall back to the `data.error` code;
 * return `undefined` only when the result carries no reason at all, which
 * preserves the existing `"failed"` fallback for a truly empty failure.
 *
 * This only makes the signature MORE specific: the repeated-failure guard
 * still discriminates by `repeatKey` (the params JSON), so identical failing
 * calls collapse exactly as before while distinct ones stay distinct.
 */
function diagnosticFailureReason(
	result: PlannerToolResult,
): string | undefined {
	const text = typeof result.text === "string" ? result.text.trim() : "";
	if (text) return text;
	const dataError = (result.data as { error?: unknown } | undefined)?.error;
	if (typeof dataError === "string" && dataError.trim()) {
		return dataError.trim();
	}
	return undefined;
}

/**
 * Decide whether the planner-loop can synthesize a FINISH evaluator output and
 * skip ONLY the in-loop LLM trajectory-decision call (`runEvaluator`) for the
 * current iteration.
 *
 * Scope — what this skips and what it does NOT skip
 * --------------------------------------------------
 * SKIPS: the in-loop `runEvaluator` call (`packages/core/src/runtime/evaluator.ts`),
 * which makes one LLM call to decide FINISH / NEXT_RECOMMENDED / CONTINUE for
 * the planner trajectory.
 *
 * DOES NOT skip: the post-turn registered evaluator step. `runtime.evaluators`
 * are dispatched by `EvaluatorService.run` via `runPostTurnEvaluators`
 * (`packages/core/src/services/evaluator.ts:446`), called from
 * `services/message.ts` AFTER `runPlannerLoop` returns. Those registered
 * evaluators run regardless of how the loop terminated, including via this
 * gate. Memory hooks, telemetry, and `ALWAYS_AFTER` actions in the same
 * end-of-chain block are likewise unaffected.
 *
 * The evaluator's three trajectory-decision outcomes (FINISH, NEXT_RECOMMENDED,
 * CONTINUE) collapse to FINISH/success=true when ALL of the following hold
 * after a tool execution:
 *
 *   1. The just-completed tool result is `success: true`.
 *   2. The plan queue is drained — no tools remain to evaluate.
 *   3. No failures have accumulated (no recent error to investigate).
 *   4. The most-recent planner output supplied an EXPLICIT `messageToUser`
 *      field in its structured output (NOT a fallback inferred from a stray
 *      `text` on a native tool-call return — that path can carry a pre-tool
 *      thought rather than a final answer, which would be unsafe to surface).
 *   5. That `messageToUser` is not a tool/function-syntax leak (the evaluator's
 *      own prompt rules say leaked syntax should force CONTINUE; we honor the
 *      same constraint by reusing `isUnsafeUserVisibleText`).
 *   6. The planner did NOT explicitly set `completed: false` on this output.
 *      When that flag is present and false, the planner is signaling that
 *      this turn's tool calls do not yet achieve the goal (read-then-act,
 *      multi-step deploy, verification pending) — and `messageToUser` is
 *      a pre-tool intent rather than a final answer. We fall through to
 *      the full evaluator so it can decide CONTINUE vs FINISH from the
 *      actual tool result rather than synthesizing a FINISH the planner
 *      explicitly disclaimed. Absent or `true` preserves the gate's
 *      original behavior (backward compat).
 *
 * On any single ambiguity the function returns `null` and the caller falls
 * through to the full evaluator path. Returning a synthesized `EvaluatorOutput`
 * preserves trajectory observability: `appendEvaluationEvent` still records
 * the decision in the context event stream, `trajectory.evaluatorOutputs` still
 * gets the entry, and the loop's return value still carries `evaluator` in the
 * shape consumers (`subPlannerResultToPlannerToolResult` in `services/message.ts`)
 * read — `success` and `messageToUser`. Recorder stage entries for "evaluation"
 * are NOT emitted in the gated case; the recorder timeline shows tool stages
 * only for that iteration.
 *
 * Cost win: roughly 50% of LLM calls on "tool-then-explicit-reply" turns where
 * the planner committed a `messageToUser` field at plan-time. Native-mode
 * native-tool-call returns without an explicit `messageToUser` field do NOT
 * trigger the gate — those calls remain on the full evaluator path.
 */
function tryGateEvaluator(args: {
	trajectory: PlannerTrajectory;
	failures: readonly FailureLike[];
	lastPlannerExplicitMessageToUser: string | undefined;
	lastPlannerExplicitCompleted: boolean | undefined;
}): EvaluatorOutput | null {
	const latestStep = args.trajectory.steps[args.trajectory.steps.length - 1];
	const latestResult = latestStep?.result;
	if (latestResult?.success !== true) return null;
	if (args.trajectory.plannedQueue.length > 0) return null;
	if (args.failures.length > 0) return null;
	const message = args.lastPlannerExplicitMessageToUser?.trim();
	if (!message) return null;
	if (isUnsafeUserVisibleText(message)) return null;
	// Precondition 6: respect the planner's own completion disclaimer.
	if (args.lastPlannerExplicitCompleted === false) return null;

	return {
		success: true,
		decision: "FINISH",
		thought: GATED_EVALUATOR_THOUGHT,
		messageToUser: message,
	};
}

/** Marker the gate stamps onto synthesized EvaluatorOutputs so trajectory
 * dumps and replay tools can identify gated (i.e. evaluator-skipped) decisions
 * cheaply. */
export const GATED_EVALUATOR_THOUGHT =
	"Gated FINISH: queue drained successfully with a clean planner messageToUser; evaluator LLM call skipped.";

const TERMINAL_TOOL_CALL_FINISH_THOUGHT =
	"Terminal FINISH: planner ended the loop with a terminal tool call; evaluator LLM call skipped.";

function terminalToolCallFinish(
	finalMessage: string | undefined,
): EvaluatorOutput {
	const output: EvaluatorOutput = {
		success: true,
		decision: "FINISH",
		thought: TERMINAL_TOOL_CALL_FINISH_THOUGHT,
	};
	if (finalMessage) {
		output.messageToUser = finalMessage;
	}
	return output;
}

function userSafeFinalMessage(
	message: string | undefined,
	trajectory: PlannerTrajectory,
): string | undefined {
	// Strip leaked tool-call / JSON-structural markup before the safety check so
	// a message that is good prose with trailing leaked markup ("...let me look.
	// <tool_call>WEB_FETCH...") becomes clean usable text instead of being
	// rejected wholesale (or worse, sent verbatim when the unsafe-text heuristic
	// doesn't match the markup shape).
	const candidate = sanitizePlannerMessage(message);
	if (candidate && !isUnsafeUserVisibleText(candidate)) {
		return candidate;
	}
	const latest = sanitizePlannerMessage(latestToolResultText(trajectory));
	if (latest && !isUnsafeUserVisibleText(latest)) {
		return latest;
	}
	return candidate ? "I handled the available step." : undefined;
}

// Canonical TASKS/spawn-arg vocabulary. A planner that hallucinates its own
// tool-call arguments into messageToUser leaks a JSON object like
// {"task":"…","agentType":"opencode","approvalPreset":"standard","brief":"…"}.
// Detect it by SHAPE — the reply itself must JSON.parse to an object whose keys
// are a subset of this vocabulary with at least two discriminators — never by
// matching the user's words. Real prose cannot JSON.parse to this object, and a
// genuine user-requested JSON answer carries foreign keys, so this never fires
// on a real reply.
const SPAWN_ARG_KEYS = new Set([
	"task",
	"agentType",
	"approvalPreset",
	"brief",
	"workdir",
	"model",
	"memoryContent",
	"agents",
	"repo",
	"keepAliveAfterComplete",
	"op",
	"action",
]);
const SPAWN_ARG_DISCRIMINATORS = [
	"task",
	"agentType",
	"approvalPreset",
	"brief",
];

export function looksLikeSpawnEnvelopeJson(text: string): boolean {
	let body = text.trim();
	const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fence?.[1]) body = fence[1].trim();
	if (!body.startsWith("{") || !body.endsWith("}")) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return false;
	}
	const keys = Object.keys(parsed as Record<string, unknown>);
	if (keys.length === 0) return false;
	if (!keys.every((k) => SPAWN_ARG_KEYS.has(k))) return false;
	return (
		SPAWN_ARG_DISCRIMINATORS.filter((k) => k in (parsed as object)).length >= 2
	);
}

/**
 * Detects a planner/evaluator CONTROL envelope returned in a user-visible
 * channel — `{"decision":"CONTINUE"|"FINISH"|"NEXT_RECOMMENDED", …}` (or
 * `route`) carrying at least one evaluator discriminator
 * (`success`/`thought`/`nextTool`/`recommendedToolCallId`). Narrow by design:
 * a bare `{"decision":"approve"}` from a real reply does not match.
 */
export function looksLikeEvaluatorEnvelopeJson(text: string): boolean {
	let body = text.trim();
	const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fence?.[1]) body = fence[1].trim();
	if (!body.startsWith("{") || !body.endsWith("}")) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return false;
	}
	const record = parsed as Record<string, unknown>;
	const decision = String(record.decision ?? record.route ?? "").toUpperCase();
	if (!["FINISH", "CONTINUE", "NEXT_RECOMMENDED"].includes(decision)) {
		return false;
	}
	return (
		typeof record.success === "boolean" ||
		typeof record.thought === "string" ||
		typeof record.nextTool === "object" ||
		typeof record.recommendedToolCallId === "string"
	);
}

function isUnsafeUserVisibleText(value: string | undefined): boolean {
	if (!value) return false;
	const text = value.trim();
	if (!text) return false;
	if (
		looksLikeSpawnEnvelopeJson(text) ||
		looksLikeEvaluatorEnvelopeJson(text)
	) {
		return true;
	}
	return [
		/\bto=functions\.[A-Z0-9_]+\b/i,
		/\bfunctions\.[A-Z0-9_]+\b/i,
		/"action"\s*:\s*"functions\.[A-Z0-9_]+"/i,
		/\b(?:tool|function)\s+calls?\b/i,
		/\b(?:I|we)\s+(?:need|should|must|will)\s+to\s+(?:call|use|invoke|issue|perform)\b/i,
		/\b(?:call|use|invoke)\s+[A-Z][A-Z0-9_]{2,}\b/,
		/\b(?:MESSAGE\s+action|action=(?:draft_reply|respond|send_draft|triage|list_inbox))\b/i,
		/\{\s*"parameters"\s*:/i,
	].some((pattern) => pattern.test(text));
}

// Detects planner free-text that NARRATES the model's own deliberation / tool
// selection rather than addressing the user — a pre-tool "thought". Kept as a
// belt-and-braces reject alongside the positive allowlist below.
function looksLikePreToolThought(value: string): boolean {
	const text = value.trim();
	if (!text) return false;
	return [
		/\bthink(?:ing)?\s+through\b/i,
		/\btool\s+choice\b/i,
		/\b(?:after|before|once)\s+(?:thinking|considering|deciding|choosing|reviewing|figuring)\b/i,
		/\blet me (?:think|consider|figure|decide|choose)\b/i,
		/\bI(?:'ll| will| should| need to| am going to| plan to)\s+(?:think|consider|figure|decide|choose)\b/i,
	].some((pattern) => pattern.test(text));
}

// Positive markers that a native free-text is a genuine inability/refusal — the
// ONLY shape we surface from an ambiguous native `text` field. An allowlist (not
// a denylist of known-bad phrasings) is what makes this safe: intent-narration
// like "Let me check the database" or "I'm reviewing the history" carries no
// inability marker, so it is never surfaced and a pre-tool thought can't reach
// the user as a fake "refusal" (#9874 item 3).
const REFUSAL_MARKERS = [
	/\b(?:can(?:'|no)?t|cannot)\b/i,
	/\b(?:un)?able to\b/i,
	/\bdon'?t (?:have|see)\b/i,
	/\bno (?:access|way|ability|matching|such|suitable)\b/i,
	/\bnot (?:available|possible|supported|something I can|wired|connected|set up)\b/i,
	/\bisn'?t (?:available|possible|supported|something I can)\b/i,
	/\bthere(?:'s| is| are) (?:no|nothing)\b/i,
];

// In-flight / imminent action narration — the confabulation shape ("Let me look
// that up", "I'm pulling up your messages", "please hold"). Rejected even when a
// refusal marker co-occurs, because once this iteration ends no further tool
// work happens, so any "I'm doing X now" is a false promise.
const IN_FLIGHT_ACTION_CLAIM = [
	/\blet me\b/i,
	/\bI(?:'ll| will| am going to|'m going to|'m gonna| am gonna)\b/i,
	/\bI'?m\s+(?:checking|fetching|searching|looking|pulling|reviewing|gathering|working|getting|grabbing|loading|digging|querying)\b/i,
	/\b(?:one|just a)\s+(?:sec|second|moment|min|minute)\b/i,
	/\bplease (?:hold|wait)\b/i,
	/\b(?:be right back|brb|hang on)\b/i,
];

// Gate for surfacing native planner free-text as a forced-tool-exhaustion
// refusal (#9874 item 3). Returns the sanitized message ONLY when it POSITIVELY
// reads as an inability statement (REFUSAL_MARKERS) and carries no leaked
// tool-call/reasoning markup (isUnsafeUserVisibleText), no deliberation
// (looksLikePreToolThought), and no in-flight action claim (IN_FLIGHT). When the
// text is ambiguous (e.g. a bare native "Let me check…" thought) it returns
// undefined and the caller falls back to its generic apology — the safe
// direction. Stricter than userSafeFinalMessage's candidate check, which runs on
// text already known to be user-directed.
function userSafeRefusalCandidate(
	message: string | undefined,
): string | undefined {
	const candidate = sanitizePlannerMessage(message);
	if (!candidate) return undefined;
	if (!REFUSAL_MARKERS.some((pattern) => pattern.test(candidate))) {
		return undefined;
	}
	if (isUnsafeUserVisibleText(candidate)) return undefined;
	if (looksLikePreToolThought(candidate)) return undefined;
	if (IN_FLIGHT_ACTION_CLAIM.some((pattern) => pattern.test(candidate))) {
		return undefined;
	}
	return candidate;
}

// Progress/ack-shaped openers that must never be surfaced as a final answer
// from the required-tool exhaustion path: once the loop gives up, no further
// tool work happens, so "Checking the price now." style text is a false
// promise. Mirrors the message-service looksLikeProgressOnlyReply prefix set
// (kept local — services/message.ts imports from this module, not vice versa).
const PROGRESS_ONLY_ANSWER_REJECT =
	/^(?:checking|fetching|gathering|looking (?:up|into)|running|using|spawning|starting|working on|opening|got it|okay|ok|on it|one moment|let me|i(?:'|’)ll|i will)\b/i;

// Shape gate for surfacing an already-produced ANSWER — the Stage-1 replyText
// or the planner's own explicit terminal reply the required-tool gate kept
// rejecting — when the miss budget exhausts without a captured refusal. Same
// safety rejects as userSafeRefusalCandidate (leaked tool-call/reasoning
// markup, pre-tool deliberation, in-flight action claims) minus the
// refusal-marker requirement: the text surfaced here is a real answer
// ("391"), not an inability statement, plus a progress-only-opener reject so
// a bare ack never ships as the whole turn. Callers must only feed it
// user-directed sources (Stage-1 replyText, explicit messageToUser, REPLY
// tool-call text) — never the ambiguous native free-text fallback, which can
// be a pre-tool thought.
function userSafeCapturedAnswerCandidate(
	message: string | undefined,
): string | undefined {
	const candidate = sanitizePlannerMessage(message);
	if (!candidate) return undefined;
	if (isUnsafeUserVisibleText(candidate)) return undefined;
	if (looksLikePreToolThought(candidate)) return undefined;
	if (IN_FLIGHT_ACTION_CLAIM.some((pattern) => pattern.test(candidate))) {
		return undefined;
	}
	if (PROGRESS_ONLY_ANSWER_REJECT.test(candidate)) return undefined;
	return candidate;
}

// In-flight narration reject for widget replies. Narrower than
// IN_FLIGHT_ACTION_CLAIM because widget replies legitimately say "let me know" /
// "pick a time and let me know", and a forward-looking promise conditioned on
// user input ("I'll set it up once you pick a time") is not a false "doing it
// now" claim — the widget block itself proves the turn ends by asking the user.
const WIDGET_REPLY_IN_FLIGHT_CLAIM = [
	/\blet me\b(?!\s+know\b)/i,
	/\bI'?m\s+(?:checking|fetching|searching|looking|pulling|reviewing|gathering|working|getting|grabbing|loading|digging|querying)\b/i,
	/\b(?:one|just a)\s+(?:sec|second|moment|min|minute)\b/i,
	/\bplease (?:hold|wait)\b/i,
	/\b(?:be right back|brb|hang on)\b/i,
];

// A terminal reply that renders as an interactive widget (grammar-valid
// [FORM]/[CHOICE]/[FOLLOWUPS] block) is a request for user input — the
// conversational analog of an honest refusal to act without more information.
// Under the required-tool gate it must be capturable the same way a refusal is
// (#15230): the CLI text lane cannot express REPLY as a native tool call, and
// discarding a grammar-valid [FORM] answer to synthesize an apology fabricates
// a failure. The strict block parser is the authenticity check: a pre-tool
// thought never contains a parse-valid widget block (a malformed block is left
// as plain text and yields zero blocks).
function userSafeWidgetReplyCandidate(
	message: string | undefined,
): string | undefined {
	const candidate = sanitizePlannerMessage(message);
	if (!candidate) return undefined;
	if (parseInteractionBlocks(candidate).blocks.length === 0) return undefined;
	if (isUnsafeUserVisibleText(candidate)) return undefined;
	if (looksLikePreToolThought(candidate)) return undefined;
	if (WIDGET_REPLY_IN_FLIGHT_CLAIM.some((pattern) => pattern.test(candidate))) {
		return undefined;
	}
	return candidate;
}

function preferRecommendedToolCall(
	trajectory: PlannerTrajectory,
	evaluator: EvaluatorOutput,
): boolean {
	if (evaluator.recommendedToolCallId) {
		const recommendation = evaluator.recommendedToolCallId;
		let index = trajectory.plannedQueue.findIndex(
			(toolCall) => toolCall.id === recommendation,
		);
		if (index < 0) {
			index = trajectory.plannedQueue.findIndex(
				(toolCall) => toolCall.name === recommendation,
			);
		}
		if (index > 0) {
			const [selected] = trajectory.plannedQueue.splice(index, 1);
			if (selected) {
				trajectory.plannedQueue.unshift(selected);
			}
		}
		return index >= 0;
	}

	return trajectory.plannedQueue.length > 0;
}

function ensureToolCallId(
	toolCall: PlannerToolCall,
	iteration: number,
	index: number,
): PlannerToolCall {
	if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
		return toolCall;
	}
	return {
		...toolCall,
		id: `tool-${iteration}-${index}`,
	};
}

/**
 * Canonical conversion from {@link ActionResult} to {@link PlannerToolResult}.
 * Both the top-level executor and the sub-planner produce ActionResults from
 * action handlers; the planner queue consumes PlannerToolResults. Keeping the
 * mapping in one place avoids drift between the two paths.
 */
export function actionResultToPlannerToolResult(
	result: ActionResult,
	options: { summary?: string } = {},
): PlannerToolResult {
	const data: Record<string, unknown> = {};
	if (result.data) {
		Object.assign(data, result.data as ProviderDataRecord);
	}
	if (result.values) {
		data.values = result.values;
	}
	const plannerResult: PlannerToolResult = {
		success: result.success,
		text: result.text,
		userFacingText: result.userFacingText,
		verifiedUserFacing: result.verifiedUserFacing,
		data: Object.keys(data).length > 0 ? data : undefined,
		error: result.error,
		continueChain: result.continueChain,
	};
	if (options.summary) {
		plannerResult.summary = options.summary;
	}
	return plannerResult;
}

export function summarizeActionResultForPlanner(
	action: Pick<Action, "summarize"> | undefined,
	result: ActionResult,
	params: Record<string, unknown> = {},
): string | undefined {
	if (result.success !== true || typeof action?.summarize !== "function") {
		return undefined;
	}
	try {
		const summary = action.summarize(result, params)?.trim();
		return summary || undefined;
	} catch {
		return undefined;
	}
}

function getNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

/**
 * Look up the optimized `action_planner` prompt from the runtime's
 * OptimizedPromptService, fall back to the baseline `plannerTemplate`. Keeps
 * the planner loop using the latest artifact written by
 * `bun run train -- --backend native --task action_planner` without any
 * additional plumbing at the call site.
 *
 * `PlannerRuntime` is the minimal shape this module accepts; the full
 * `IAgentRuntime` (with `getService`) flows in via the message handler at
 * `services/message.ts`. Cast structurally so we don't widen `PlannerRuntime`
 * just to read one optional service.
 */
// In-process cache for the on-disk optimized planner artifact. Resolved
// once per process so we don't re-read the JSON file on every planner
// invocation. Set to `null` for "no artifact" and to the prompt body when
// found. The flag avoids re-attempting reads when the file is missing.
let cachedDiskOptimizedPlannerPrompt: string | null = null;
let cachedDiskOptimizedPlannerLoaded = false;

function loadOptimizedPlannerFromDisk(): string | null {
	const dir = join(resolveStateDir(), "optimized-prompts", "action_planner");
	if (!existsSync(dir)) return null;

	// Preferred path: read via the `current` symlink that
	// `OptimizedPromptService.setPrompt` / `rollback` maintain. This is the
	// authoritative live artifact.
	const currentPath = join(dir, "current");
	if (existsSync(currentPath)) {
		try {
			const raw = readFileSync(currentPath, "utf-8");
			const parsed = JSON.parse(raw) as {
				task?: string;
				prompt?: string;
			};
			if (
				parsed.task === "action_planner" &&
				typeof parsed.prompt === "string"
			) {
				return parsed.prompt;
			}
		} catch (err) {
			logger.warn(
				{ path: currentPath, err: (err as Error).message },
				"[PlannerLoop] malformed action_planner 'current' artifact; falling back to mtime scan",
			);
		}
	}

	// Fallback: legacy / pre-symlink stores. Pick the newest artifact by
	// mtime so we still find something when `current` is missing.
	const entries = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => ({
			path: join(dir, f),
			mtime: statSync(join(dir, f)).mtimeMs,
		}))
		.sort((a, b) => b.mtime - a.mtime);
	for (const entry of entries) {
		try {
			const raw = readFileSync(entry.path, "utf-8");
			const parsed = JSON.parse(raw) as {
				task?: string;
				prompt?: string;
			};
			if (
				parsed.task === "action_planner" &&
				typeof parsed.prompt === "string"
			) {
				return parsed.prompt;
			}
		} catch (err) {
			logger.warn(
				{ path: entry.path, err: (err as Error).message },
				"[PlannerLoop] malformed action_planner artifact; trying next candidate",
			);
		}
	}
	return null;
}

function resolveOptimizedPlannerTemplate(runtime: PlannerRuntime): string {
	// Production path: consult the registered service first. When it has
	// an artifact for `action_planner`, return that. The shared helper
	// gracefully no-ops when `getService` is missing on the runtime.
	const fromService = resolveOptimizedPromptForRuntime(
		runtime as PlannerRuntime & {
			getService?: <T>(name: string) => T | null | undefined;
		},
		"action_planner",
		plannerTemplate,
	);
	if (fromService !== plannerTemplate) return fromService;

	// Fallback: read the on-disk store directly. Handles the test runtime
	// path (where the service may not have started before the first
	// planner call), the lazy-start race in production, and any other
	// path that hasn't gotten the service registered yet.
	if (!cachedDiskOptimizedPlannerLoaded) {
		try {
			cachedDiskOptimizedPlannerPrompt = loadOptimizedPlannerFromDisk();
		} catch (err) {
			// readdir/stat failures on the optimized-prompts directory are
			// non-fatal: we fall back to the bundled `plannerTemplate`. Log so
			// repeated boot failures show up in operator output rather than
			// being silently masked.
			logger.warn(
				{ err: (err as Error).message },
				"[PlannerLoop] optimized planner disk load failed; using bundled template",
			);
			cachedDiskOptimizedPlannerPrompt = null;
		}
		cachedDiskOptimizedPlannerLoaded = true;
	}
	return cachedDiskOptimizedPlannerPrompt ?? plannerTemplate;
}
