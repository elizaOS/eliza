/**
 * Prompt construction and response parsing for the Swarm Coordinator's
 * LLM-driven coordination decisions.
 *
 * Pure functions — no side effects, easy to test.
 * Pattern follows stall-classifier.ts:buildStallClassificationPrompt().
 *
 * @module services/swarm-coordinator-prompts
 */

import { parseJsonObjectResponse } from "./json-model-output.js";

/** Per-session task context provided to the LLM for decision-making. */
export interface TaskContextSummary {
  sessionId: string;
  agentType: string;
  label: string;
  originalTask: string;
  workdir: string;
  repo?: string;
}

/** A previous coordination decision, included for context continuity. */
export interface DecisionHistoryEntry {
  event: string;
  promptText: string;
  action: string;
  response?: string;
  reasoning: string;
}

/** Summary of a sibling task in the same swarm — for cross-task context. */
export interface SiblingTaskSummary {
  label: string;
  agentType: string;
  originalTask: string;
  status: string;
  /** Last significant decision or action taken by this sibling. */
  lastKeyDecision?: string;
  /** Summary of what the sibling accomplished (populated on completion). */
  completionSummary?: string;
}

/** A significant creative or architectural decision made by an agent in the swarm. */
export interface SharedDecision {
  /** Which agent made this decision. */
  agentLabel: string;
  /** Brief description of the decision. */
  summary: string;
  /** When it was recorded. */
  timestamp: number;
}

/**
 * Build a context section describing sibling tasks in the same swarm.
 * Helps the coordinator make decisions with awareness of the broader project.
 */
function buildSiblingSection(siblings?: SiblingTaskSummary[]): string {
  if (!siblings || siblings.length === 0) return "";
  const lines = siblings.map((s) => {
    let line = `  - [${s.status}] "${s.label}" (${s.agentType}): ${s.originalTask}`;
    if (s.completionSummary) {
      line += `\n    Result: ${s.completionSummary}`;
    } else if (s.lastKeyDecision) {
      line += `\n    Latest: ${s.lastKeyDecision}`;
    }
    return line;
  });
  return (
    `\nOther agents in this swarm:\n` +
    lines.join("\n") +
    `\nUse this context when the agent asks creative or architectural questions — ` +
    `your answer should be consistent with what sibling agents are doing.\n`
  );
}

/**
 * Build a context section describing significant decisions made by other agents.
 * Helps maintain consistency across the swarm regardless of task type.
 */
function buildSharedDecisionsSection(decisions?: SharedDecision[]): string {
  if (!decisions || decisions.length === 0) return "";
  return (
    `\nKey decisions made by other agents in this swarm:\n` +
    decisions
      .slice(-10)
      .map((d) => `  - [${d.agentLabel}] ${d.summary}`)
      .join("\n") +
    `\nAlign with these decisions for consistency — don't contradict them unless the task requires it.\n`
  );
}

/** Build a project context section from the swarm planning phase. */
function buildSwarmContextSection(swarmContext?: string): string {
  if (!swarmContext) return "";
  return `\nProject context (from planning phase):\n${swarmContext}\n`;
}

/** Parsed LLM response for a coordination decision. */
export interface CoordinationLLMResponse {
  action: "respond" | "escalate" | "ignore" | "complete";
  /** Text to send (for action=respond with plain text input). */
  response?: string;
  /** Whether to use sendKeysToSession instead of sendToSession. */
  useKeys?: boolean;
  /** Key sequence to send (for TUI interactions). e.g. ["enter"] or ["down","enter"]. */
  keys?: string[];
  /** LLM's reasoning for the decision. */
  reasoning: string;
  /** Brief summary of a significant creative/architectural decision the agent made, if any. */
  keyDecision?: string;
}

/**
 * Build the LLM prompt for making a coordination decision about a blocked agent.
 */
