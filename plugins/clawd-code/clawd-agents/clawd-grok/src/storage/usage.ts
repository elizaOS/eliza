import { getModelInfo } from "../grok/models";
import type { UsageEvent, UsageSource } from "../types/index";
import { getDatabase } from "./db";

interface UsageRow {
  id: number;
  session_id: string;
  message_seq: number | null;
  source: UsageSource;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_micros: number;
  created_at: string;
}

export interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export function recordUsageEvent(
  sessionId: string,
  source: UsageSource,
  model: string,
  usage?: TokenUsageLike,
  messageSeq?: number | null,
): void {
  if (!usage) return;

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return;

  const costMicros = estimateCostMicros(model, inputTokens, outputTokens);
  getDatabase()
    .prepare(`
    INSERT INTO usage_events (
      session_id, message_seq, source, model, input_tokens, output_tokens, total_tokens, cost_micros, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      sessionId,
      messageSeq ?? null,
      source,
      model,
      inputTokens,
      outputTokens,
      totalTokens,
      costMicros,
      new Date().toISOString(),
    );
}

export function getSessionTotalTokens(sessionId: string): number {
  const row = getDatabase()
    .prepare(`
    SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM usage_events
    WHERE session_id = ?
  `)
    .get(sessionId) as { total_tokens: number } | undefined;

  return row?.total_tokens ?? 0;
}

export function listSessionUsage(sessionId: string): UsageEvent[] {
  const rows = getDatabase()
    .prepare(`
    SELECT id, session_id, message_seq, source, model, input_tokens, output_tokens, total_tokens, cost_micros, created_at
    FROM usage_events
    WHERE session_id = ?
    ORDER BY id ASC
  `)
    .all(sessionId) as UsageRow[];

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    messageSeq: row.message_seq,
    source: row.source,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    costMicros: row.cost_micros,
    createdAt: new Date(row.created_at),
  }));
}

function estimateCostMicros(model: string, inputTokens: number, outputTokens: number): number {
  const info = getModelInfo(model);
  if (!info) return 0;
  return Math.round(inputTokens * info.inputPrice + outputTokens * info.outputPrice);
}
