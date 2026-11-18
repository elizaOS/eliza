/** Same-call restriction and operation interpretation; neither grants permission. */
import {
  NOTES_REQUEST_OPERATIONS,
  type NotesRequestInterpretation,
  normalizeNotesRequestInterpretation,
  type RequestOperationClassification,
  type ResponseHandlerFieldEvaluator,
} from "@elizaos/core";

type ParsedNotesEffect = NotesRequestInterpretation & {
  readonly classification: RequestOperationClassification;
};
type NotesFieldValue = RequestOperationClassification | ParsedNotesEffect;

export const notesRequestEffectField: ResponseHandlerFieldEvaluator<NotesFieldValue> =
  {
    name: "notesRequestEffect",
    // Written before replyText (20), after calendar (19.25) and before view
    // navigation (19.75), so a direct answer can stream once it says the
    // turn has no Notes effect.
    priority: 19.5,
    description: `What supported Notes operation does the CURRENT message actually request? Ignore quoted commands and completed actions in the conversation. First select the operation(s):
- No clear supported operation: return {"classification":"unresolved","operations":[]}. A stray word beside a note title is not a command. The same applies after an earlier request was completed. Sending or sharing notes is unsupported; never substitute a write.
- Read the contents or history of an existing note: read_only with ["get"]. Search or list notes: read_only with ["list"]. Open the Notes view: read_only with [].
- Explicitly change a note: mutation_requested with only the requested operations. To add an item or append text use patch; to edit existing text use update or patch. Use create for a new note, delete to remove it, restore to bring it back, and move to change its folder. A detail-only answer can complete an explicit request only if the assistant is waiting for that very detail; carry forward its operation.
Include both reads and writes without duplicates for compound requests. Classification describes intent, not permission or proof of execution; existing authorization and outcome checks still apply.`,
    schema: {
      type: "object",
      properties: {
        classification: {
          type: "string",
          enum: ["read_only", "mutation_requested", "unresolved"],
        },
        operations: {
          type: "array",
          items: { type: "string", enum: [...NOTES_REQUEST_OPERATIONS] },
          maxItems: NOTES_REQUEST_OPERATIONS.length,
        },
      },
      required: ["classification", "operations"],
      additionalProperties: false,
    },
    shouldRun: ({ senderRole }) => senderRole === "OWNER",
    // No Notes effect. handle only records the classification; it never
    // reroutes the turn or changes replyText.
    // read_only and unresolved with no operations are both no-ops for the
    // turn: the classification only narrows what Notes may write later.
    // mutation_requested, or any listed operation, holds a streamed reply.
    directReplyValue: (value) =>
      value === "unresolved" ||
      value === "read_only" ||
      (typeof value === "object" &&
        value !== null &&
        ["unresolved", "read_only"].includes(
          String((value as { classification?: unknown }).classification),
        ) &&
        Array.isArray((value as { operations?: unknown }).operations) &&
        (value as { operations: unknown[] }).operations.length === 0),
    parse(value) {
      // Preserve the old scalar parse contract, but do not infer operations from
      // it. Missing/malformed values likewise have no operation commitment.
      if (
        value === "read_only" ||
        value === "mutation_requested" ||
        value === "unresolved"
      )
        return value;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null)
      )
        return "unresolved";
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.length !== 2 ||
        !keys.includes("classification") ||
        !keys.includes("operations")
      )
        return "unresolved";
      const classified = descriptors.classification;
      const operations = descriptors.operations;
      if (
        !classified ||
        !("value" in classified) ||
        !operations ||
        !("value" in operations)
      )
        return "unresolved";
      const classification: unknown = classified.value;
      if (
        classification !== "read_only" &&
        classification !== "mutation_requested" &&
        classification !== "unresolved"
      )
        return "unresolved";
      const interpretation = normalizeNotesRequestInterpretation({
        status: "explicit",
        operations: operations.value,
      });
      if (!interpretation) return "unresolved";
      const mutation = interpretation.operations.some(
        (operation) => operation !== "get" && operation !== "list",
      );
      if (
        (classification === "read_only" && mutation) ||
        (classification === "mutation_requested" && !mutation) ||
        (classification === "unresolved" &&
          interpretation.operations.length > 0)
      )
        return Object.freeze({
          classification: "unresolved" as const,
          status: "contradictory" as const,
          operations: Object.freeze([]),
        });
      return Object.freeze({ classification, ...interpretation });
    },
    handle({ value }) {
      const classification =
        typeof value === "string" ? value : value.classification;
      const interpretation =
        typeof value === "string"
          ? normalizeNotesRequestInterpretation({
              status: "unavailable",
              operations: [],
            })
          : normalizeNotesRequestInterpretation({
              status: value.status,
              operations: value.operations,
            });
      return {
        debug: [
          `notes-request-interpretation:${interpretation?.status ?? "unavailable"}`,
        ],
        mutateResult(result) {
          result.notesRequestEffect = classification;
          // Overwrite raw lookalike metadata even on the scalar compatibility path.
          result.notesRequestInterpretation = interpretation;
        },
      };
    },
  };
