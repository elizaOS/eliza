/**
 * DSPy-style Example primitive + loader for the eliza_native_v1 JSONL shape.
 *
 * The loader walks each row, extracts `(system, user) → expected output`
 * (mirroring the legacy `optimizations.OptimizationExample` flow), and runs
 * the rows through the mandatory privacy filter from `core/privacy-filter.ts`.
 * No file path is allowed to skip the filter — that's a CLAUDE.md hard rule.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  applyPrivacyFilter,
  type FilterableTrajectory,
  type PrivacyFilterOptions,
} from "../core/privacy-filter.js";

export interface Example {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  reward?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

interface JsonlMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
}

interface JsonlRow {
  format: "eliza_native_v1";
  boundary?: string;
  request?: {
    system?: string;
    prompt?: string;
    messages?: JsonlMessage[];
  };
  response?: {
    text?: string;
    toolCalls?: unknown[];
  };
  metadata?: Record<string, unknown>;
}

export interface LoadExamplesOptions {
  /**
   * Input-field name used when collapsing the (system, user) pair into a
   * single string for downstream signatures. Defaults to `"input"`.
   */
  inputField?: string;
  /**
   * Output-field name expected by the consuming Signature. Defaults to
   * `"output"`.
   */
  outputField?: string;
  /**
   * Optional privacy-filter options forwarded to `applyPrivacyFilter`.
   * Even when this is `undefined`, the filter still runs with defaults —
   * see `runPrivacyFilter()` below.
   */
  privacy?: PrivacyFilterOptions;
}

/**
 * Load `eliza_native_v1` JSONL into Example[]. Privacy filter is mandatory.
 *
 * Returns the filtered examples plus the redaction/anonymization counts so
 * callers can log them (or fail loud if a strict-mode flag is added later).
 */
export interface LoadExamplesResult {
  examples: Example[];
  redactionCount: number;
  anonymizationCount: number;
  droppedTrajectories: number;
}

export function loadExamplesFromElizaV1(
  path: string,
  options: LoadExamplesOptions = {},
): LoadExamplesResult {
  if (!existsSync(path)) {
    throw new Error(`[dspy/examples] dataset not found at ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const rows: JsonlRow[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const parsed: unknown = JSON.parse(line);
    if (!isJsonlRow(parsed)) {
      throw new Error(
        `[dspy/examples] dataset line ${i + 1} is not an eliza_native_v1 row`,
      );
    }
    rows.push(parsed);
  }
  return rowsToExamples(rows, options);
}

/**
 * In-memory variant — for tests and callers that already have the parsed
 * rows in hand. Goes through the same privacy filter as the file loader.
 */
export function buildExamplesFromRows(
  rows: JsonlRow[],
  options: LoadExamplesOptions = {},
): LoadExamplesResult {
  return rowsToExamples(rows, options);
}

function rowsToExamples(
  rows: JsonlRow[],
  options: LoadExamplesOptions,
): LoadExamplesResult {
  const inputField = options.inputField ?? "input";
  const outputField = options.outputField ?? "output";

  // Run privacy filter BEFORE turning rows into Examples — the filter walks
  // the `steps[].llmCalls[]` shape, which is what we adapt the rows into.
  const trajectories: FilterableTrajectory[] = rows.map((row, idx) => ({
    trajectoryId: `row-${idx}`,
    steps: [
      {
        llmCalls: [
          {
            systemPrompt: row.request?.system ?? "",
            userPrompt: extractUser(row),
            response: extractExpected(row),
          },
        ],
        providerAccesses: [],
      },
    ],
    metadata: row.metadata,
  }));

  const filtered = applyPrivacyFilter(trajectories, options.privacy ?? {});
  const examples: Example[] = [];
  for (let i = 0; i < filtered.trajectories.length; i += 1) {
    const trajectory = filtered.trajectories[i];
    if (!trajectory) continue;
    const call = trajectory.steps?.[0]?.llmCalls?.[0];
    const userPrompt = call?.userPrompt;
    const expected = call?.response;
    if (!userPrompt || !expected) continue;
    const inputs: Record<string, unknown> = { [inputField]: userPrompt };
    if (
      typeof call?.systemPrompt === "string" &&
      call.systemPrompt.length > 0
    ) {
      inputs.system = call.systemPrompt;
    }
    examples.push({
      inputs,
      outputs: { [outputField]: expected },
      source: trajectory.trajectoryId,
      metadata: trajectory.metadata,
    });
  }
  return {
    examples,
    redactionCount: filtered.redactionCount,
    anonymizationCount: filtered.anonymizationCount,
    droppedTrajectories: filtered.dropped.length,
  };
}

function isJsonlRow(value: unknown): value is JsonlRow {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as JsonlRow;
  return candidate.format === "eliza_native_v1";
}

function extractUser(row: JsonlRow): string {
  const messages = row.request?.messages ?? [];
  const userTurns = messages
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content);
  if (userTurns.length > 0) return userTurns.join("\n");
  return row.request?.prompt ?? "";
}

function extractExpected(row: JsonlRow): string {
  if (row.response?.text && row.response.text.length > 0) {
    return row.response.text;
  }
  if (Array.isArray(row.response?.toolCalls)) {
    return JSON.stringify({ toolCalls: row.response.toolCalls });
  }
  const messages = row.request?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "assistant" && typeof msg.content === "string") {
      return msg.content;
    }
  }
  return "";
}

export type { FilterableTrajectory };
