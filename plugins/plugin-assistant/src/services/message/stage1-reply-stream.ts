/**
 * Which Stage-1 reply text may stream to the user while it is generated.
 *
 * Stage 1 answers simple turns in `replyText` and writes only an
 * acknowledgement there for planned work. The acknowledgement is replaced by
 * the planner's reply, so it must not stream as the answer. Every routing
 * field (field priority below `replyText`'s 20, builtin-field-evaluators.ts)
 * precedes `replyText` in the HANDLE_RESPONSE envelope, so the runtime can ask
 * this gate, before the first reply byte, whether the attempt is already
 * settled as a direct answer. Anything else holds the attempt and the
 * validated final reply is delivered whole, as before.
 *
 * The streamed text is still a draft: later validation (source quotes, the
 * transcript guard, egress review, message-text routing heuristics, the
 * addressee gate) can change or withdraw it. Hosts deliver it as provisional
 * text and the validated final reply confirms, revises or retracts it.
 */
import type {
  StructuredStreamField,
  StructuredStreamGate,
} from "@elizaos/core";
import { SIMPLE_CONTEXT_ID } from "../../runtime/message-handler";

/**
 * The only Stage-1 field written for the user. In the ordered reply-parts
 * form only `text` parts stream: a `source` part is a quotation the runtime
 * must validate and substitute before it can be shown, so it ends the stream.
 */
export const STAGE1_REPLY_STREAM_FIELDS: readonly StructuredStreamField[] =
  Object.freeze([Object.freeze({ field: "replyText", partKinds: ["text"] })]);

const isEmptyList = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === "string" && entry.trim() === "");

/**
 * Envelope fields that may precede `replyText` on a direct answer, each with
 * the value that keeps the turn off the planner. Any other preceding field is
 * unknown routing input and holds the stream.
 */
const DIRECT_REPLY_PRECEDING_FIELDS: Readonly<
  Record<string, (value: unknown) => boolean>
> = {
  shouldRespond: (value) => value === "RESPOND",
  // An empty list is not a direct answer: it can precede action candidates.
  contexts: (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((context) => context === SIMPLE_CONTEXT_ID),
  intents: isEmptyList,
  contextRequests: isEmptyList,
  candidateActionNames: isEmptyList,
  // Source selection for a direct answer; it never routes to actions.
  completionContext: () => true,
  requiresTool: (value) => value !== true,
  replyEffectStatus: (value) => value === "none" || value === "non_applied",
};

/** Fields every streamable attempt must have decided: without them there is no routing decision. */
const ALWAYS_REQUIRED_FIELDS = ["shouldRespond", "contexts"] as const;

/**
 * Routing fields that must have been decided before a direct answer can
 * stream, when the attempt's schema emits them. Stage 1 leaves some out of
 * its model-facing schema (for example `candidateActionNames`, which the
 * planner discovers); a field the model never writes can never be waited for.
 */
const REQUIRED_WHEN_EMITTED_FIELDS = [
  "intents",
  "candidateActionNames",
  "replyEffectStatus",
] as const;

/**
 * Creates the gate for one Stage-1 call. It allows the reply to stream only
 * when the fields generated before it route the turn to a direct answer:
 * RESPOND, simple context, no intents, no context reads, no action candidates
 * and no pending or applied effect. `emittedFieldNames` returns the fields the
 * call's schema actually asks the model for, read when the gate runs so a
 * recomposed schema (retry, context read) is honoured. Unstructured prose is
 * held: it has no routing decision to check.
 */
export function createStage1DirectReplyStreamGate(
  emittedFieldNames: () => readonly string[],
): StructuredStreamGate {
  return (preceding) => {
    if (!preceding) return false;
    const emitted = new Set(emittedFieldNames());
    for (const field of ALWAYS_REQUIRED_FIELDS) {
      if (!Object.hasOwn(preceding, field)) return false;
    }
    for (const field of REQUIRED_WHEN_EMITTED_FIELDS) {
      if (emitted.has(field) && !Object.hasOwn(preceding, field)) return false;
    }
    for (const [field, value] of Object.entries(preceding)) {
      const allows = DIRECT_REPLY_PRECEDING_FIELDS[field];
      if (!allows?.(value)) return false;
    }
    return true;
  };
}
