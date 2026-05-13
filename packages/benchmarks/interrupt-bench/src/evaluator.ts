/**
 * Evaluator — orchestrates one scenario end-to-end.
 *
 * Wires together: clock, channels, state, trace, the LLM provider (scripted or
 * cerebras), and the dispatch step that maps the LLM's structured output into
 * state mutations + a trace event.
 *
 * This evaluator does NOT spin up a full agent runtime — that would be
 * incompatible with the in-process determinism we need. Instead it stages
 * the Stage-1 LLM call directly (composing the prompt + schema via a minimal
 * registry) and applies the parsed result as if a real `lifeops_thread_control`
 * action handler had run.
 */

import type { ResponseHandlerResult } from "@elizaos/core";
import { TurnControllerRegistry } from "@elizaos/core";
import { ChannelSimulator } from "./channels.ts";
import { FakeClock } from "./clock.ts";
import { runJudge } from "./judge.ts";
import { callCerebras } from "./llm-cerebras.ts";
import {
  createDefaultScriptedProvider,
  type ScriptedLlmProvider,
} from "./llm-scripted.ts";
import { renderConversation } from "./prompt.ts";
import { buildBenchRegistry } from "./registry.ts";
import { scoreScenario } from "./scorer.ts";
import { SimulatorState } from "./state.ts";
import { Trace } from "./trace.ts";
import type { Scenario, ScenarioResult, ScenarioScriptStep } from "./types.ts";

type BenchThreadOp = Record<string, unknown>;

export type EvaluatorMode = "scripted" | "cerebras";

export interface EvaluatorOptions {
  mode: EvaluatorMode;
  /** When in scripted mode, an optional override provider. */
  scripted?: ScriptedLlmProvider;
  /** When in cerebras mode, override the model. */
  cerebrasModel?: string;
  /** Whether to invoke the LLM judge for the bonus tier. */
  runJudge?: boolean;
}

export async function runScenario(
  scenario: Scenario,
  opts: EvaluatorOptions,
): Promise<ScenarioResult> {
  const clock = new FakeClock();
  const trace = new Trace(() => clock.now());
  const state = SimulatorState.fromSetup(scenario.setup);
  const channels = new ChannelSimulator(clock, trace);
  const turnControllers = new TurnControllerRegistry();

  const startWall = Date.now();
  let stage1Calls = 0;
  const history: ScenarioScriptStep[] = [];
  const scripted = opts.scripted ?? createDefaultScriptedProvider();
  const registry = buildBenchRegistry();
  const schema = registry.composeSchema();
  const systemPrompt = `You are the Stage-1 response handler in InterruptBench. Emit a single JSON object matching the schema.

Rules:
- If the new message is only a fragment of a request, set shouldRespond="IGNORE", replyText="", and threadOps=[].
- Do not ask clarifying questions for obvious fragments such as "i need to", "send", "an email", "set up a meeting", or "with carol tomorrow at 3pm"; wait for the complete request.
- Once a complete fragmented request arrives, emit exactly one reply for the final intent.
- Honor retractions and cancellations. For "stop", "nvm", "scratch that", or "actually don't", emit an abort/stop threadOp for the active workThreadId when one exists.
- For refinements to an active thread, use a steer threadOp with the existing workThreadId.
- For pivots, stop the old thread and create a new thread.
- Never reply in a channel the message did not originate in.`;

  channels.schedule(scenario, async ({ step }) => {
    trace.push("handler_start", { channel: step.channel, sender: step.sender });
    history.push(step);
    stage1Calls += 1;
    trace.push("stage1_call", {
      channel: step.channel,
      detail: { callIndex: stage1Calls },
    });

    let parsed: ResponseHandlerResult;
    let llmLatency = 0;
    if (opts.mode === "scripted") {
      const out = scripted({
        scenario,
        callIndex: stage1Calls,
        history: history.slice(0, -1),
        message: step,
        state: state.snapshot(),
      });
      parsed = out.parsed;
      llmLatency = out.latencyMs;
    } else {
      const conversation = renderConversation({
        scenario,
        history: history.slice(0, -1),
        message: step,
        state,
      });
      const result = await callCerebras({
        systemPrompt,
        messages: [{ role: "user", content: conversation }],
        schema,
        model: opts.cerebrasModel,
      });
      parsed = result.parsed;
      llmLatency = result.latencyMs;
    }

    trace.push("stage1_response", {
      channel: step.channel,
      detail: {
        shouldRespond: parsed.shouldRespond,
        replyTextLen: parsed.replyText?.length ?? 0,
        threadOps: parsed.threadOps,
        llmLatencyMs: llmLatency,
      },
    });

    await turnControllers.runWith(step.channel, async (signal) => {
      await applyResponseToState({
        parsed,
        scenario,
        message: step,
        state,
        trace,
        turnControllers,
        signal,
      });
    });
    trace.push("handler_end", { channel: step.channel });
  });

  // Run virtual clock forward
  const lastStepT = scenario.script[scenario.script.length - 1]?.t ?? 0;
  const quiesceMs = scenario.quiesceAfterMs ?? 3000;
  await clock.runUntil(lastStepT + quiesceMs);
  await channels.quiesce();
  trace.seal();

  const durationMs = Date.now() - startWall;
  let judge: { pass: boolean; reason: string } | undefined;
  if (opts.runJudge) {
    judge = await runJudge({
      scenario,
      finalState: state,
      model: opts.cerebrasModel,
    });
  }
  return scoreScenario({
    scenario,
    finalState: state,
    trace,
    durationMs,
    judge,
  });
}