export function buildCoordinationPrompt(
  taskCtx: TaskContextSummary,
  promptText: string,
  recentOutput: string,
  decisionHistory: DecisionHistoryEntry[],
  siblingTasks?: SiblingTaskSummary[],
  sharedDecisions?: SharedDecision[],
  swarmContext?: string,
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
    `You are Eliza, an AI orchestrator managing a swarm of task agents. ` +
    `A ${taskCtx.agentType} task agent ("${taskCtx.label}", session: ${taskCtx.sessionId}) ` +
    `is blocked and waiting for input.\n\n` +
    `Original task: "${taskCtx.originalTask}"\n` +
    `Working directory: ${taskCtx.workdir}\n` +
    `Repository: ${taskCtx.repo ?? "none (scratch directory)"}\n` +
    buildSwarmContextSection(swarmContext) +
    buildSiblingSection(siblingTasks) +
    buildSharedDecisionsSection(sharedDecisions) +
    historySection +
    `\nRecent terminal output (last 50 lines):\n` +
    `---\n${recentOutput.slice(-3000)}\n---\n\n` +
    `The agent is showing this blocking prompt:\n` +
    `"${promptText}"\n\n` +
    `Decide how to respond. Your options:\n\n` +
    `1. "respond" — Send a response to unblock the agent. For text prompts (Y/n, questions), ` +
    `set "response" to the text to send. For TUI menus or interactive prompts that need ` +
    `special keys, set "useKeys": true and "keys" to the key sequence ` +
    `(e.g. ["enter"], ["down","enter"], ["y","enter"]).\n\n` +
    `2. "complete" — The original task has been fulfilled. The agent has finished its work ` +
    `(e.g. code written, PR created, tests passed) and is back at the idle prompt. ` +
    `Use this when the terminal output shows the task objectives have been met.\n\n` +
    `3. "escalate" — The prompt requires human judgment (e.g. design decisions, ` +
    `ambiguous requirements, security-sensitive actions). Do NOT respond yourself.\n\n` +
    `4. "ignore" — The prompt is not actually blocking or is already being handled.\n\n` +
    `Guidelines:\n` +
    `- IMPORTANT: If the prompt asks to approve access to files or directories OUTSIDE the working ` +
    `directory (${taskCtx.workdir}), DECLINE the request and REDIRECT the agent. Do NOT approve ` +
    `access to paths like /etc, ~/.ssh, ~/, /tmp, or any path that doesn't start with the working ` +
    `directory. Instead, respond with "n" (or the decline option) and tell the agent: ` +
    `"That path is outside your workspace. Use ${taskCtx.workdir} instead — ` +
    `create any files or directories you need there." This keeps the agent moving without ` +
    `granting out-of-scope access. The coordinator will also notify the human in case ` +
    `broader access was intended.\n` +
    `- For tool approval prompts (file writes, shell commands, etc.), respond "y" or use keys:["enter"] to approve.\n` +
    `- For Y/n confirmations that align with the original task, respond "y".\n` +
    `- For design questions or choices that could go either way, escalate.\n` +
    `- For error recovery prompts, try to respond if the path forward is clear.\n` +
    `- If the output shows a PR was just created (e.g. "Created pull request #N"), use "complete" — the task is done.\n` +
    `- If the agent is asking for information that was NOT provided in the original task ` +
    `(e.g. which repository to use, project requirements, credentials), ESCALATE. ` +
    `The coordinator does not have this information — the human must provide it.\n` +
    `- When in doubt, escalate — it's better to ask the human than to make a wrong choice.\n` +
    `- If the agent's output reveals a significant decision that sibling agents should know about ` +
    `(e.g. chose a library, designed an API shape, picked a UI pattern, established a writing style, ` +
    `narrowed a research scope, made any choice that affects the shared project), ` +
    `include "keyDecision" with a brief one-line summary. Skip this for routine tool approvals.\n` +
    `- Look for explicit "DECISION:" markers in the agent's output — these are the agent deliberately ` +
    `surfacing design choices. Always capture these as keyDecision.\n\n` +
    `Respond with JSON only:\n` +
    `{"action":"respond","response":"y","useKeys":false,"keys":[],"reasoning":"One short reason.","keyDecision":"Optional one-line shared decision."}`
  );
}

