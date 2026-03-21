/**
 * Coding agent context types and validation.
 *
 * Provides Zod schemas and TypeScript types for validating coding agent
 * context objects used in the autonomous coding loop: code generation,
 * execution, error capture, iterative self-correction, and human-in-the-loop
 * feedback injection.
 *
 * @module services/coding-agent-context
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/** Schema for a single file operation within a coding iteration. */
export const FileOperationSchema = z.object({
  type: z.enum(["read", "write", "edit", "list", "search"]),
  target: z.string().min(1, "File operation target must not be empty"),
  /** Size in bytes for write/edit operations. */
  size: z.number().int().nonnegative().optional(),
});

/** Schema for a shell command result captured during execution. */
export const CommandResultSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  /** Working directory where the command was executed. */
  executedIn: z.string().min(1),
  /** Duration in milliseconds. */
  durationMs: z.number().nonnegative().optional(),
  success: z.boolean(),
});

/** Schema for an error captured during code execution. */
export const CapturedErrorSchema = z.object({
  /** Error category: compile, runtime, test, lint, or other. */
  category: z.enum(["compile", "runtime", "test", "lint", "other"]),
  /** Human-readable error message. */
  message: z.string().min(1),
  /** File path where the error occurred (if applicable). */
  filePath: z.string().optional(),
  /** Line number where the error occurred (if applicable). */
  line: z.number().int().positive().optional(),
  /** Raw error output from the tool/command. */
  raw: z.string().optional(),
});

/** Schema for human feedback injected into the coding loop. */
export const HumanFeedbackSchema = z.object({
  /** Unique feedback identifier. */
  id: z.string().min(1),
  /** Timestamp when feedback was received. */
  timestamp: z.number().int().positive(),
  /** The feedback text from the user. */
  text: z.string().min(1),
  /** The context/iteration the feedback applies to. */
  iterationRef: z.number().int().nonnegative().optional(),
  /** Feedback type: correction, guidance, approval, rejection. */
  type: z.enum(["correction", "guidance", "approval", "rejection"]),
});

/** Schema for a single iteration of the coding agent loop. */
export const CodingIterationSchema = z.object({
  /** Zero-based iteration index. */
  index: z.number().int().nonnegative(),
  /** Timestamp when this iteration started. */
  startedAt: z.number().int().positive(),
  /** Timestamp when this iteration completed. */
  completedAt: z.number().int().positive().optional(),
  /** Code generation output (the generated/modified code). */
  generatedCode: z.string().optional(),
  /** File operations performed during this iteration. */
  fileOperations: z.array(FileOperationSchema).default([]),
  /** Commands executed during this iteration. */
  commandResults: z.array(CommandResultSchema).default([]),
  /** Errors captured during this iteration. */
  errors: z.array(CapturedErrorSchema).default([]),
  /** Human feedback applied at this iteration. */
  feedback: z.array(HumanFeedbackSchema).default([]),
  /** Whether this iteration resolved all errors from the previous one. */
  selfCorrected: z.boolean().default(false),
  /** Summary of what changed in this iteration. */
  summary: z.string().optional(),
});

/** Schema for the connector type used by the coding agent. */
export const ConnectorTypeSchema = z.enum([
  "local-fs",
  "git-repo",
  "api",
  "browser",
  "sandbox",
]);

/** Schema for connector configuration. */
export const ConnectorConfigSchema = z.object({
  type: ConnectorTypeSchema,
  /** Base path / URL for the connector. */
  basePath: z.string().min(1),
  /** Whether the connector is currently available. */
  available: z.boolean().default(true),
  /** Connector-specific metadata. */
  metadata: z.record(z.string(), z.string()).optional(),
});

/** Interaction mode for the coding session. */
export const InteractionModeSchema = z.enum([
  "fully-automated",
  "human-in-the-loop",
  "manual-guidance",
]);

/** Schema for the full coding agent context. */
export const CodingAgentContextSchema = z.object({
  /** Unique session identifier. */
  sessionId: z.string().min(1),
  /** Task description / goal for the coding session. */
  taskDescription: z.string().min(1),
  /** Working directory for file operations. */
  workingDirectory: z.string().min(1),
  /** Connector configuration for accessing code. */
  connector: ConnectorConfigSchema,
  /** Interaction mode for this session. */
  interactionMode: InteractionModeSchema,
  /** Maximum iterations before the loop stops. */
  maxIterations: z.number().int().positive().default(10),
  /** Whether the loop is currently active. */
  active: z.boolean().default(true),
  /** All iterations of the coding loop. */
  iterations: z.array(CodingIterationSchema).default([]),
  /** All human feedback collected during the session. */
  allFeedback: z.array(HumanFeedbackSchema).default([]),
  /** Timestamp when the session was created. */
  createdAt: z.number().int().positive(),
  /** Timestamp when the session was last updated. */
  updatedAt: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// TypeScript Types (inferred from schemas)
// ---------------------------------------------------------------------------

export type FileOperation = z.infer<typeof FileOperationSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type CapturedError = z.infer<typeof CapturedErrorSchema>;
export type HumanFeedback = z.infer<typeof HumanFeedbackSchema>;
export type CodingIteration = z.infer<typeof CodingIterationSchema>;
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
export type InteractionMode = z.infer<typeof InteractionModeSchema>;
export type CodingAgentContext = z.infer<typeof CodingAgentContextSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Result of a validation operation. */
export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: Array<{ path: string; message: string }> };

function formatValidationErrors(
  issues: Array<{ path: Array<unknown>; message: string }>,
): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Validate a coding agent context object.
 * Returns a typed result with either the validated data or an array of errors.
 */
export function validateCodingAgentContext(
  input: Record<string, unknown>,
): ValidationResult<CodingAgentContext> {
  const result = CodingAgentContextSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatValidationErrors(result.error.issues) };
}

