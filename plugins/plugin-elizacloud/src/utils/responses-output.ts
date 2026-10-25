type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function normalizeContentItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [{ type: "text", text: value }];
  return value && typeof value === "object" ? [value] : [];
}

function extractTextFromContentItem(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  const record = asRecord(value);
  if (!record) return [];

  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.output_text === "string"
        ? record.output_text
        : typeof record.content === "string"
          ? record.content
          : "";
  const type = typeof record.type === "string" ? record.type : undefined;

  if (text && (!type || type === "output_text" || type === "text")) {
    return [text];
  }

  return [];
}

function extractTextFromOutputItem(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];

  const directContent = normalizeContentItems(record.content);
  if (directContent.length > 0) {
    return directContent.flatMap(extractTextFromContentItem);
  }

  const nestedMessage = asRecord(record.message);
  if (nestedMessage) {
    return normalizeContentItems(nestedMessage.content).flatMap(extractTextFromContentItem);
  }

  const type = typeof record.type === "string" ? record.type : undefined;
  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.output_text === "string"
        ? record.output_text
        : "";
  if (text && (type === "output_text" || type === "text")) {
    return [text];
  }

  return [];
}

function extractTextFromChoice(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];

  if (typeof record.text === "string" && record.text) {
    return [record.text];
  }

  const message = asRecord(record.message);
  if (!message) {
    return [];
  }

  return normalizeContentItems(message.content).flatMap(extractTextFromContentItem);
}

/**
 * Recover text from Responses-style payloads, tolerating both the documented
 * `output_text` field and the common structured `output` item variants.
 *
 * Cloud responses sometimes carry the same body in BOTH `output_text` AND
 * `output[]`/`choices[]`. Joining segments in that case duplicates the model
 * output downstream (caller sees `…json{…}\n``````json{…}…`), which then
 * trips JSON.parse with "Unrecognized token '`'" because of the run of
 * backticks where the two copies meet. Prefer the first non-empty source
 * instead of joining.
 */
export function extractResponsesOutputText(data: unknown): string {
  const record = asRecord(data);
  if (!record) return "";

  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text;
  }

  if (Array.isArray(record.output)) {
    const fromOutput = record.output.flatMap(extractTextFromOutputItem).join("");
    if (fromOutput.trim()) return fromOutput;
  }

  if (Array.isArray(record.choices)) {
    const fromChoices = record.choices.flatMap(extractTextFromChoice).join("");
    if (fromChoices.trim()) return fromChoices;
  }

  return "";
}