/**
 * Build the LLM prompt for checking on an idle session that hasn't
 * produced any events for a while.
 */
export function buildIdleCheckPrompt(
  taskCtx: TaskContextSummary,
  recentOutput: string,
  idleMinutes: number,
  idleCheckNumber: number,
  maxIdleChecks: number,
  decisionHistory: DecisionHistoryEntry[],
  siblingTasks?: SiblingTaskSummary[],
  sharedDecisions?: SharedDecision[],
  swarmContext?: string,
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
    `You are Eliza, an AI orchestrator managing a swarm of task agents. ` +
    `A ${taskCtx.agentType} task agent ("${taskCtx.label}", session: ${taskCtx.sessionId}) ` +
    `has been idle for ${idleMinutes} minutes with no events or output changes.\n\n` +
    `Original task: "${taskCtx.originalTask}"\n` +
    `Working directory: ${taskCtx.workdir}\n` +
    `Repository: ${taskCtx.repo ?? "none (scratch directory)"}\n` +
    `Idle check: ${idleCheckNumber} of ${maxIdleChecks} (session will be force-escalated after ${maxIdleChecks})\n` +
    buildSwarmContextSection(swarmContext) +
    buildSiblingSection(siblingTasks) +
    buildSharedDecisionsSection(sharedDecisions) +
    historySection +
    `\nRecent terminal output (last 50 lines):\n` +
    `---\n${recentOutput.slice(-3000)}\n---\n\n` +
    `The session has gone silent. Analyze the terminal output and decide:\n\n` +
    `1. "complete" — The task is FULLY done. ALL objectives in the original task were met ` +
    `AND the final deliverable is visible in the output (e.g. a PR URL was printed, or the ` +
    `task explicitly did not require a PR). The agent is back at the idle prompt.\n\n` +
    `2. "respond" — The agent appears stuck or waiting for input that wasn't detected ` +
    `as a blocking prompt. Send a message to nudge it (e.g. "continue", or answer a question ` +
    `visible in the output). If code was committed but no PR was created yet, respond with ` +
    `"please create a pull request with your changes" or similar.\n\n` +
    `3. "escalate" — Something looks wrong or unclear. The human should review.\n\n` +
    `4. "ignore" — The agent is still actively working (e.g. compiling, running tests, ` +
    `pushing to remote, creating a PR). The idle period is expected and it will produce output soon.\n\n` +
    `Guidelines:\n` +
    `- IMPORTANT: Do NOT mark "complete" if the original task involves creating a PR and no PR URL ` +
    `(e.g. github.com/...pull/...) appears in the output. Instead use "respond" to nudge the agent ` +
    `to create the PR.\n` +
    `- Do NOT mark "complete" just because code was committed — commits alone don't finish a task ` +
    `that requires a PR.\n` +
    `- Network operations (git push, gh pr create, API calls) can cause several minutes of silence — ` +
    `prefer "ignore" for early idle checks if the agent was mid-workflow.\n` +
    `- If the output ends with a command prompt ($ or >) and ALL task objectives are confirmed met, use "complete".\n` +
    `- If the output shows an error or the agent seems stuck in a loop, escalate.\n` +
    `- If the agent is clearly mid-operation (build output, test runner, git operations), use "ignore".\n` +
    `- On check ${idleCheckNumber} of ${maxIdleChecks} — if unsure, lean toward "respond" with a nudge rather than "complete".\n` +
    `- If the agent's output reveals a significant creative or architectural decision, ` +
    `include "keyDecision" with a brief one-line summary.\n` +
    `- Look for explicit "DECISION:" markers in the agent's output — always capture these as keyDecision.\n\n` +
    // CRITICAL constraint on the `response` field — fixes a real bug
    // where LLMs produced 3rd-person status reports that then got
    // piped verbatim into the agent's stdin as if the user typed them.
    `CRITICAL — "response" field format rules:\n` +
    `- When action is "respond", the "response" string is sent VERBATIM into the agent's terminal as if the user typed it.\n` +
    `- It MUST be a brief, second-person imperative addressed directly to the agent. Examples: "continue", "please create the pull request", "answer the question above", "proceed with the next step".\n` +
    `- NEVER write a third-person status report about the agent. Do NOT write things like "The agent is still setting up" or "The agent needs to continue its work" — that text would be piped into the agent's stdin and confuse it into thinking a new user message arrived describing itself.\n` +
    `- NEVER describe the situation in the response field. If you need to explain your reasoning, put it in the "reasoning" field instead.\n` +
    `- Keep the response under 20 words when possible. Short nudges work best.\n\n` +
    `Respond with JSON only:\n` +
    `{"action":"respond","response":"continue","useKeys":false,"keys":[],"reasoning":"One short reason.","keyDecision":"Optional one-line shared decision."}`
  );
}

