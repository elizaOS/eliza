/** Host turn custody for the same-call negative Notes classification. */
import {
  beginRequestOperationIssuer,
  getDirectActionRoutingRules,
  getStreamingContext,
  type IAgentRuntime,
  type Memory,
  type MessageHandlerResult,
  type NotesRequestInterpretation,
  promotedSubactionDescription,
  type RequestOperationClassification,
} from "@elizaos/core";
import {
  getActionInferenceMessageText,
  isSubAgentCompletionArtifact,
} from "./dialogue-context.js";

/** Reuse existing registered current-request ownership only as a negative
 * contradiction veto. No new text parser, gate execution or write permission.
 * The registered routes have limited phrasing coverage; absence proves nothing.
 */
export function resolveNotesRequestHostRestriction(
  runtime: IAgentRuntime,
  message: Memory,
  classification: RequestOperationClassification,
  interpretation?: NotesRequestInterpretation,
): MessageHandlerResult["plan"]["notesRequestHostRestriction"] {
  if (
    (classification !== "read_only" && interpretation?.status !== "explicit") ||
    isSubAgentCompletionArtifact(message)
  )
    return;
  const text = getActionInferenceMessageText(message);
  for (const rule of getDirectActionRoutingRules(runtime)) {
    const tags = new Set(
      rule.requiredActionTags.map((tag) => tag.trim().toLowerCase()),
    );
    if (
      !tags.has("resource:notes") ||
      !(
        tags.has("capability:write") ||
        tags.has("capability:update") ||
        tags.has("capability:delete")
      )
    )
      continue;
    try {
      if (!rule.matches(text, message)) continue;
      const operations = rule.actionNames.map((name) => {
        const action = runtime.actions.find(
          (candidate) => candidate.name === name,
        );
        const promoted = action && promotedSubactionDescription(action);
        const parent =
          promoted &&
          runtime.actions.find(
            (candidate) => candidate.name === promoted.parent,
          );
        if (!parent?.tags?.includes("resource:notes")) return undefined;
        return promoted?.subaction;
      });
      const mutations = operations.filter(
        (operation): operation is string =>
          operation === "create" ||
          operation === "update" ||
          operation === "patch" ||
          operation === "delete",
      );
      const resolved =
        operations.length > 0 && mutations.length === operations.length;
      if (
        classification !== "read_only" &&
        resolved &&
        interpretation?.status === "explicit" &&
        mutations.every((operation) =>
          interpretation.operations.some(
            (requested) => requested === operation,
          ),
        )
      )
        continue;
      return {
        classification: "unresolved",
        reason: resolved
          ? "registered-current-mutation-route"
          : "registered-route-ambiguous",
        routeIds: [rule.id],
        operations: [...new Set(mutations)],
      };
    } catch (error) {
      runtime.reportError("NotesRequestHostRestriction.route", error, {
        routeId: rule.id,
      });
      return {
        classification: "unresolved",
        reason: "registered-route-ambiguous",
        routeIds: [rule.id],
        operations: [],
      };
    }
  }
}

export function beginStage1NotesRequestIssuer(
  runtime: IAgentRuntime,
  message: Memory,
) {
  const owned = getStreamingContext();
  const rootSignal = owned?.abortSignal;
  // turn-lifetime.ts supplies the canonical original incoming ID, including
  // unbounded turns; messageId itself may instead be an assistant stream ID.
  const incomingTurn = owned?.modelAttemptTurnId;
  if (
    !owned ||
    !rootSignal ||
    rootSignal.aborted ||
    !message.id ||
    incomingTurn !== String(message.id)
  )
    return undefined;
  // This existing host-only carrier is inherited by same-turn wrappers and
  // replaced on a foreign turn. It is identity, never a permission rule.
  const turn = (owned.actionConstraints ??= new Map());
  return beginRequestOperationIssuer({
    runtime,
    message,
    current: () => {
      const active = getStreamingContext();
      return (
        active?.actionConstraints === turn &&
        !rootSignal.aborted &&
        !!active.abortSignal &&
        !active.abortSignal.aborted &&
        // Some same-turn suppression contexts omit this field and retain the
        // opaque Map. An explicit different incoming turn is never accepted.
        (active.modelAttemptTurnId === undefined ||
          active.modelAttemptTurnId === incomingTurn)
      );
    },
  });
}
