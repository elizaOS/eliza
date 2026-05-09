/**
 * Stall classification subsystem — determines what a "stalled" task agent
 * session is doing (finished, waiting for input, still working, or errored).
 *
 * Extracted as standalone functions that receive dependencies as parameters,
 * making them easy to test without coupling to PTYService.
 *
 * @module services/stall-classifier
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";
import {
  buildTaskCompletionTimeline,
  extractTaskCompletionTraceRecords,
  type StallClassification,
} from "pty-manager";
import type { AgentMetricsTracker } from "./agent-metrics.js";
import { stripAnsi } from "./ansi-utils.js";
import { parseJsonObjectResponse } from "./json-model-output.js";
import type {
  DecisionHistoryEntry,
  TaskContextSummary,
} from "./swarm-coordinator-prompts.js";
import { withTrajectoryContext } from "./trajectory-context.js";

/** Everything the classifier needs, passed in from PTYService. */
export interface StallClassifierContext {
  sessionId: string;
  recentOutput: string;
  agentType: string;
  buffers: Map<string, string[]>;
  traceEntries: Array<string | Record<string, unknown>>;
  runtime: IAgentRuntime;
  manager: {
    get(id: string): { startedAt?: string | Date } | null | undefined;
  } | null;
  metricsTracker: AgentMetricsTracker;
  /** Write debug snapshots to ~/.eliza/debug/ on stall (default: false) */
  debugSnapshots?: boolean;
  /** Most recent text input sent into the session, used to ignore echoed prompts. */
  lastSentInput?: string;
  log: (msg: string) => void;
}

const STATUS_NOISE_LINE =
  /messages to be submitted after next tool call|working \(\d+s .*esc to interrupt\)|\b\d+% left\b|context left|use \/skills to list available skills/i;
const STATUS_PATH_LINE = /(\/private\/|\/var\/folders\/|\/Users\/|\/tmp\/)/;
const SPINNER_FRAGMENT_TOKEN =
  /^(?:w|wo|wor|work|worki|workin|working|orking|rking|king|ing|ng|g|\d+|[•·])$/i;

