/**
 * Debug Tracing Types for elizaOS
 *
 * Comprehensive type definitions for execution tracing across cloud chat runs.
 */

import type { UUID } from "@elizaos/core";

// ============================================================================
// Debug Event Types (using 'debug:' prefix convention)
// ============================================================================

export const DebugEventType = {
  STATE_COMPOSED: "debug:state_composed",
  PROMPT_COMPOSED: "debug:prompt_composed",
  PARSE_RESULT: "debug:parse_result",
  ITERATION_START: "debug:iteration_start",
  ITERATION_END: "debug:iteration_end",
  MODEL_CALL_START: "debug:model_call_start",
  MODEL_CALL_END: "debug:model_call_end",
} as const;

export type DebugEventTypeValue = (typeof DebugEventType)[keyof typeof DebugEventType];

// ============================================================================
// Failure Types
// ============================================================================

export type FailureType =
  | "parse_failure"
  | "action_failure"
  | "model_timeout"
  | "max_iterations_reached"
  | "missing_provider_data"
  | "template_variable_missing"
  | "action_not_found"
  | "service_unavailable"
  | "unknown_error";

// ============================================================================
// Debug Step Types (Discriminated Union)
// ============================================================================

export type DebugStepType =
  | "state_composition"
  | "prompt_composition"
  | "model_call"
  | "parse_result"
  | "action_execution"
  | "iteration_boundary";

export interface BaseStepData {
  type: DebugStepType;
}

export interface StateCompositionStepData extends BaseStepData {
  type: "state_composition";
  requestedProviders: string[];
  providerOutputs: Record<
    string,
    {
      text?: string;
      values?: Record<string, unknown>;
      durationMs?: number;
      error?: string;
    }
  >;
  composedValues: Record<string, unknown>;
  durationMs: number;
}

export interface PromptCompositionStepData extends BaseStepData {
  type: "prompt_composition";
  templateName: string;
  templateSource?: string;
  composedPrompt: string;
  estimatedTokens: number;
  iteration: number;
  purpose: "planning" | "response" | "shouldRespond" | "singleShot" | "other";
}

export interface ModelCallStepData extends BaseStepData {
  type: "model_call";
  modelType: string;
  provider?: string;
  prompt: string;
  promptTokensEstimate: number;
  response: string;
  responseTokensEstimate: number;
  durationMs: number;
  iteration: number;
  purpose: string;
  settings?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  };
  hasStreaming?: boolean;
}

export interface ParseResultStepData extends BaseStepData {
  type: "parse_result";
  rawInput: string;
  success: boolean;
  parsedOutput?: Record<string, unknown>;
  parseError?: string;
  attemptNumber: number;
  maxAttempts: number;
  iteration: number;
}

export interface ActionExecutionStepData extends BaseStepData {
  type: "action_execution";
  actionName: string;
  actionId?: UUID;
  parameters: Record<string, unknown>;
  result: {
    success: boolean;
    text?: string;
    values?: Record<string, unknown>;
    data?: Record<string, unknown>;
    error?: string;
  };
  iteration: number;
  durationMs: number;
  thought?: string;
}

export interface IterationBoundaryStepData extends BaseStepData {
  type: "iteration_boundary";
  iteration: number;
  isStart: boolean;
  timestamp: number;
}

export type DebugStepData =
  | StateCompositionStepData
  | PromptCompositionStepData
  | ModelCallStepData
  | ParseResultStepData
  | ActionExecutionStepData
  | IterationBoundaryStepData;

// ============================================================================
// Debug Step
// ============================================================================

export interface DebugStep {
  stepIndex: number;
  type: DebugStepType;
  timestamp: number;
  durationMs?: number;
  data: DebugStepData;
}

// ============================================================================
// Debug Failure
// ============================================================================

export interface DebugFailure {
  type: FailureType;
  stepIndex: number;
  timestamp: number;
  message: string;
  details: Record<string, unknown>;
  suggestedFix?: string;
  relatedFiles?: {
    path: string;
    lineNumber?: number;
    relevance: string;
  }[];
}

// ============================================================================
// Debug Trace Summary
// ============================================================================

export interface DebugTraceSummary {
  totalModelCalls: number;
  totalActions: number;
  failedActions: number;
  successfulActions: number;
  iterationCount: number;
  maxIterations: number;
  totalPromptTokens: number;
  totalResponseTokens: number;
  parseAttempts: number;
  parseFailures: number;
  totalDurationMs: number;
}

// ============================================================================
// Debug Trace (Complete Execution Trace)
// ============================================================================

export type TraceStatus = "running" | "completed" | "error" | "timeout";

export interface DebugTrace {
  // Metadata
  runId: UUID;
  messageId?: UUID;
  roomId: UUID;
  entityId: UUID;
  agentId: UUID;

  // Mode information
  agentMode: "chat" | "unknown";
  source: string;

  // Timing
  startedAt: number;
  endedAt?: number;
  durationMs?: number;

  // Status
  status: TraceStatus;
  errorMessage?: string;

  // Input
  inputMessage: {
    text: string;
    source?: string;
    metadata?: Record<string, unknown>;
  };

  // Execution steps (ordered by timestamp)
  steps: DebugStep[];

  // Summary (computed)
  summary: DebugTraceSummary;

  // Auto-detected failures
  failures: DebugFailure[];

  // Final output
  finalResponse?: {
    text: string;
    thought?: string;
  };
}

// ============================================================================
// Debug Event Payloads
// ============================================================================

export interface DebugStateComposedPayload {
  runId: UUID;
  requestedProviders: string[];
  providerOutputs: Record<
    string,
    {
      text?: string;
      values?: Record<string, unknown>;
      durationMs?: number;
      error?: string;
    }
  >;
  composedValues: Record<string, unknown>;
  durationMs: number;
}

export interface DebugPromptComposedPayload {
  runId: UUID;
  templateName: string;
  composedPrompt: string;
  estimatedTokens: number;
  iteration: number;
  purpose: "planning" | "response" | "shouldRespond" | "singleShot" | "other";
}

export interface DebugParseResultPayload {
  runId: UUID;
  rawInput: string;
  success: boolean;
  parsedOutput?: Record<string, unknown>;
  parseError?: string;
  attemptNumber: number;
  maxAttempts: number;
  iteration: number;
}

export interface DebugIterationPayload {
  runId: UUID;
  iteration: number;
  isStart: boolean;
}

export interface DebugModelCallStartPayload {
  runId: UUID;
  modelType: string;
  prompt: string;
  purpose: string;
  iteration: number;
  hasStreaming: boolean;
}

export interface DebugModelCallEndPayload {
  runId: UUID;
  response: string;
  durationMs: number;
  provider?: string;
  settings?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  };
}

// ============================================================================
// Render Options
// ============================================================================

export type DebugRenderView = "summary" | "prompts" | "actions" | "failures" | "full";

export interface DebugTraceRenderOptions {
  view: DebugRenderView;
  maxPromptLength?: number;
  includeRawResponses?: boolean;
  includeTimestamps?: boolean;
  includeStepIndices?: boolean;
}

// ============================================================================
// Utility Types
// ============================================================================

export interface TestMessageDebugOptions {
  enabled: boolean;
  renderView?: DebugRenderView;
  storeTrace?: boolean;
}

export interface TestMessageDebugResult {
  debugTrace?: DebugTrace;
  debugMarkdown?: string;
}
