import {
  type GenerateTextParams,
  type IAgentRuntime,
  type JsonValue,
  ModelType,
  type ObjectGenerationParams,
  type Plugin,
  type TextEmbeddingParams,
} from "@elizaos/core";

function extractPrompt(
  input: GenerateTextParams | string | null | undefined,
): string {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input === "object" && typeof input.prompt === "string") {
    return input.prompt;
  }
  return "";
}

function extractCommand(prompt: string): string {
  const match = prompt.match(/CLICK\([^)]*\)/i);
  if (match?.[0]) {
    return match[0].toUpperCase();
  }
  return "CLICK(10,10)";
}

function extractValidationFields(prompt: string): Record<string, string> {
  const tags: Record<string, string> = {};

  // Per-field validation tags (context check levels 0/1)
  const matches = prompt.matchAll(
    /<(code_[A-Za-z0-9_-]+_(?:start|end)|one_(?:initial|middle|end)_code|two_(?:initial|middle|end)_code)>([\s\S]*?)<\/\1>/g,
  );
  for (const [, key, value] of matches) {
    tags[key] = value.trim();
  }

  // Checkpoint validation codes are also rendered in plain text lines:
  // "initial code: ...", "middle code: ...", "end code: ..."
  // and optionally "second initial code: ..." for the second checkpoint set.
  const checkpointMatches = prompt.matchAll(
    /(second\s+)?(initial|middle|end)\s+code:\s*([a-f0-9-]{16,})/gi,
  );
  for (const [, second, stage, value] of checkpointMatches) {
    const prefix = second ? "two" : "one";
    tags[`${prefix}_${stage.toLowerCase()}_code`] = value.trim();
  }

  return tags;
}

function buildXmlResponse(
  prompt: string,
  fields: Record<string, string | undefined>,
): string {
  const withValidation = { ...fields, ...extractValidationFields(prompt) };
  const entries = Object.entries(withValidation).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0,
  );
  const body = entries
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join("\n");
  return `<response>\n${body}\n</response>`;
}

function buildCompletion(prompt: string): string {
  const command = extractCommand(prompt);

  // shouldRespondTemplate
  if (prompt.includes("Decide on behalf of") && prompt.includes("RESPOND")) {
    return buildXmlResponse(prompt, {
      name: "BenchmarkAgent",
      reasoning: "Benchmark requests should always be processed.",
      action: "RESPOND",
    });
  }

  // multiStepDecisionTemplate
  if (
    prompt.includes("Determine the next step") &&
    prompt.includes("<isFinish>")
  ) {
    return buildXmlResponse(prompt, {
      thought: "The benchmark task can be completed in this step.",
      action: "",
      providers: "",
      isFinish: "true",
    });
  }

  // multiStepSummaryTemplate
  if (prompt.includes("Summarize what the assistant has done so far")) {
    return buildXmlResponse(prompt, {
      thought: "Summarizing completed benchmark execution.",
      text: `Executed ${command}`,
    });
  }

  // Default message handler path (single-shot core)
  const validationTags = extractValidationFields(prompt);
  const validationXml = Object.entries(validationTags)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join("\n");

  return `<response>
<thought>Execute deterministic benchmark action using ${command}.</thought>
<actions>BENCHMARK_ACTION</actions>
<providers></providers>
<text>Executed ${command}</text>
<params>
<BENCHMARK_ACTION>
<command>${command}</command>
</BENCHMARK_ACTION>
</params>
${validationXml}
</response>`;
}

function mockTextModel(
  _runtime: IAgentRuntime,
  params: GenerateTextParams | string | null,
): string {
  return buildCompletion(extractPrompt(params));
}

function mockEmbeddingModel(
  _runtime: IAgentRuntime,
  _params: TextEmbeddingParams | string | null,
): number[] {
  const vector = new Array(384).fill(0);
  vector[0] = 1;
  return vector;
}

function mockObjectModel(
  _runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Record<string, JsonValue> {
  const prompt = extractPrompt(params.prompt ?? "");
  const command = extractCommand(prompt);
  const schemaProps =
    params.schema && typeof params.schema.properties === "object"
      ? params.schema.properties
      : undefined;

  const fallback: Record<string, JsonValue> = {
    thought: "Execute deterministic benchmark action",
    actions: ["BENCHMARK_ACTION"],
    name: "BENCHMARK_ACTION",
    reasoning: "Execute deterministic benchmark action",
    action: "BENCHMARK_ACTION",
    params: {
      BENCHMARK_ACTION: {
        command,
      },
    },
    text: `Executed ${command}`,
    isFinish: true,
  };

  if (!schemaProps) {
    return fallback;
  }

  const output: Record<string, JsonValue> = {};
  for (const [key, schema] of Object.entries(schemaProps)) {
    const fieldType =
      schema && typeof schema === "object" && "type" in schema
        ? schema.type
        : undefined;
    const normalizedType =
      typeof fieldType === "string"
        ? fieldType
        : Array.isArray(fieldType) && typeof fieldType[0] === "string"
          ? fieldType[0]
          : undefined;

    if (
      key === "action" ||
      key === "name" ||
      key === "actions" ||
      key.toLowerCase().includes("action")
    ) {
      output[key] =
        normalizedType === "array" ? ["BENCHMARK_ACTION"] : "BENCHMARK_ACTION";
      continue;
    }
    if (
      key === "reasoning" ||
      key === "thought" ||
      key.toLowerCase().includes("reason")
    ) {
      output[key] = "Execute deterministic benchmark action";
      continue;
    }
    if (key === "params" || key.toLowerCase().includes("param")) {
      output[key] = { BENCHMARK_ACTION: { command } };
      continue;
    }
    if (key === "text" || key.toLowerCase().includes("message")) {
      output[key] = `Executed ${command}`;
      continue;
    }

    if (normalizedType === "boolean") {
      output[key] = false;
    } else if (normalizedType === "number" || normalizedType === "integer") {
      output[key] = 1;
    } else if (normalizedType === "array") {
      output[key] = [];
    } else if (normalizedType === "object") {
      output[key] = {};
    } else {
      output[key] = "ok";
    }
  }

  return { ...fallback, ...output };
}

export const mockPlugin: Plugin = {
  name: "mock-plugin",
  description: "Deterministic benchmark plugin for offline benchmark runs",
  priority: 1000,
  models: {
    [ModelType.TEXT_SMALL]: async (runtime, params) =>
      mockTextModel(runtime, params),
    [ModelType.TEXT_LARGE]: async (runtime, params) =>
      mockTextModel(runtime, params),
    [ModelType.TEXT_COMPLETION]: async (runtime, params) =>
      mockTextModel(runtime, params),
    [ModelType.OBJECT_SMALL]: async (runtime, params) =>
      mockObjectModel(runtime, params),
    [ModelType.OBJECT_LARGE]: async (runtime, params) =>
      mockObjectModel(runtime, params),
    [ModelType.TEXT_EMBEDDING]: async (runtime, params) =>
      mockEmbeddingModel(runtime, params),
  },
};
