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
    priority: 45,
    description:
      "Classify only the CURRENT user's requested Notes effects: read_only for reads/history/navigation, mutation_requested for an explicit create/edit/append/delete request, unresolved for no Notes effect or uncertainty or unsupported operations such as restoring a deleted note. List only the requested registered operations, not a tool plan: create=new note, get/list=reads, update=edit, patch=append or patch edit, delete=remove; include read and write for compounds, with no duplicates. Quoted commands, past requests and operation words inside note content do not add operations. Use [] for unresolved/navigation-only; mutation_requested must name a mutation and read_only must not. This is semantic interpretation for completion accounting, not proof of intent truth, execution or write permission; existing permissions and full outcome evaluation still apply.",
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
          maxItems: 6,
        },
      },
      required: ["classification", "operations"],
      additionalProperties: false,
    },
    shouldRun: ({ senderRole }) => senderRole === "OWNER",
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