/**
 * Build the LLM prompt for assessing whether a completed turn means the
 * overall task is done, or if the agent needs more turns.
 *
 * Called when the adapter detects "task_complete" (agent finished a turn and
 * returned to the idle prompt). The LLM decides whether to stop the session
 * or send a follow-up instruction.
 */
export function buildTurnCompletePrompt(
  taskCtx: TaskContextSummary,
  turnOutput: string,
  decisionHistory: DecisionHistoryEntry[],
  siblingTasks?: SiblingTaskSummary[],
  sharedDecisions?: SharedDecision[],
  swarmContext?: string,
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
    `You are Eliza, an AI orchestrator managing a swarm of task agents. ` +
    `A ${taskCtx.agentType} task agent ("${taskCtx.label}", session: ${taskCtx.sessionId}) ` +
    `just finished a turn and is back at the idle prompt waiting for input.\n\n` +
    `Original task: "${taskCtx.originalTask}"\n` +
    `Working directory: ${taskCtx.workdir}\n` +
    `Repository: ${taskCtx.repo ?? "none (scratch directory)"}\n` +
    buildSwarmContextSection(swarmContext) +
    buildSiblingSection(siblingTasks) +
    buildSharedDecisionsSection(sharedDecisions) +
    historySection +
    `\nOutput from this turn:\n` +
    `---\n${turnOutput.slice(-3000)}\n---\n\n` +
    `The agent completed a turn. Decide if the task is done or needs more work.\n\n` +
    `Options:\n` +
    `1. "complete" — The task objectives have been met.\n` +
    `   - For repo tasks: ONLY when a PR creation signal appears ("Created pull request #N"). ` +
    `A generic "done" or "finished" statement is NOT sufficient for repo tasks — a PR must exist.\n` +
    `   - For scratch/research tasks (no repo): when the agent has produced its deliverable.\n` +
    `2. "respond" — The agent needs to do more work.\n` +
    `3. "escalate" — Something is wrong. Let the human decide.\n` +
    `4. "ignore" — The agent is still working (e.g., spinner text like "Germinating...", "Frosting..."). ` +
    `Wait for the next turn.\n\n` +
    `CRITICAL RULES:\n` +
    `- For repo tasks: use "complete" ONLY when "Created pull request #N" appears in output.\n` +
    `- For scratch/research tasks: use "complete" when the agent delivers its output.\n` +
    `- Do NOT ask the agent to review, verify, or re-check work it already completed.\n` +
    `- If output is only spinner text, use "ignore" and wait for the next turn.\n` +
    `- Use "respond" when the agent hasn't started, or when code was written but not yet committed/pushed/PR'd.\n\n` +
    `If the agent's output reveals a significant decision, include "keyDecision" with a brief summary.\n\n` +
    `Respond with JSON only:\n` +
    `{"action":"complete","response":"","useKeys":false,"keys":[],"reasoning":"One short reason.","keyDecision":"Optional one-line shared decision."}`
  );
}

