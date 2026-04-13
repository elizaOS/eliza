/**
 * Shared helpers for action handlers reading LLM response text.
 *
 * Originally this module was a plain module-global pass-through used by
 * the autonomous loop in `ScapeGameService` to stash the raw LLM output
 * before dispatching any Actions. That design had a latent bug: if
 * elizaOS ever routed a human message (or any non-autonomous path) into
 * one of our Action handlers, the handler would pull params from the
 * *last* LLM response instead of the current message — leaking stale
 * coordinates, stale slots, stale NPC ids into operator-triggered
 * dispatches.
 *
 * We keep the global as a backward-compat fallback but prefer reading
 * directly from `message.content.text`, and every Action's `validate()`
 * now requires the current message to actually contain the action's
 * XML tag. That narrows Action dispatch to messages that were produced
 * for this plugin, and prevents stale-state leakage on any other path.
 *
 * Autonomous loop path:
 *   ScapeGameService.autonomousStep
 *     ↳ runtime.useModel → raw string
 *     ↳ setCurrentLlmResponse(raw)            ← still useful as a hint
 *     ↳ dispatchFromLoop(parsed)              ← bypasses Actions entirely
 *
 * Action path (operator / elizaOS routing):
 *   runtime.processActions(message)
 *     ↳ validate(runtime, message)            ← hasActionTag(message, "WALK_TO")
 *     ↳ handler(runtime, message, …)          ← reads message.content.text
 */

import type { Memory } from "@elizaos/core";

let currentLlmResponse = "";

export function setCurrentLlmResponse(text: string): void {
  currentLlmResponse = text;
}

export function getCurrentLlmResponse(): string {
  return currentLlmResponse;
}

/**
 * Prefer the current message text; fall back to the module-level
 * autonomous-loop buffer if the message has no text. Handlers should
 * always call this instead of reading {@link getCurrentLlmResponse}
 * directly so the operator-triggered path works correctly.
 */
export function resolveActionText(message: Memory | undefined | null): string {
  const text = message?.content?.text;
  if (typeof text === "string" && text.trim().length > 0) {
    return text;
  }
  return currentLlmResponse;
}

/**
 * Return true when the given message is plausibly dispatching the named
 * action — i.e. contains `<action>NAME</action>` (case-insensitive). Used
 * by Action `validate()` functions so elizaOS doesn't dispatch arbitrary
 * plugin actions on arbitrary messages.
 */
export function hasActionTag(
  message: Memory | undefined | null,
  actionName: string,
): boolean {
  const text = message?.content?.text;
  if (typeof text !== "string" || text.length === 0) return false;
  const pattern = new RegExp(
    `<action>\\s*${escapeRegex(actionName)}\\s*</action>`,
    "i",
  );
  return pattern.test(text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
