/**
 * Render a conversation snapshot for the Cerebras (or any external) LLM call.
 *
 * Includes:
 *   - The scenario's room metadata (channel id, kind, owner) so the LLM can
 *     reason about routing.
 *   - The current set of open threads (id, owner, status, instruction, room)
 *     so threadOps can reference real ids.
 *   - Any pending prompts (id, question, asked-in channel) so cross-channel
 *     resolution scenarios (G1) have the needed context.
 *   - The conversation history (chronological).
 *   - The new incoming message, marked clearly.
 */

import type { Scenario, ScenarioScriptStep } from "./types.ts";
import type { SimulatorState } from "./state.ts";

export interface RenderArgs {
  scenario: Scenario;
  history: ScenarioScriptStep[];
  message: ScenarioScriptStep;
  state: SimulatorState;
}

export function renderConversation(args: RenderArgs): string {
  const { scenario, history, message, state } = args;
  const lines: string[] = [];
  lines.push("## Rooms");
  for (const r of scenario.setup.rooms) {
    lines.push(`- ${r.id} (kind=${r.kind}${r.owner ? `, owner=${r.owner}` : ""}${r.members ? `, members=[${r.members.join(", ")}]` : ""})`);
  }

  const activeThreads = [...state.threads.values()].filter((t) => t.status !== "stopped" && t.status !== "completed");
  if (activeThreads.length > 0) {
    lines.push("\n## Active threads (you may reference these workThreadIds)");
    for (const t of activeThreads) {
      lines.push(`- ${t.id} owner=${t.owner} status=${t.status} room=${t.roomId} :: ${t.instruction}`);
    }
  }

  const pendingPrompts = [...state.pendingPrompts.values()].filter((p) => !p.resolved);
  if (pendingPrompts.length > 0) {
    lines.push("\n## Pending prompts (questions the agent asked previously)");
    for (const p of pendingPrompts) {
      lines.push(`- promptId=${p.id} asked-in=${p.askedIn} question="${p.question}"`);
    }
  }

  lines.push("\n## Conversation history (oldest first)");
  if (history.length === 0) {
    lines.push("(empty)");
  } else {
    for (const m of history) {
      lines.push(`[${m.channel}] ${m.sender}: ${m.text}`);
    }
  }

  lines.push("\n## New message");
  lines.push(`[${message.channel}] ${message.sender}: ${message.text}`);
  lines.push("");
  lines.push("Respond with the JSON object only.");
  return lines.join("\n");
}
