import path from "node:path";
import { z } from "zod";
import { getDefaultWorkflowIds, normalizeWorkflowId } from "./workflows.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 120_000;
const DEFAULT_MAX_STDIN_BYTES = 64 * 1024;

const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 60 * 60_000;
const MIN_OUTPUT_CHARS = 512;
const MAX_OUTPUT_CHARS = 1_000_000;
const MIN_STDIN_BYTES = 0;
const MAX_STDIN_BYTES = 5 * 1024 * 1024;

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    throw new Error(
      "CLAUDE_CODE_WORKBENCH_ENABLE_MUTATING_WORKFLOWS must be 0 or 1 when set as a number.",
    );
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }

  throw new Error(
    "CLAUDE_CODE_WORKBENCH_ENABLE_MUTATING_WORKFLOWS must be a boolean-like value.",
  );
}

const allowedWorkflowsSchema = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((value): string[] => {
    if (!value) {
      return ["*"];
    }

    const raw = Array.isArray(value) ? value : value.split(",");
    const normalized = raw
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => (entry === "*" ? "*" : normalizeWorkflowId(entry)));

    if (normalized.length === 0) {
      return ["*"];
    }

    return Array.from(new Set(normalized));
  });

export const claudeCodeWorkbenchConfigSchema = z.object({
  CLAUDE_CODE_WORKBENCH_WORKSPACE_ROOT: z.string().trim().min(1).optional(),
  CLAUDE_CODE_WORKBENCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .default(DEFAULT_TIMEOUT_MS),
  CLAUDE_CODE_WORKBENCH_MAX_OUTPUT_CHARS: z.coerce
    .number()
    .int()
    .min(MIN_OUTPUT_CHARS)
    .max(MAX_OUTPUT_CHARS)
    .default(DEFAULT_MAX_OUTPUT_CHARS),
  CLAUDE_CODE_WORKBENCH_MAX_STDIN_BYTES: z.coerce
    .number()
    .int()
    .min(MIN_STDIN_BYTES)
    .max(MAX_STDIN_BYTES)
    .default(DEFAULT_MAX_STDIN_BYTES),
  CLAUDE_CODE_WORKBENCH_ALLOWED_WORKFLOWS: allowedWorkflowsSchema,
  CLAUDE_CODE_WORKBENCH_ENABLE_MUTATING_WORKFLOWS: z
    .preprocess(parseBoolean, z.boolean())
    .default(false),
});

export interface ClaudeCodeWorkbenchConfig {
  workspaceRoot: string;
  timeoutMs: number;
  maxOutputChars: number;
  maxStdinBytes: number;
  allowedWorkflowIds: string[];
  enableMutatingWorkflows: boolean;
}

export function isWorkflowAllowed(
  workflowId: string,
  allowedWorkflowIds: string[],
): boolean {
  const normalized = normalizeWorkflowId(workflowId);
  return allowedWorkflowIds.some((entry) => {
    if (entry === "*") {
      return true;
    }
    return normalizeWorkflowId(entry) === normalized;
  });
}

export function loadClaudeCodeWorkbenchConfig(
  raw: Record<string, string | undefined>,
): ClaudeCodeWorkbenchConfig {
  const parsed = claudeCodeWorkbenchConfigSchema.parse(raw);

  const allowedWorkflowIds =
    parsed.CLAUDE_CODE_WORKBENCH_ALLOWED_WORKFLOWS?.length > 0
      ? parsed.CLAUDE_CODE_WORKBENCH_ALLOWED_WORKFLOWS
      : ["*"];

  return {
    workspaceRoot: path.resolve(
      parsed.CLAUDE_CODE_WORKBENCH_WORKSPACE_ROOT ?? process.cwd(),
    ),
    timeoutMs: parsed.CLAUDE_CODE_WORKBENCH_TIMEOUT_MS,
    maxOutputChars: parsed.CLAUDE_CODE_WORKBENCH_MAX_OUTPUT_CHARS,
    maxStdinBytes: parsed.CLAUDE_CODE_WORKBENCH_MAX_STDIN_BYTES,
    allowedWorkflowIds,
    enableMutatingWorkflows:
      parsed.CLAUDE_CODE_WORKBENCH_ENABLE_MUTATING_WORKFLOWS,
  };
}

export const DEFAULT_WORKBENCH_WORKFLOWS = getDefaultWorkflowIds();
