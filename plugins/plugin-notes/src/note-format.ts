import type { NoteFormat, NoteJson } from "./types.js";

const requireRecord = (v: unknown, field: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw formatError("Must be a JSON object.", field);
  return v as Record<string, unknown>;
};
const assertOnlyKeys = (
  v: Record<string, unknown>,
  keys: readonly string[],
  field: string,
) => {
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw formatError("Unsupported field.", field);
};
export class NoteFormatError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "NoteFormatError";
  }
}
const formatError = (message: string, field: string) =>
  new NoteFormatError(message, field);
/** Bounded JSON, no lossy coercion, non-finite numbers, prototypes or omitted fields. */
export function parseNoteFormat(value: unknown): NoteFormat {
  const record = requireRecord(value, "format");
  assertOnlyKeys(record, ["kind", "data"], "format");
  if (!["text", "list", "voice", "link"].includes(record.kind as string))
    throw formatError("Unknown note format.", "format.kind");
  let nodes = 0;
  const copy = (v: unknown, depth = 0): NoteJson => {
    if (++nodes > 10000 || depth > 24)
      throw formatError("Note metadata exceeds bounds.", "format.data");
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map((x) => copy(x, depth + 1));
    if (
      v &&
      typeof v === "object" &&
      (Object.getPrototypeOf(v) === Object.prototype ||
        Object.getPrototypeOf(v) === null)
    ) {
      const out: Record<string, NoteJson> = {};
      for (const [k, x] of Object.entries(v)) {
        if (["__proto__", "constructor", "prototype"].includes(k))
          throw formatError("Unsafe note metadata key.", "format.data");
        out[k] = copy(x, depth + 1);
      }
      return out;
    }
    throw formatError("Note metadata must be JSON.", "format.data");
  };
  const data = copy(requireRecord(record.data, "format.data"));
  if (JSON.stringify(data).length > 262144)
    throw formatError("Note metadata exceeds size bound.", "format.data");
  return {
    kind: record.kind as NoteFormat["kind"],
    data: data as NoteFormat["data"],
  };
}
