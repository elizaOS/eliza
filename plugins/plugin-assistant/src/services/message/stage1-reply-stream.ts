/**
 * Which Stage-1 reply text may stream to the user while it is generated.
 *
 * Stage 1 answers simple turns in `replyText` and writes only an
 * acknowledgement there for planned work. The acknowledgement is replaced by
 * the planner's reply, so it must not stream as the answer. Every routing
 * field (field priority below `replyText`'s 20, builtin-field-evaluators.ts)
 * precedes `replyText` in the HANDLE_RESPONSE envelope, so the runtime can ask
 * this gate, before the first reply byte, whether the attempt is already
 * settled as a direct answer. A plugin routing field takes part when it
 * declares `directReplyValue` and is generated before `replyText`. Anything
 * else holds the attempt and the validated final reply is delivered whole,
 * as before.
 *
 * The streamed text is still a draft: later validation (source quotes, the
 * transcript guard, egress review, message-text routing heuristics, the
 * addressee gate) can change or withdraw it. Hosts deliver it as provisional
 * text and the validated final reply confirms, revises or retracts it.
 */
import type {
  ResponseHandlerFieldEvaluator,
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
 * Builtin envelope fields that may precede `replyText` on a direct answer,
 * each with the value that keeps the turn off the planner. Plugin fields
 * declare theirs with `directReplyValue`; any other preceding field is
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
 * its model-facing schema (it never asks for `candidateActionNames`, which the
 * planner discovers); a field the model never writes can never be waited for.
 * `candidateActionNames` stays listed for callers whose schema does emit it.
 */
const REQUIRED_WHEN_EMITTED_FIELDS = [
  "contextRequests",
  "intents",
  "candidateActionNames",
  "replyEffectStatus",
] as const;

/**
 * Fields written after `replyText` that never change the turn's routing or
 * the reply text. Any other emitted field (for example a plugin field that
 * moves the turn to the planner or replaces the reply after it was written)
 * holds the stream for that call unless it declares `directReplyValue` and
 * was written before `replyText` with such a value.
 */
const PASSIVE_FOLLOWING_FIELDS = [
  "replyText",
  "facts",
  "relationships",
  "topics",
  "addressedTo",
  "emotion",
] as const;

const BUILTIN_STREAM_SAFE_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys(DIRECT_REPLY_PRECEDING_FIELDS),
  ...PASSIVE_FOLLOWING_FIELDS,
]);

/**
 * Creates the gate for one Stage-1 call. It allows the reply to stream only
 * when the fields generated before it route the turn to a direct answer:
 * RESPOND, simple context, no intents, no context reads, no action candidates
 * and no pending or applied effect, and every plugin field in the call's
 * schema was already written with a value it declares keeps a direct answer.
 * `emittedFields` returns the field evaluators the call's schema actually
 * asks the model for, read when the gate runs so a recomposed schema (retry,
 * context read) is honoured. A plugin field written after `replyText` is not
 * in `preceding`, so it holds the stream whatever it declares. Unstructured
 * prose is held: it has no routing decision to check.
 */
export function createStage1DirectReplyStreamGate(
  emittedFields: () => readonly Pick<
    ResponseHandlerFieldEvaluator,
    "name" | "directReplyValue"
  >[],
): StructuredStreamGate {
  return (preceding) => {
    if (!preceding) return false;
    const fields = emittedFields();
    const pluginDirectValues = new Map<string, (value: unknown) => boolean>();
    for (const { name, directReplyValue } of fields) {
      if (BUILTIN_STREAM_SAFE_FIELDS.has(name)) continue;
      if (!directReplyValue || !Object.hasOwn(preceding, name)) return false;
      pluginDirectValues.set(name, directReplyValue);
    }
    for (const field of ALWAYS_REQUIRED_FIELDS) {
      if (!Object.hasOwn(preceding, field)) return false;
    }
    for (const field of REQUIRED_WHEN_EMITTED_FIELDS) {
      if (
        fields.some(({ name }) => name === field) &&
        !Object.hasOwn(preceding, field)
      )
        return false;
    }
    for (const [field, value] of Object.entries(preceding)) {
      const allows =
        DIRECT_REPLY_PRECEDING_FIELDS[field] ?? pluginDirectValues.get(field);
      if (!allows?.(value)) return false;
    }
    return true;
  };
}
