/**
 * Wrapper around the agent-package `renderGroundedActionReply` for lifeops
 * actions.
 *
 * Lifeops actions historically streamed hand-formatted template strings to
 * the user via `callback?.({ text })` and also returned that same string in
 * `ActionResult.text`. Most also set `suppressPostActionContinuation: true`,
 * so the runtime never gets a chance to chain REPLY and re-voice the output.
 * The result is two distinct voices in the same conversation: warm/in-character
 * planner replies vs. robotic action templates.
 *
 * This helper centralizes the lifeops re-voicing convention:
 *
 *   const text = await renderLifeOpsActionReply({
 *     runtime, message, state,
 *     intent: messageText(message).trim(),
 *     scenario: "screen_time_summary",
 *     fallback: rawTemplateString,
 *     context: { summary, totalSeconds },
 *   });
 *   await callback?.({ text, source: "action", action: "SCREEN_TIME" });
 *   return { text, success: true, data: {...} };
 *
 * Defaults set here: `domain: "lifeops"`, `preferCharacterVoice: true`. The
 * canonical template (`fallback`) is preserved verbatim by the underlying
 * rewriter when the model returns structured/JSON output or the call throws.
 */

import { renderGroundedActionReply } from "@elizaos/agent";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

export type RenderLifeOpsActionReplyArgs = {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
  additionalRules?: string[];
};

export async function renderLifeOpsActionReply(
  args: RenderLifeOpsActionReplyArgs,
): Promise<string> {
  return renderGroundedActionReply({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    intent: args.intent,
    domain: "lifeops",
    scenario: args.scenario,
    fallback: args.fallback,
    context: args.context,
    additionalRules: args.additionalRules,
    preferCharacterVoice: true,
  });
}

export function messageText(message: Memory): string {
  const value = message?.content?.text;
  return typeof value === "string" ? value : "";
}
