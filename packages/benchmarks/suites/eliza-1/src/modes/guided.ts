import type {
  ModeRequest,
  ModeResult,
  SkeletonFreeField,
  SkeletonHint,
} from "../types.ts";

interface BenchSkeletonSpan {
  kind: "literal" | "enum" | "free-string" | "free-json";
  key?: string;
  value?: string;
  enumValues?: string[];
}

interface BenchSkeleton {
  id?: string;
  spans: BenchSkeletonSpan[];
}

export function skeletonFromHint(hint: SkeletonHint): BenchSkeleton {
  const spans: BenchSkeletonSpan[] = [];
  const fields = hint.freeFields;
  if (fields.length === 0 && hint.enumKey && hint.enumValues) {
    spans.push({ kind: "literal", value: `{${JSON.stringify(hint.enumKey)}:` });
    spans.push({
      kind: "enum",
      key: hint.enumKey,
      enumValues: hint.enumValues,
    });
    spans.push({ kind: "literal", value: "}" });
    return { spans };
  }
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const prefix =
      i === 0
        ? `{${JSON.stringify(field.key)}:`
        : `,${JSON.stringify(field.key)}:`;
    spans.push({ kind: "literal", value: prefix });
    spans.push(spanForField(field));
  }
  spans.push({ kind: "literal", value: fields.length === 0 ? "{}" : "}" });
  return { spans };
}

function spanForField(field: SkeletonFreeField): BenchSkeletonSpan {
  switch (field.kind) {
    case "enum":
      return {
        kind: "enum",
        key: field.key,
        enumValues: field.enumValues ?? [],
      };
    case "string":
      return { kind: "free-string", key: field.key };
    case "boolean":
    case "number":
    case "object":
      return { kind: "free-json", key: field.key };
  }
}

export function renderPrompt(req: ModeRequest): string {
  return [
    req.systemPrompt,
    "",
    "Respond with a single JSON object only.",
    "",
    "USER MESSAGE:",
    req.userPrompt,
    "",
    "JSON:",
  ].join("\n");
}

export function emptyResult(message: string): ModeResult {
  return {
    rawOutput: "",
    firstTokenLatencyMs: null,
    totalLatencyMs: 0,
    tokensGenerated: null,
    error: message,
  };
}