// ─── Event Messages for Eliza Pipeline ───

/**
 * Build a natural language event message describing a blocked agent, intended
 * to be processed by Eliza's full ElizaOS pipeline (with conversation memory,
 * personality, and actions). Unlike buildCoordinationPrompt(), this omits the
 * "You are Eliza" preamble (she already IS Eliza in the pipeline) and asks
 * for a JSON action object at the end of her response.
 */
export function buildBlockedEventMessage(
  taskCtx: TaskContextSummary,
  promptText: string,
  recentOutput: string,
  decisionHistory: DecisionHistoryEntry[],
  siblingTasks?: SiblingTaskSummary[],
  sharedDecisions?: SharedDecision[],
  swarmContext?: string,
): string {
  const historySection =
    decisionHistory.length > 0
      ? `\nPrevious decisions:\n${decisionHistory
          .slice(-5)
          .map(
            (d, i) =>
              `  ${i + 1}. [${d.event}] "${d.promptText}" → ${d.action}${d.response ? ` ("${d.response}")` : ""} — ${d.reasoning}`,
          )
          .join("\n")}\n`
      : "";

  return (
    `[Task Agent Event] A ${taskCtx.agentType} agent ("${taskCtx.label}") is blocked and waiting for input.\n\n` +
    `Task: "${taskCtx.originalTask}"\n` +
    `Workdir: ${taskCtx.workdir}\n` +
    `Repo: ${taskCtx.repo ?? "none (scratch directory)"}\n` +
    buildSwarmContextSection(swarmContext) +
    buildSiblingSection(siblingTasks) +
    buildSharedDecisionsSection(sharedDecisions) +
    historySection +
    `\nRecent terminal output:\n---\n${recentOutput.slice(-3000)}\n---\n\n` +
    `Blocking prompt: "${promptText}"\n\n` +
    `Decide how to handle this. Options:\n` +
    `- "respond" — send text or keys to unblock the agent\n` +
    `- "complete" — the task is fully done\n` +
    `- "escalate" — you need the user's input\n` +
    `- "ignore" — not actually blocking\n\n` +
    `Guidelines:\n` +
    `- For tool approvals / Y/n that align with the task, respond "y" or keys:["enter"].\n` +
    `- If the prompt asks for info NOT in the original task, escalate.\n` +
    `- Decline access to paths outside ${taskCtx.workdir}.\n` +
    `- If a PR was just created, the task is done — use "complete".\n` +
    `- When in doubt, escalate.\n\n` +
    `If the agent's output reveals a significant decision that sibling agents should know about, include "keyDecision" with a brief summary.\n` +
    `Look for explicit "DECISION:" markers in the agent's output — always capture these as keyDecision.\n\n` +
    `Include a JSON action object at the end of your response:\n` +
    `{"action":"respond","response":"y","useKeys":false,"keys":[],"reasoning":"One short reason.","keyDecision":"Optional one-line shared decision."}`
  );
}

/**
 * Build a natural language event message describing a turn completion, intended
 * to be processed by Eliza's full ElizaOS pipeline.
 */