/**
 * Validate a single coding iteration.
 */
export function validateCodingIteration(
  input: Record<string, unknown>,
): ValidationResult<CodingIteration> {
  const result = CodingIterationSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatValidationErrors(result.error.issues) };
}

/**
 * Validate human feedback input.
 */
export function validateHumanFeedback(
  input: Record<string, unknown>,
): ValidationResult<HumanFeedback> {
  const result = HumanFeedbackSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatValidationErrors(result.error.issues) };
}

/**
 * Validate a connector configuration.
 */
export function validateConnectorConfig(
  input: Record<string, unknown>,
): ValidationResult<ConnectorConfig> {
  const result = ConnectorConfigSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, errors: formatValidationErrors(result.error.issues) };
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/**
 * Create a new coding agent context with sensible defaults.
 */
export function createCodingAgentContext(params: {
  sessionId: string;
  taskDescription: string;
  workingDirectory: string;
  connectorType: ConnectorType;
  connectorBasePath: string;
  interactionMode?: InteractionMode;
  maxIterations?: number;
}): CodingAgentContext {
  const now = Date.now();
  return {
    sessionId: params.sessionId,
    taskDescription: params.taskDescription,
    workingDirectory: params.workingDirectory,
    connector: {
      type: params.connectorType,
      basePath: params.connectorBasePath,
      available: true,
    },
    interactionMode: params.interactionMode ?? "fully-automated",
    maxIterations: params.maxIterations ?? 10,
    active: true,
    iterations: [],
    allFeedback: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Check if the coding agent context has reached its iteration limit.
 */
export function hasReachedMaxIterations(ctx: CodingAgentContext): boolean {
  return ctx.iterations.length >= ctx.maxIterations;
}

/**
 * Check if the latest iteration resolved all errors.
 */
export function isLastIterationClean(ctx: CodingAgentContext): boolean {
  if (ctx.iterations.length === 0) return true;
  const last = ctx.iterations[ctx.iterations.length - 1];
  if (!last) return true;
  return last.errors.length === 0;
}

/**
 * Get all unresolved errors from the latest iteration.
 */
export function getUnresolvedErrors(ctx: CodingAgentContext): CapturedError[] {
  if (ctx.iterations.length === 0) return [];
  const last = ctx.iterations[ctx.iterations.length - 1];
  if (!last) return [];
  return last.errors;
}

/**
 * Add an iteration to the context and update the timestamp.
 */
export function addIteration(
  ctx: CodingAgentContext,
  iteration: CodingIteration,
): CodingAgentContext {
  return {
    ...ctx,
    iterations: [...ctx.iterations, iteration],
    updatedAt: Date.now(),
  };
}

/**
 * Inject human feedback into the context.
 */
export function injectFeedback(
  ctx: CodingAgentContext,
  feedback: HumanFeedback,
): CodingAgentContext {
  return {
    ...ctx,
    allFeedback: [...ctx.allFeedback, feedback],
    updatedAt: Date.now(),
  };
}

/**
 * Determine if the coding loop should continue based on context state.
 */
export function shouldContinueLoop(ctx: CodingAgentContext): {
  shouldContinue: boolean;
  reason: string;
} {
  if (!ctx.active) {
    return { shouldContinue: false, reason: "Session is no longer active" };
  }

  if (hasReachedMaxIterations(ctx)) {
    return {
      shouldContinue: false,
      reason: `Reached maximum iterations (${ctx.maxIterations})`,
    };
  }

  if (isLastIterationClean(ctx) && ctx.iterations.length > 0) {
    return {
      shouldContinue: false,
      reason: "Last iteration completed without errors",
    };
  }

  // Check for human rejection feedback that should halt the loop
  const lastFeedback = ctx.allFeedback[ctx.allFeedback.length - 1];
  if (lastFeedback?.type === "rejection") {
    return {
      shouldContinue: false,
      reason: "User rejected the last iteration",
    };
  }

  return { shouldContinue: true, reason: "Errors to resolve or work to do" };
}
