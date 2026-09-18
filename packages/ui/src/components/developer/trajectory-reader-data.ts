/** Lossless recorded-payload projections for the separate developer reader. */
import type { TrajectoryLlmCall } from "../../api/client-types-cloud";

export interface TrajectoryReaderTextPart {
  label: string;
  /** Offsets into the original JavaScript string, without newline conversion. */
  start: number;
  end: number;
  text: string;
}

export interface TrajectoryReaderSection {
  id: string;
  label: string;
  sourcePath: string;
  status: "recorded" | "empty" | "unavailable";
  format: "text" | "json";
  text: string;
  /** UTF-16 code units of displayed text, never a token or byte estimate. */
  characterCount: number | null;
  role?: string;
  /** Original value, including message envelope and every nontext content part. */
  rawValue: unknown;
  parts: TrajectoryReaderTextPart[];
  representationNote?: string;
}

export interface TrajectoryReaderData {
  stageLabel: string;
  input: TrajectoryReaderSection[];
  output: TrajectoryReaderSection[];
}

/** Concatenating every part's text reproduces the input exactly. */
export function splitTrajectoryReaderText(
  text: string,
): TrajectoryReaderTextPart[] {
  const headings: { start: number; label: string }[] = [];
  let fence: { character: string; length: number } | undefined;
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!line[0]) continue;
    const body = line[0].replace(/[\r\n]+$/, "");
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
    if (fence) {
      if (
        delimiter &&
        delimiter[1][0] === fence.character &&
        delimiter[1].length >= fence.length &&
        !delimiter[2].trim()
      ) {
        fence = undefined;
      }
      continue;
    }
    if (delimiter) {
      fence = {
        character: delimiter[1][0],
        length: delimiter[1].length,
      };
      continue;
    }
    const heading = /^ {0,3}#{1,6}(?:[\t ]+(.*)|[\t ]*)$/.exec(body);
    // Prompt labels are navigation boundaries only; their original text stays
    // in the slice, including punctuation, whitespace and line endings.
    const promptLabel = /^[A-Za-z][A-Za-z0-9 _():.,-]*:$/.test(body);
    if (heading || promptLabel) {
      headings.push({
        start: line.index,
        label: heading
          ? heading[1]?.trim() || "Untitled section"
          : body.slice(0, -1).replaceAll("_", " "),
      });
    }
  }
  if (headings[0]?.start !== 0) {
    headings.unshift({ start: 0, label: "Text" });
  }
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? text.length;
    return { ...heading, end, text: text.slice(heading.start, end) };
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** API payloads are JSON; malformed in-memory fixtures remain explicitly visible. */
function recordedJson(value: unknown): {
  text: string;
  representationNote?: string;
} {
  const ancestors: object[] = [];
  let representedNonJson = false;
  const text = JSON.stringify(
    value,
    function (_key, nested: unknown) {
      if (
        nested === undefined ||
        typeof nested === "bigint" ||
        typeof nested === "function" ||
        typeof nested === "symbol" ||
        (typeof nested === "number" && !Number.isFinite(nested))
      ) {
        representedNonJson = true;
        return `[${typeof nested}: ${String(nested)}]`;
      }
      if (nested !== null && typeof nested === "object") {
        while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
        if (ancestors.includes(nested)) {
          representedNonJson = true;
          return "[Circular reference]";
        }
        ancestors.push(nested);
      }
      return nested;
    },
    2,
  );
  return {
    text,
    ...(representedNonJson
      ? {
          representationNote:
            "Non-JSON values are labeled in this display; rawValue retains the original payload.",
        }
      : {}),
  };
}

function section(
  sourcePath: string,
  label: string,
  value: unknown,
  options: { role?: string; text?: string; representationNote?: string } = {},
): TrajectoryReaderSection {
  if (value === undefined) {
    return {
      id: sourcePath,
      label,
      sourcePath,
      status: "unavailable",
      format: "text",
      text: "",
      characterCount: null,
      rawValue: value,
      parts: [],
      ...(options.role !== undefined ? { role: options.role } : {}),
    };
  }
  const textValue =
    options.text ?? (typeof value === "string" ? value : undefined);
  const display: ReturnType<typeof recordedJson> =
    textValue !== undefined ? { text: textValue } : recordedJson(value);
  const representationNote = [
    display.representationNote,
    options.representationNote,
  ]
    .filter(Boolean)
    .join(" ");
  const empty =
    display.text === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (record(value) !== undefined && display.text === "{}");
  return {
    id: sourcePath,
    label,
    sourcePath,
    status: empty ? "empty" : "recorded",
    format: textValue !== undefined ? "text" : "json",
    ...display,
    ...(representationNote ? { representationNote } : {}),
    characterCount: display.text.length,
    rawValue: value,
    parts: splitTrajectoryReaderText(display.text),
    ...(options.role !== undefined ? { role: options.role } : {}),
  };
}