export function buildTurnCompleteEventMessage(
  taskCtx: TaskContextSummary,
  turnOutput: string,
  decisionHistory: DecisionHistoryEntry[],
  siblingTasks?: SiblingTaskSummary[],
  sharedDecisions?: SharedDecision[],
  swarmContext?: string,
): string {
  const historySection =
    decisionHistory.length > 0
      ? `\nPrevious decisions:\n${decisionHistory
          .slice(-5)
          .map(
            (d, i) =>
              `  ${i + 1}. [${d.event}] "${d.promptText}" → ${d.action}${d.response ? ` ("${d.response}")` : ""} — ${d.reasoning}`,
          )
          .join("\n")}\n`
      : "";

  return (
    `[Task Agent Event] A ${taskCtx.agentType} agent ("${taskCtx.label}") just finished a turn and is idle.\n\n` +
    `Task: "${taskCtx.originalTask}"\n` +
    `Workdir: ${taskCtx.workdir}\n` +
    `Repo: ${taskCtx.repo ?? "none (scratch directory)"}\n` +
    buildSwarmContextSection(swarmContext) +
    buildSiblingSection(siblingTasks) +
    buildSharedDecisionsSection(sharedDecisions) +
    historySection +
    `\nTurn output:\n---\n${turnOutput.slice(-3000)}\n---\n\n` +
    `Decide if the overall task is done or if the agent needs more work.\n\n` +
    `Options:\n` +
    `- "respond" — send a follow-up instruction (DEFAULT for intermediate steps)\n` +
    `- "complete" — For repo tasks: ONLY when "Created pull request #N" appears. ` +
    `For scratch/research tasks: when the agent delivers its output.\n` +
    `- "escalate" — something looks wrong, ask the user\n` +
    `- "ignore" — spinner/loading output, agent still working\n\n` +
    `Guidelines:\n` +
    `- For repo tasks, a generic "done" is NOT enough — require a PR creation signal.\n` +
    `- If code was written but not committed/pushed/PR'd, respond with next step.\n` +
    `- Do NOT ask the agent to re-verify work it already completed.\n` +
    `- If the agent's output reveals a significant creative or architectural decision, include "keyDecision" with a brief summary.\n` +
    `- Look for explicit "DECISION:" markers in the agent's output — always capture these as keyDecision.\n\n` +
    `Include a JSON action object at the end of your response:\n` +
    `{"action":"respond","response":"please create the pull request","useKeys":false,"keys":[],"reasoning":"One short reason.","keyDecision":"Optional one-line shared decision."}`
  );
}

/**
 * Parse the LLM's coordination response from raw text output.
 * Returns null if the response is invalid or unparseable.
 */
function normalizeCoordinationResponse(
  parsed: unknown,
): CoordinationLLMResponse | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const validActions = ["respond", "escalate", "ignore", "complete"];
  if (!validActions.includes(String(record.action))) return null;

  const result: CoordinationLLMResponse = {
    action: String(record.action) as CoordinationLLMResponse["action"],
    reasoning:
      typeof record.reasoning === "string" && record.reasoning.trim()
        ? record.reasoning.trim()
        : "No reasoning provided",
  };

  if (result.action === "respond") {
    const useKeys =
      record.useKeys === true ||
      (typeof record.useKeys === "string" &&
        record.useKeys.trim().toLowerCase() === "true");
    if (useKeys) {
      const keys = Array.isArray(record.keys)
        ? record.keys.map(String).filter(Boolean)
        : typeof record.keys === "string" && record.keys.trim()
          ? record.keys
              .split(",")
              .map((key) => key.trim())
              .filter(Boolean)
          : [];
      if (keys.length === 0) return null;
      result.useKeys = true;
      result.keys = keys;
    } else if (typeof record.response === "string" && record.response.trim()) {
      result.response = record.response;
    } else {
      return null;
    }
  }

  if (typeof record.keyDecision === "string" && record.keyDecision.trim()) {
    result.keyDecision = record.keyDecision.trim().slice(0, 240);
  }

  return result;
}

export function parseCoordinationResponse(
  llmOutput: string,
): CoordinationLLMResponse | null {
  const parsedJson =
    parseJsonObjectResponse<Record<string, unknown>>(llmOutput);
  const normalizedJson = normalizeCoordinationResponse(parsedJson);
  if (normalizedJson) return normalizedJson;

  return null;
}
