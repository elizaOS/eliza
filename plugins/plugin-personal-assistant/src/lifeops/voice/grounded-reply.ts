/**
 * Gives LifeOps actions the shared model-authored reply contract and character
 * voice. Grounding templates are model input, never fallback delivery text.
 * Callers preserve action outcomes when rendering is unavailable and invoke
 * visible callbacks only for the model variant.
 */

import { renderGroundedActionReply } from "@elizaos/agent";
import type {
  GroundedActionReply,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

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
): Promise<GroundedActionReply> {
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
  const value = message.content.text;
  return typeof value === "string" ? value : "";
}