// ---------------------------------------------------------------------------
// Apply parsed LLM output to state
// ---------------------------------------------------------------------------

interface ApplyArgs {
  parsed: ResponseHandlerResult;
  scenario: Scenario;
  message: ScenarioScriptStep;
  state: SimulatorState;
  trace: Trace;
  turnControllers: TurnControllerRegistry;
  signal: AbortSignal;
}

async function applyResponseToState(args: ApplyArgs): Promise<void> {
  const { parsed, scenario, message, state, trace, turnControllers } = args;

  // Apply threadOps in declaration order.
  const ops = getThreadOps(parsed);
  let preempt:
    | { mode: "ack-and-stop" | "ignore" | "direct-reply"; reason: string }
    | undefined;
  let allowFollowup = true;
  for (const op of ops) {
    const type = String(op.type ?? "");
    const workThreadId = op.workThreadId ? String(op.workThreadId) : undefined;
    const sourceWorkThreadIds = Array.isArray(op.sourceWorkThreadIds)
      ? op.sourceWorkThreadIds.map(String)
      : [];
    const instruction =
      typeof op.instruction === "string" ? op.instruction : undefined;
    const reason = typeof op.reason === "string" ? op.reason : undefined;

    trace.push("thread_op", {
      detail: { type, workThreadId, instruction, reason },
    });

    switch (type) {
      case "abort": {
        const thread = workThreadId
          ? state.threads.get(workThreadId)
          : undefined;
        if (thread) thread.status = "stopped";
        // Fire turn abort if any active turn exists for this room (we use the message channel as roomId)
        turnControllers.abortTurn(message.channel, reason ?? "user retracted");
        trace.push("abort_fired", {
          channel: message.channel,
          reason: reason ?? "user retracted",
        });
        preempt = { mode: "ack-and-stop", reason: reason ?? "abort" };
        allowFollowup = false;
        break;
      }
      case "stop": {
        const thread = workThreadId
          ? state.threads.get(workThreadId)
          : undefined;
        if (thread) thread.status = "stopped";
        break;
      }
      case "steer": {
        const thread = workThreadId
          ? state.threads.get(workThreadId)
          : undefined;
        if (thread && instruction) thread.instruction = instruction;
        // Resolve any pending prompt attached to this thread.
        if (thread?.pendingPromptId) {
          const p = state.pendingPrompts.get(thread.pendingPromptId);
          if (p) {
            p.resolved = true;
            p.resolvedAt = trace.all().length;
          }
        }
        break;
      }
      case "merge": {
        const target = workThreadId
          ? state.threads.get(workThreadId)
          : undefined;
        if (target && instruction) target.instruction = instruction;
        for (const sid of sourceWorkThreadIds) {
          const src = state.threads.get(sid);
          if (src) src.status = "stopped";
        }
        break;
      }
      case "create": {
        const id = `gen-${trace.all().length}-${Math.random().toString(36).slice(2, 8)}`;
        state.threads.set(id, {
          id,
          owner: message.sender,
          status: "active",
          instruction: instruction ?? "",
          roomId: message.channel,
        });
        // For A4: a "create" with a meeting in the instruction also schedules a task.
        const text = instruction?.toLowerCase() ?? "";
        if (
          /(meeting|schedule|carol|bob).*(friday|monday|tuesday|wednesday|thursday|saturday|sunday|tomorrow)/.test(
            text,
          ) ||
          /\bat \d/.test(text)
        ) {
          state.scheduledTasks.push({
            id: `task-${id}`,
            owner: message.sender,
            description: instruction ?? "",
          });
        }
        break;
      }
      case "mark_completed": {
        const thread = workThreadId
          ? state.threads.get(workThreadId)
          : undefined;
        if (thread) thread.status = "completed";
        break;
      }
      case "mark_waiting": {
        const thread = workThreadId
          ? state.threads.get(workThreadId)
          : undefined;
        if (thread) thread.status = "waiting";
        break;
      }
      default:
        // Other op types are no-ops in the benchmark.
        break;
    }
  }

  // Emit a reply if RESPOND and we have replyText (or in ack-and-stop with replyText).
  const replyText =
    typeof parsed.replyText === "string" ? parsed.replyText : "";
  const shouldRespond = parsed.shouldRespond === "RESPOND";
  let replyEmitted = false;
  if (preempt?.mode === "ack-and-stop") {
    trace.push("preempt", {
      preemptMode: "ack-and-stop",
      reason: preempt.reason,
    });
    if (replyText) {
      state.recordReply(message.channel, replyText, trace.all().length);
      replyEmitted = true;
      trace.push("reply_emitted", {
        channel: message.channel,
        text: replyText,
      });
    }
  } else if (preempt?.mode === "ignore") {
    trace.push("preempt", { preemptMode: "ignore", reason: preempt.reason });
  } else if (shouldRespond && replyText && allowFollowup) {
    state.recordReply(message.channel, replyText, trace.all().length);
    replyEmitted = true;
    trace.push("reply_emitted", { channel: message.channel, text: replyText });
  }
  // Boundary check: did any reply target a user outside the room where it was emitted?
  if (replyEmitted && !scenario.setup.rooms.some((room) => room.id === message.channel)) {
    trace.push("boundary_violation", {
      channel: message.channel,
      sender: message.sender,
      text: replyText,
      detail: { reason: "reply_emitted_in_unknown_channel" },
    });
  }
  if (replyEmitted && parsed.addressedTo && Array.isArray(parsed.addressedTo)) {
    for (const addressed of parsed.addressedTo) {
      const userId = String(addressed).trim();
      if (!userId) continue;
      if (isUserInRoom(scenario, message.channel, userId)) continue;
      trace.push("boundary_violation", {
        channel: message.channel,
        sender: message.sender,
        text: replyText,
        detail: {
          reason: "addressed_to_user_outside_channel",
          addressedTo: userId,
          roomId: message.channel,
        },
      });
    }
  }
}

function getThreadOps(parsed: ResponseHandlerResult): BenchThreadOp[] {
  const value = parsed.threadOps;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (op): op is BenchThreadOp =>
      typeof op === "object" && op !== null && !Array.isArray(op),
  );
}

function isUserInRoom(
  scenario: Scenario,
  roomId: string,
  userId: string,
): boolean {
  const normalizedUserId = userId.toLowerCase();
  if (normalizedUserId === scenario.setup.agentId.toLowerCase()) return true;
  const room = scenario.setup.rooms.find((candidate) => candidate.id === roomId);
  if (!room) return false;
  if (room.owner?.toLowerCase() === normalizedUserId) return true;
  return (room.members ?? []).some(
    (member) => member.toLowerCase() === normalizedUserId,
  );
}