/** Labels describe recorded call purpose, never whether a response was delivered. */
export function trajectoryCallStageLabel(call: TrajectoryLlmCall): string {
  const system = typeof call.systemPrompt === "string" ? call.systemPrompt : "";
  const metadata = [call.stepType, call.purpose, call.modelType, call.modelSlot]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  if (/^evaluator_stage:/m.test(system)) return "Completion check";
  if (metadata.includes("observation_extraction")) return "Memory extraction";
  if (metadata.some((value) => ["evaluation", "evaluator"].includes(value)))
    return "Evaluation";
  if (
    /^message_handler_stage:/m.test(system) ||
    metadata.includes("response_handler")
  )
    return "Response handler";
  if (/^planner_stage:/m.test(system) || metadata.includes("action_planner"))
    return "Action planner";
  if (
    metadata.includes("text_small") &&
    [call.userPrompt, call.prompt].some(
      (value) =>
        typeof value === "string" && value.startsWith("View catalog scope:"),
    )
  )
    return "View resolver";
  if (metadata.includes("text_embedding")) return "Embedding";
  if (metadata.includes("should_respond")) return "Response decision";
  return "Model call";
}

/**
 * Show recorded alternatives explicitly instead of selecting a lossy fallback.
 * No aggregate character/token total is produced: flattened prompts can repeat
 * messages, and recorded JSON schemas need not match the provider's wire form.
 */
export function buildTrajectoryReaderData(
  call: TrajectoryLlmCall,
): TrajectoryReaderData {
  const input = [section("systemPrompt", "System prompt", call.systemPrompt)];
  if (Array.isArray(call.messages) && call.messages.length > 0) {
    for (const [index, message] of call.messages.entries()) {
      const envelope = record(message);
      const role =
        typeof envelope?.role === "string" ? envelope.role : undefined;
      const plainTextEnvelope =
        typeof envelope?.content === "string" &&
        (!Object.hasOwn(envelope, "role") || role !== undefined) &&
        Object.keys(envelope).every(
          (key) => key === "role" || key === "content",
        );
      input.push(
        section(
          `messages[${index}]`,
          `Message ${index + 1}${role ? ` · ${role}` : " · role not recorded"}`,
          message,
          {
            role,
            ...(plainTextEnvelope ? { text: envelope.content as string } : {}),
          },
        ),
      );
    }
  } else {
    input.push(section("messages", "Recorded messages", call.messages));
  }
  for (const [field, label] of [
    ["userPrompt", "Recorded user prompt (flattened alternative)"],
    ["prompt", "Recorded prompt (flattened alternative)"],
  ] as const) {
    if (Object.hasOwn(call, field))
      input.push(
        section(field, label, call[field], {
          representationNote:
            "Rendered alternative; may repeat system/messages. Not an additional input.",
        }),
      );
  }
  const schemaNote =
    "Character counts describe this formatted JSON display, not provider token allocation or wire bytes.";
  input.push(
    section("tools", "Tool definitions", call.tools, {
      representationNote: schemaNote,
    }),
  );
  for (const [field, label] of [
    ["toolChoice", "Tool choice"],
    ["responseSchema", "Response schema"],
    ["providerOptions", "Provider options"],
  ] as const) {
    if (Object.hasOwn(call, field))
      input.push(
        section(field, label, call[field], {
          ...(field === "responseSchema"
            ? { representationNote: schemaNote }
            : field === "providerOptions"
              ? {
                  representationNote:
                    "Recorded request options can include local accounting metadata; their presence does not mean every value was sent to the provider.",
                }
              : {}),
        }),
      );
  }
  const output = [section("response", "Response", call.response)];
  for (const [field, label] of [
    ["output", "Recorded output"],
    ["reasoning", "Recorded reasoning"],
  ] as const) {
    if (Object.hasOwn(call, field))
      output.push(section(field, label, call[field]));
  }
  output.push(section("toolCalls", "Tool calls", call.toolCalls));
  return { stageLabel: trajectoryCallStageLabel(call), input, output };
}
