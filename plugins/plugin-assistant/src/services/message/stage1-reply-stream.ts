/**
 * Which Stage-1 reply text may stream to the user while it is generated.
 *
 * Stage 1 answers simple turns in `replyText` and writes only an
 * acknowledgement there for planned work. The acknowledgement is replaced by
 * the planner's reply, so it must not stream as the answer. The routing
 * fields precede `replyText` in the HANDLE_RESPONSE envelope, so the runtime
 * can ask this gate, before the first reply byte, whether the attempt is
 * already settled as a direct answer. Anything else holds the attempt and the
 * validated final reply is delivered whole, as before.
 *
 * Later validation (source quotes, the transcript guard, egress review,
 * routing heuristics that read fields after `replyText`) can still change the
 * text. That change reaches clients as a stream revision / authoritative
 * snapshot, never as silent divergence: the final reply stays authoritative.
 */
import type { StructuredStreamField, StructuredStreamGate } from "@elizaos/core";
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
  contexts: (value) =>
    Array.isArray(value) &&
    value.every((context) => context === SIMPLE_CONTEXT_ID),
  intents: isEmptyList,
  contextRequests: isEmptyList,
  candidateActionNames: isEmptyList,
  // Source selection for a direct answer; it never routes to actions.
  completionContext: () => true,
  requiresTool: (value) => value !== true,
  replyEffectStatus: (value) => value === "none" || value === "non_applied",
};

/** Fields that must have been decided before a direct answer can stream. */
const REQUIRED_PRECEDING_FIELDS = ["shouldRespond", "contexts", "intents"];

/**
 * Allows a Stage-1 attempt's reply to stream only when the fields generated
 * before it route the turn to a direct answer: RESPOND, simple context, no
 * intents, no context reads and no action candidates. Unstructured prose is
 * held: it has no routing decision to check.
 */
export const stage1DirectReplyStreamGate: StructuredStreamGate = (
  preceding,
) => {
  if (!preceding) return false;
  for (const field of REQUIRED_PRECEDING_FIELDS) {
    if (!Object.hasOwn(preceding, field)) return false;
  }
  for (const [field, value] of Object.entries(preceding)) {
    const allows = DIRECT_REPLY_PRECEDING_FIELDS[field];
    if (!allows?.(value)) return false;
  }
  return true;
};