function normalizeForComparison(value: string): string {
  return stripAnsi(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function looksLikeSpinnerFragments(line: string): boolean {
  const tokens = line
    .replace(/[^\w/%@.:\-/ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  const fragmentTokens = tokens.filter((token) =>
    SPINNER_FRAGMENT_TOKEN.test(token),
  );
  return (
    fragmentTokens.length >= 4 &&
    fragmentTokens.length >= Math.ceil(tokens.length * 0.6)
  );
}

function isStatusNoiseLine(line: string): boolean {
  const compact = line.replace(/\s+/g, " ").trim();
  if (!compact) return true;
  if (compact.startsWith("› ")) return true;
  if (STATUS_NOISE_LINE.test(compact)) return true;
  if (looksLikeSpinnerFragments(compact)) return true;
  if (STATUS_PATH_LINE.test(compact) && /\b\d+% left\b/i.test(compact))
    return true;
  if (STATUS_PATH_LINE.test(compact) && looksLikeSpinnerFragments(compact))
    return true;
  return false;
}

function sanitizeOutputForClassification(
  output: string,
  lastSentInput?: string,
): {
  sanitized: string;
  removedEchoLines: number;
  removedStatusLines: number;
} {
  const normalizedInput = lastSentInput
    ? normalizeForComparison(lastSentInput)
    : "";
  let removedEchoLines = 0;
  let removedStatusLines = 0;
  const sanitized = stripAnsi(output)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => {
      if (!line) return false;
      const normalizedLine = line.toLowerCase();
      if (
        normalizedInput &&
        normalizedLine.length >= 12 &&
        normalizedInput.includes(normalizedLine)
      ) {
        removedEchoLines += 1;
        return false;
      }
      if (isStatusNoiseLine(line)) {
        removedStatusLines += 1;
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
  return { sanitized, removedEchoLines, removedStatusLines };
}

function promptLooksLikeFalseBlockedNoise(
  prompt: string | undefined,
  lastSentInput?: string,
): boolean {
  if (!prompt) return false;
  const normalizedPrompt = normalizeForComparison(prompt);
  if (!normalizedPrompt) return false;
  if (lastSentInput) {
    const normalizedInput = normalizeForComparison(lastSentInput);
    if (
      normalizedPrompt.length >= 12 &&
      normalizedInput.includes(normalizedPrompt)
    ) {
      return true;
    }
  }
  return isStatusNoiseLine(prompt) || looksLikeSpinnerFragments(prompt);
}

/**
 * Build the LLM system prompt used to classify stalled output.
 */
export function buildStallClassificationPrompt(
  agentType: string,
  sessionId: string,
  output: string,
): string {
  return (
    `You are Eliza, an AI orchestrator managing task-agent sessions. ` +
    `A ${agentType} task agent (session: ${sessionId}) appears to have stalled — ` +
    `it has stopped producing output while in a busy state.\n\n` +
    `Here is the recent terminal output:\n` +
    `---\n${output.slice(-1500)}\n---\n\n` +
    `Classify what's happening. Read the output carefully and choose the MOST specific match:\n\n` +
    `1. "task_complete" — The agent FINISHED its task and returned to its idle prompt. ` +
    `Strong indicators: a summary of completed work ("Done", "All done", "Here's what was completed"), ` +
    `timing info ("Baked for", "Churned for", "Crunched for", "Cooked for", "Worked for"), ` +
    `or the agent's main prompt symbol (❯) appearing AFTER completion output. ` +
    `If the output contains evidence of completed work followed by an idle prompt, this is ALWAYS task_complete, ` +
    `even though the agent is technically "waiting" — it is waiting for a NEW task, not asking a question.\n\n` +
    `2. "waiting_for_input" — The agent is MID-TASK and blocked on a specific question or permission prompt. ` +
    `The agent has NOT finished its work — it needs a response to continue. ` +
    `Examples: Y/n confirmation, file permission dialogs, "Do you want to proceed?", ` +
    `tool approval prompts, or interactive menus. ` +
    `This is NOT the same as the agent sitting at its idle prompt after finishing work.\n\n` +
    `3. "still_working" — The agent is actively processing (API call, compilation, thinking, etc.) ` +
    `and has not produced final output yet. No prompt or completion summary visible.\n\n` +
    `4. "error" — The agent hit an error state (crash, unrecoverable error, stack trace).\n\n` +
    `5. "tool_running" — The agent is using an external tool (browser automation, ` +
    `MCP tool, etc.). Indicators: "Claude in Chrome", "javascript_tool", ` +
    `"computer_tool", "screenshot", "navigate", tool execution output. ` +
    `The agent is actively working but the terminal may be quiet.\n\n` +
    `IMPORTANT: If you see BOTH completed work output AND an idle prompt (❯), choose "task_complete". ` +
    `Only choose "waiting_for_input" if the agent is clearly asking a question mid-task. ` +
    `Ignore echoed user input, copied prior transcripts, spinner fragments, and status rows like ` +
    `"Working (12s • esc to interrupt)" or "97% left" — those mean the agent is still working, not blocked.\n\n` +
    `If "waiting_for_input", also provide:\n` +
    `- "prompt": the text of what it's asking\n` +
    `- "suggestedResponse": what to type/send. Use "keys:enter" for TUI menu confirmation, ` +
    `"keys:down,enter" to select a non-default option, or plain text like "y" for text prompts.\n\n` +
    `Respond with JSON only:\n` +
    `{"state":"waiting_for_input","prompt":"The exact prompt text, or blank if none.","suggestedResponse":"y"}`
  );
}

/**
 * Write a debug snapshot to ~/.eliza/debug/ for offline stall analysis.
 */
export async function writeStallSnapshot(
  sessionId: string,
  agentType: string,
  recentOutput: string,
  effectiveOutput: string,
  buffers: Map<string, string[]>,
  traceEntries: Array<string | Record<string, unknown>>,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const snapshotDir = path.join(os.homedir(), ".eliza", "debug");
    fs.mkdirSync(snapshotDir, { recursive: true });
    const ourBuffer = buffers.get(sessionId);
    const ourTail = ourBuffer
      ? ourBuffer.slice(-100).join("\n")
      : "(no buffer)";
    void ourTail; // used in snapshot context but not directly printed
    let traceTimeline = "(no trace entries)";
    try {
      const records = extractTaskCompletionTraceRecords(traceEntries);
      const timeline = buildTaskCompletionTimeline(records, {
        adapterType: agentType,
      });
      traceTimeline = JSON.stringify(timeline, null, 2);
    } catch (e) {
      traceTimeline = `(trace error: ${e})`;
    }
    const snapshot = [
      `=== STALL SNAPSHOT @ ${new Date().toISOString()} ===`,
      `Session: ${sessionId} | Agent: ${agentType}`,
      `recentOutput length: ${recentOutput.length} | effectiveOutput length: ${effectiveOutput.length}`,
      ``,
      `--- effectiveOutput (what LLM sees) ---`,
      effectiveOutput.slice(-1500),
      ``,
      `--- trace timeline ---`,
      traceTimeline,
      ``,
      `--- raw trace entries (last 20 of ${traceEntries.length}) ---`,
      traceEntries.slice(-20).join("\n"),
      ``,
    ].join("\n");
    const snapshotPath = path.join(
      snapshotDir,
      `stall-snapshot-${sessionId}.txt`,
    );
    fs.writeFileSync(snapshotPath, snapshot);
    log(`Stall snapshot → ${snapshotPath}`);
  } catch (_) {
    /* best-effort */
  }
}

/**
 * Main stall classification logic. Determines what a stalled session is doing
 * by checking the buffer, building a prompt, and asking the LLM.
 */
export async function classifyStallOutput(
  ctx: StallClassifierContext,
): Promise<StallClassification | null> {
  const {
    sessionId,
    recentOutput,
    agentType,
    buffers,
    traceEntries,
    runtime,
    metricsTracker,
    log,
  } = ctx;

  metricsTracker.incrementStalls(agentType);

  // Use our own buffer if pty-manager's recentOutput is empty or too short.
  let effectiveOutput = recentOutput;
  if (!recentOutput || recentOutput.trim().length < 200) {
    const ourBuffer = buffers.get(sessionId);
    if (ourBuffer && ourBuffer.length > 0) {
      const rawTail = ourBuffer.slice(-100).join("\n");
      const stripped = stripAnsi(rawTail);
      if (stripped.length > effectiveOutput.length) {
        effectiveOutput = stripped;
        log(
          `Using own buffer for stall classification (${effectiveOutput.length} chars after stripping, pty-manager had ${recentOutput.length})`,
        );
      }
    }
  }

  const {
    sanitized: sanitizedOutput,
    removedEchoLines,
    removedStatusLines,
  } = sanitizeOutputForClassification(effectiveOutput, ctx.lastSentInput);
  if (removedEchoLines > 0 || removedStatusLines > 0) {
    log(
      `Sanitized stall output for ${sessionId}: removed ${removedEchoLines} echoed lines and ${removedStatusLines} status lines`,
    );
  }
  if (!sanitizedOutput && removedEchoLines + removedStatusLines > 0) {
    log(
      `Stall classification short-circuit for ${sessionId}: only echoed input / status noise remained`,
    );
    return { state: "still_working" };
  }

  const systemPrompt = buildStallClassificationPrompt(
    agentType,
    sessionId,
    sanitizedOutput || effectiveOutput,
  );

  // Dump debug snapshot for offline analysis (opt-in via PTYServiceConfig.debug)
  if (ctx.debugSnapshots) {
    await writeStallSnapshot(
      sessionId,
      agentType,
      recentOutput,
      effectiveOutput,
      buffers,
      traceEntries,
      log,
    );
  }

  try {
    log(`Stall detected for ${sessionId}, asking LLM to classify...`);
    const result = await withTrajectoryContext(
      runtime,
      {
        source: "orchestrator",
        decisionType: "stall-classification",
        sessionId,
      },
      () => runtime.useModel(ModelType.TEXT_SMALL, { prompt: systemPrompt }),
    );

    const parsed = parseStallClassificationResponse(result);
    if (!parsed) {
      log(`Stall classification: no parseable JSON in LLM response`);
      return null;
    }
    // Map tool_running → still_working (StallClassification doesn't have tool_running).
    //
    // Also downgrade task_complete → still_working. The stall classifier LLM
    // guesses from raw stripped-ANSI terminal buffer text, which cannot
    // reliably distinguish "agent is truly finished" from "shell prompt
    // showed up between tool calls" or "intermediate command exited with a
    // summary". Treating this LLM's task_complete guess as a completion
    // signal causes the coordinator's turn-complete pipeline to fire
    // mid-work and re-inject the original prompt, creating an infinite
    // retry loop for long open-ended tasks.
    //
    // Task completion is signaled authoritatively by the agent's own hook
    // system (routed through pty-service.handleHookEvent) and by the
    // jsonl-based completion watcher in the eliza package. The stall
    // classifier is still useful for detecting waiting_for_input and error
    // states, which is why we don't short-circuit those paths.
    let mappedState: StallClassification["state"];
    if (parsed.state === "tool_running" || parsed.state === "task_complete") {
      mappedState = "still_working";
      if (parsed.state === "task_complete") {
        log(
          `Stall classification for ${sessionId}: LLM said task_complete — downgrading to still_working (authoritative completion comes from hooks, not buffer guessing)`,
        );
      }
    } else {
      mappedState = parsed.state as StallClassification["state"];
    }
    const classification: StallClassification = {
      state: mappedState,
      prompt: parsed.prompt,
      suggestedResponse: parsed.suggestedResponse,
    };
    if (
      classification.state === "waiting_for_input" &&
      promptLooksLikeFalseBlockedNoise(classification.prompt, ctx.lastSentInput)
    ) {
      log(
        `Stall classification override for ${sessionId}: prompt looked like echoed input / status noise`,
      );
      return { state: "still_working" };
    }
    log(
      `Stall classification for ${sessionId}: ${classification.state}${classification.suggestedResponse ? ` → "${classification.suggestedResponse}"` : ""}`,
    );
    return classification;
  } catch (err) {
    log(`Stall classification failed: ${err}`);
    return null;
  }
}

// ─── Combined Classify + Decide (for coordinator-managed autonomous sessions) ───

/** Context for the combined classify-and-decide call. */
export interface CoordinatorClassifyContext extends StallClassifierContext {
  taskContext: TaskContextSummary;
  decisionHistory?: DecisionHistoryEntry[];
}

const validStallStates = [
  "waiting_for_input",
  "still_working",
  "task_complete",
  "error",
  "tool_running",
];

function normalizeNullableString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return undefined;
  return value;
}

function parseStallClassificationResponse(
  result: string,
): { state: string; prompt?: string; suggestedResponse?: string } | null {
  const parsedJson = parseJsonObjectResponse<Record<string, unknown>>(result);
  if (parsedJson && validStallStates.includes(String(parsedJson.state))) {
    return {
      state: String(parsedJson.state),
      prompt: normalizeNullableString(parsedJson.prompt),
      suggestedResponse: normalizeNullableString(parsedJson.suggestedResponse),
    };
  }

  return null;
}

/**
 * Build a combined prompt that classifies the stall AND decides how to respond,
 * merging stall classification with coordinator decision guidelines.
 *
 * Used for coordinator-managed sessions in autonomous mode to eliminate the
 * redundant second LLM call in the coordinator's handleBlocked path.
 */
export function buildCombinedClassifyDecidePrompt(
  agentType: string,
  sessionId: string,
  output: string,
  taskContext: TaskContextSummary,
  decisionHistory: DecisionHistoryEntry[],
): string {
  const historySection =
    decisionHistory.length > 0
      ? `\nPrevious decisions for this session:\n${decisionHistory
          .slice(-5)
          .map(
            (d, i) =>
              `  ${i + 1}. [${d.event}] prompt="${d.promptText}" → ${d.action}${d.response ? ` ("${d.response}")` : ""} — ${d.reasoning}`,
          )
          .join("\n")}\n`
      : "";

  return (
    `You are Eliza, an AI orchestrator managing task-agent sessions. ` +
    `A ${agentType} task agent (session: ${sessionId}) appears to have stalled — ` +
    `it has stopped producing output while in a busy state.\n\n` +
    `Original task: "${taskContext.originalTask}"\n` +
    `Working directory: ${taskContext.workdir}\n` +
    `Repository: ${taskContext.repo ?? "none (scratch directory)"}\n` +
    historySection +
    `\nHere is the recent terminal output:\n` +
    `---\n${output.slice(-1500)}\n---\n\n` +
    `Classify what's happening AND decide how to respond. Read the output carefully.\n\n` +
    `Classification states:\n\n` +
    `1. "task_complete" — The agent FINISHED its task and returned to its idle prompt. ` +
    `Strong indicators: a summary of completed work, timing info, ` +
    `or the agent's main prompt symbol (❯) appearing AFTER completion output.\n\n` +
    `2. "waiting_for_input" — The agent is MID-TASK and blocked on a specific question or permission prompt. ` +
    `Examples: Y/n confirmation, file permission dialogs, tool approval prompts, interactive menus.\n\n` +
    `3. "still_working" — The agent is actively processing (API call, compilation, thinking). ` +
    `No prompt or completion summary visible.\n\n` +
    `4. "error" — The agent hit an error state (crash, unrecoverable error, stack trace).\n\n` +
    `5. "tool_running" — The agent is using an external tool (browser automation, MCP tool, etc.).\n\n` +
    `Ignore echoed user input, copied prior transcripts, spinner fragments, and status rows like ` +
    `"Working (12s • esc to interrupt)" or "97% left" — those indicate active work, not a live prompt.\n\n` +
    `If "waiting_for_input", you must also decide how to respond. Guidelines:\n` +
    `- IMPORTANT: If the prompt asks to approve access to files or directories OUTSIDE the working ` +
    `directory (${taskContext.workdir}), DECLINE the request. Respond with "n" and tell the agent: ` +
    `"That path is outside your workspace. Use ${taskContext.workdir} instead."\n` +
    `- For tool approval prompts (file writes, shell commands), respond "y" or use "keys:enter".\n` +
    `- For Y/n confirmations that align with the original task, respond "y".\n` +
    `- For TUI menus, use "keys:enter" for default or "keys:down,enter" for non-default.\n` +
    `- If the prompt asks for information NOT in the original task, set suggestedResponse to null ` +
    `(this will escalate to the human).\n` +
    `- If a PR was just created, the task is likely done — classify as "task_complete".\n\n` +
    `Respond with JSON only:\n` +
    `{"state":"waiting_for_input","prompt":"The exact prompt text, or blank if none.","suggestedResponse":"y"}`
  );
}

/**
 * Combined classify-and-decide for coordinator-managed autonomous sessions.
 *
 * Performs classification AND coordinator-quality response decision in a single
 * LLM call. The suggestedResponse is kept intact (not stripped), so pty-manager
 * auto-responds and the coordinator receives autoResponded: true — skipping
 * the second LLM call in handleBlocked().
 */
export async function classifyAndDecideForCoordinator(
  ctx: CoordinatorClassifyContext,
): Promise<StallClassification | null> {
  const {
    sessionId,
    recentOutput,
    agentType,
    buffers,
    traceEntries,
    runtime,
    manager,
    metricsTracker,
    taskContext,
    decisionHistory = [],
    log,
  } = ctx;

  metricsTracker.incrementStalls(agentType);

  // Buffer fallback — same logic as classifyStallOutput
  let effectiveOutput = recentOutput;
  if (!recentOutput || recentOutput.trim().length < 200) {
    const ourBuffer = buffers.get(sessionId);
    if (ourBuffer && ourBuffer.length > 0) {
      const rawTail = ourBuffer.slice(-100).join("\n");
      const stripped = stripAnsi(rawTail);
      if (stripped.length > effectiveOutput.length) {
        effectiveOutput = stripped;
        log(
          `Using own buffer for combined classify+decide (${effectiveOutput.length} chars after stripping, pty-manager had ${recentOutput.length})`,
        );
      }
    }
  }

  const {
    sanitized: sanitizedOutput,
    removedEchoLines,
    removedStatusLines,
  } = sanitizeOutputForClassification(effectiveOutput, ctx.lastSentInput);
  if (removedEchoLines > 0 || removedStatusLines > 0) {
    log(
      `Sanitized combined stall output for ${sessionId}: removed ${removedEchoLines} echoed lines and ${removedStatusLines} status lines`,
    );
  }
  if (!sanitizedOutput && removedEchoLines + removedStatusLines > 0) {
    log(
      `Combined classify+decide short-circuit for ${sessionId}: only echoed input / status noise remained`,
    );
    return { state: "still_working" };
  }

  const systemPrompt = buildCombinedClassifyDecidePrompt(
    agentType,
    sessionId,
    sanitizedOutput || effectiveOutput,
    taskContext,
    decisionHistory,
  );

  if (ctx.debugSnapshots) {
    await writeStallSnapshot(
      sessionId,
      agentType,
      recentOutput,
      effectiveOutput,
      buffers,
      traceEntries,
      log,
    );
  }

  try {
    log(
      `Stall detected for coordinator-managed ${sessionId}, combined classify+decide...`,
    );
    const result = await withTrajectoryContext(
      runtime,
      {
        source: "orchestrator",
        decisionType: "stall-classify-decide",
        sessionId,
        taskLabel: taskContext.label,
        repo: taskContext.repo,
        workdir: taskContext.workdir,
        originalTask: taskContext.originalTask,
      },
      () => runtime.useModel(ModelType.TEXT_SMALL, { prompt: systemPrompt }),
    );

    const parsed = parseStallClassificationResponse(result);
    if (!parsed) {
      log(`Combined classify+decide: no parseable JSON in LLM response`);
      return null;
    }

    // Same downgrade rationale as classifyStallOutput: the LLM's task_complete
    // guess from buffer text is unreliable on long multi-step tasks. Authoritative
    // completion comes from the agent's hook system (pty-service.handleHookEvent)
    // and the jsonl-based completion watcher in the eliza package.
    let mappedState: StallClassification["state"];
    if (parsed.state === "tool_running" || parsed.state === "task_complete") {
      mappedState = "still_working";
      if (parsed.state === "task_complete") {
        log(
          `Combined classify+decide for ${sessionId}: LLM said task_complete — downgrading to still_working (authoritative completion comes from hooks)`,
        );
      }
    } else {
      mappedState = parsed.state as StallClassification["state"];
    }

    // Deterministic safety guard: if the LLM approved access to a path
    // outside the workspace, override with a decline. This runs before
    // pty-manager auto-responds, so the unsafe approval never reaches the agent.
    if (mappedState === "waiting_for_input" && parsed.suggestedResponse) {
      const promptText = typeof parsed.prompt === "string" ? parsed.prompt : "";
      const responseText = parsed.suggestedResponse.trim().toLowerCase();
      const approving = ["y", "yes", "keys:enter", "keys:down,enter"].includes(
        responseText,
      );
      const hasAbsPath = /(?:^|[\s"'`])\/[^\s"'`]+/.test(promptText);
      if (
        approving &&
        hasAbsPath &&
        !promptText.includes(taskContext.workdir)
      ) {
        log(
          `Combined classify+decide: overriding out-of-scope approval for ${sessionId}`,
        );
        parsed.suggestedResponse = `n — That path is outside your workspace. Use ${taskContext.workdir} instead.`;
      }
    }

    const classification: StallClassification = {
      state: mappedState,
      prompt: parsed.prompt,
      suggestedResponse: parsed.suggestedResponse,
    };
    if (
      classification.state === "waiting_for_input" &&
      promptLooksLikeFalseBlockedNoise(classification.prompt, ctx.lastSentInput)
    ) {
      log(
        `Combined classify+decide override for ${sessionId}: prompt looked like echoed input / status noise`,
      );
      return { state: "still_working" };
    }
    log(
      `Combined classify+decide for ${sessionId}: ${classification.state}${classification.suggestedResponse ? ` → "${classification.suggestedResponse}"` : ""}`,
    );
    if (classification.state === "task_complete") {
      const session = manager?.get(sessionId);
      const durationMs = session?.startedAt
        ? Date.now() - new Date(session.startedAt).getTime()
        : 0;
      metricsTracker.recordCompletion(agentType, "classifier", durationMs);
    }
    return classification;
  } catch (err) {
    log(`Combined classify+decide failed: ${err}`);
    return null;
  }
}
