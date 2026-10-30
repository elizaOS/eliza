/** Determines whether a completed response warrants post-turn semantic work or represents a stop decision. */

import type {
  ActionResult,
  Content,
  Memory,
  MessageHandlerExtract,
  State,
} from "@elizaos/core";
import { getUserMessageText, isDiscoveryActionName } from "@elizaos/core";
import { isReplyActionIdentifier } from "./action-identifiers.js";
import { escapeRegex } from "./addressing.ts";
import {
  type StructuredToolEffect,
  structuredEffectFromToolResult,
} from "./structured-tool-effect.ts";

export function isSimpleReplyResponse(
  responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
  return !!(
    responseContent?.actions &&
    responseContent.actions.length === 1 &&
    typeof responseContent.actions[0] === "string" &&
    isReplyActionIdentifier(responseContent.actions[0])
  );
}

/** A view switch records where the UI went, never anything about the user. */
function viewNavigationEffect(
  result: ActionResult,
): StructuredToolEffect | undefined {
  if (result.effectReceipts?.length) return undefined;
  const effect = structuredEffectFromToolResult(result);
  return effect?.effect === "view_navigation" ? effect : undefined;
}

export const POST_TURN_SEMANTIC_SIGNAL =
  /(?:https?:\/\/|\b(?:i am|i'm|i have|i've|i feel|i like|i love|i hate|i prefer|i need|i want|my|we|our|remember|friend|partner|wife|husband|relationship|work at|live in|located in|goal|plan)\b)/i;

export function hasPostTurnSemanticSignal(
  message: Pick<Memory, "content">,
  state: Pick<State, "data"> | undefined,
  responseContent: Pick<Content, "actions"> | null | undefined,
  extract?: Pick<MessageHandlerExtract, "facts" | "relationships">,
): boolean {
  // Stage 1 already detected semantic evidence. A lexical shortcut must not
  // suppress its durable review; the background worker still validates sources.
  if (extract?.facts?.length || extract?.relationships?.length) return true;
  if (!isSimpleReplyResponse(responseContent)) return true;
  // Navigation-only turns fall through to the message-text check below. The
  // discovery that loaded the view action does no domain work of its own.
  const stateResults = state?.data?.actionResults;
  const actionResults = Array.isArray(stateResults) ? stateResults : [];
  const navigations = actionResults.map(viewNavigationEffect);
  const navigated = navigations.some(Boolean);
  if (
    actionResults.some(
      (result, index) =>
        !navigations[index] &&
        !(
          navigated &&
          typeof result.data?.actionName === "string" &&
          isDiscoveryActionName(result.data.actionName)
        ),
    )
  )
    return true;
  // The user's words, not the help-document envelope chat augmentation wraps
  // around a short command: its FAQ fragments ("show my tasks") matched the
  // signal on every navigation turn they were attached to.
  let text = getUserMessageText(message);
  // "Open my calendar" names the receipt's destination, not a user fact.
  for (const effect of navigations)
    for (const name of [effect?.label, effect?.viewId, effect?.resolvedAlias])
      if (name)
        text = text.replace(
          new RegExp(`\\b(?:my|our)\\s+${escapeRegex(name)}\\b`, "gi"),
          " ",
        );
  return POST_TURN_SEMANTIC_SIGNAL.test(text);
}

export function isStopResponse(
  responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
  return !!(
    responseContent?.actions &&
    responseContent.actions.length === 1 &&
    typeof responseContent.actions[0] === "string" &&
    responseContent.actions[0].toUpperCase() === "STOP"
  );
}
