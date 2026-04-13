import type { Memory } from "@elizaos/core";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  source: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function extractEvalRunMetadata(
  value: Memory | Record<string, unknown> | null | undefined,
): {
  scenarioId?: string;
  batchId?: string;
} {
  const record =
    value && "content" in value
      ? asRecord((value as Memory).content)
      : asRecord(value);
  const contentMetadata = asRecord(record?.metadata);
  const nestedSources = [
    asRecord(contentMetadata?.eval),
    asRecord(contentMetadata?.evaluation),
    asRecord(contentMetadata?.scenario),
  ];

  const scenarioId =
    readString(record, "scenarioId", "scenario_id") ??
    readString(contentMetadata, "scenarioId", "scenario_id") ??
    nestedSources
      .map((source) => readString(source, "scenarioId", "scenario_id"))
      .find(Boolean);
  const batchId =
    readString(record, "batchId", "batch_id") ??
    readString(contentMetadata, "batchId", "batch_id") ??
    nestedSources
      .map((source) => readString(source, "batchId", "batch_id"))
      .find(Boolean);

  return { scenarioId, batchId };
}

export function mergeTaskThreadEvalMetadata(
  message: Memory | null | undefined,
  metadata: Record<string, unknown> | undefined,
): {
  scenarioId?: string;
  batchId?: string;
  metadata: Record<string, unknown>;
} {
  const merged = {
    ...(metadata ?? {}),
  };
  const { scenarioId, batchId } = extractEvalRunMetadata(message);

  if (scenarioId) {
    merged.scenarioId = scenarioId;
  }
  if (batchId) {
    merged.batchId = batchId;
  }

  return {
    scenarioId,
    batchId,
    metadata: merged,
  };
}
