/**
 * Debug Plugin
 *
 * Registers event listeners to collect debug traces for cloud chat runs.
 * Opt-in via DEBUG_TRACING=true environment variable.
 */

import type { Plugin, UUID } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import { DebugTraceCollector, getCollector, registerCollector, removeCollector } from "./collector";
import { storeDebugTrace } from "./store";
import type {
  DebugIterationPayload,
  DebugModelCallEndPayload,
  DebugModelCallStartPayload,
  DebugParseResultPayload,
  DebugPromptComposedPayload,
  DebugStateComposedPayload,
} from "./types";
import { DebugEventType } from "./types";

// ============================================================================
// Environment Check
// ============================================================================

export function isDebugTracingEnabled(): boolean {
  return process.env.DEBUG_TRACING === "true";
}

// ============================================================================
// Event Payload Types (from elizaOS core)
// ============================================================================

interface RunStartedPayload {
  runtime: unknown;
  runId: UUID;
  messageId: UUID;
  roomId: UUID;
  entityId: UUID;
  startTime: number;
  status: string;
  source: string;
}

interface RunEndedPayload {
  runtime: unknown;
  runId: UUID;
  messageId: UUID;
  roomId: UUID;
  entityId: UUID;
  startTime: number;
  endTime: number;
  duration: number;
  status: string;
  error?: string;
  source: string;
}

interface ActionStartedPayload {
  runtime: unknown;
  runId?: UUID;
  actionName: string;
  actionId?: UUID;
  parameters?: Record<string, unknown>;
  thought?: string;
}

interface ActionCompletedPayload {
  runtime: unknown;
  runId?: UUID;
  actionName: string;
  actionId?: UUID;
  result: {
    success: boolean;
    text?: string;
    values?: Record<string, unknown>;
    data?: Record<string, unknown>;
    error?: string;
  };
}

interface ModelUsedPayload {
  runtime: unknown;
  runId?: UUID;
  modelType: string;
  prompt: string;
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
// Event Handlers
// ============================================================================

async function handleRunStarted(payload: RunStartedPayload): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, messageId, roomId, entityId, source } = payload;
  const runtime = payload.runtime as { agentId?: UUID };
  const agentId = runtime?.agentId ?? ("unknown" as UUID);

  let agentMode: "chat" | "unknown" = "unknown";
  if (source?.includes("chat")) {
    agentMode = "chat";
  }

  // Create new collector for this run
  const collector = new DebugTraceCollector(
    runId,
    messageId,
    roomId,
    entityId,
    agentId,
    "", // Input text will be set from message content if available
    source,
    agentMode,
  );

  registerCollector(collector);

  console.log(`[Debug] Trace started: ${runId.substring(0, 8)} (mode: ${agentMode})`);
}

async function handleRunEnded(payload: RunEndedPayload): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, status, error } = payload;
  const collector = getCollector(runId);

  if (!collector) {
    console.warn(`[Debug] No collector found for runId: ${runId.substring(0, 8)}`);
    return;
  }

  // Complete the trace
  const traceStatus =
    status === "completed"
      ? "completed"
      : status === "error"
        ? "error"
        : status === "timeout"
          ? "timeout"
          : "completed";

  const trace = collector.complete(
    traceStatus as "completed" | "error" | "timeout",
    undefined,
    error,
  );

  // Store the completed trace
  storeDebugTrace(trace);

  // Clean up
  removeCollector(runId);

  console.log(
    `[Debug] Trace completed: ${runId.substring(0, 8)} (${trace.summary.totalActions} actions, ${trace.summary.totalModelCalls} model calls, ${formatDuration(trace.durationMs ?? 0)})`,
  );
}

async function handleActionStarted(payload: ActionStartedPayload): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, actionName, actionId, parameters, thought } = payload;
  if (!runId) return;

  const collector = getCollector(runId);
  if (!collector) return;

  collector.recordActionStart(actionName, parameters ?? {}, thought, actionId);
}

async function handleActionCompleted(payload: ActionCompletedPayload): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, result } = payload;
  if (!runId) return;

  const collector = getCollector(runId);
  if (!collector) return;

  collector.recordActionEnd(result);
}

async function handleModelUsed(payload: ModelUsedPayload): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, modelType, prompt, response, provider, settings } = payload;
  if (!runId) return;

  const collector = getCollector(runId);
  if (!collector) return;

  // Record as a complete model call (start + end combined)
  collector.recordModelCallStart(modelType, prompt, "model_used", false);
  collector.recordModelCallEnd(response, provider, settings);
}

// ============================================================================
// Custom Debug Event Handlers
// ============================================================================

async function handleStateComposed(
  payload: DebugStateComposedPayload & { runtime: unknown },
): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, requestedProviders, providerOutputs, composedValues, durationMs } = payload;
  const collector = getCollector(runId);
  if (!collector) return;

  collector.recordStateComposition(requestedProviders, providerOutputs, composedValues, durationMs);
}

async function handlePromptComposed(
  payload: DebugPromptComposedPayload & { runtime: unknown },
): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, templateName, composedPrompt, purpose } = payload;
  const collector = getCollector(runId);
  if (!collector) return;

  collector.recordPromptComposition(templateName, composedPrompt, purpose);
}

async function handleParseResult(
  payload: DebugParseResultPayload & { runtime: unknown },
): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, rawInput, success, parsedOutput, parseError, attemptNumber, maxAttempts } =
    payload;
  const collector = getCollector(runId);
  if (!collector) return;

  collector.recordParseResult(
    rawInput,
    success,
    parsedOutput,
    parseError,
    attemptNumber,
    maxAttempts,
  );
}

async function handleIterationStart(
  payload: DebugIterationPayload & { runtime: unknown },
): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, iteration } = payload;
  const collector = getCollector(runId);
  if (!collector) return;

  collector.recordIterationStart(iteration);
}

async function handleIterationEnd(
  payload: DebugIterationPayload & { runtime: unknown },
): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, iteration } = payload;
  const collector = getCollector(runId);
  if (!collector) return;

  collector.recordIterationEnd(iteration);
}

async function handleModelCallStart(
  payload: DebugModelCallStartPayload & { runtime: unknown },
): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, modelType, prompt, purpose, hasStreaming } = payload;
  const collector = getCollector(runId);
  if (!collector) return;

  collector.recordModelCallStart(modelType, prompt, purpose, hasStreaming);
}

async function handleModelCallEnd(
  payload: DebugModelCallEndPayload & { runtime: unknown },
): Promise<void> {
  if (!isDebugTracingEnabled()) return;

  const { runId, response, provider, settings } = payload;
  const collector = getCollector(runId);
  if (!collector) return;

  collector.recordModelCallEnd(response, provider, settings);
}

// ============================================================================
// Utility
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

// ============================================================================
// Debug Plugin Definition
// ============================================================================

// Build events object with both core and custom event handlers
// elizaOS runtime.emitEvent accepts any string event type, so custom events work at runtime
const debugPluginEvents = {
  // Core elizaOS events
  [EventType.RUN_STARTED]: [handleRunStarted as (payload: unknown) => Promise<void>],
  [EventType.RUN_ENDED]: [handleRunEnded as (payload: unknown) => Promise<void>],
  [EventType.ACTION_STARTED]: [handleActionStarted as (payload: unknown) => Promise<void>],
  [EventType.ACTION_COMPLETED]: [handleActionCompleted as (payload: unknown) => Promise<void>],
  [EventType.MODEL_USED]: [handleModelUsed as (payload: unknown) => Promise<void>],

  // Custom debug events with 'debug:' prefix
  [DebugEventType.STATE_COMPOSED]: [handleStateComposed as (payload: unknown) => Promise<void>],
  [DebugEventType.PROMPT_COMPOSED]: [handlePromptComposed as (payload: unknown) => Promise<void>],
  [DebugEventType.PARSE_RESULT]: [handleParseResult as (payload: unknown) => Promise<void>],
  [DebugEventType.ITERATION_START]: [handleIterationStart as (payload: unknown) => Promise<void>],
  [DebugEventType.ITERATION_END]: [handleIterationEnd as (payload: unknown) => Promise<void>],
  [DebugEventType.MODEL_CALL_START]: [handleModelCallStart as (payload: unknown) => Promise<void>],
  [DebugEventType.MODEL_CALL_END]: [handleModelCallEnd as (payload: unknown) => Promise<void>],
};

export const debugPlugin: Plugin = {
  name: "eliza-debug",
  description: "Debug tracing plugin for elizaOS execution analysis",

  // Cast to Plugin['events'] since elizaOS runtime accepts custom event types
  // even though the Plugin type definition only includes known EventType values
  events: debugPluginEvents as Plugin["events"],

  actions: [],
  providers: [],
  evaluators: [],
};

// ============================================================================
// Conditional Export
// ============================================================================

/**
 * Returns the debug plugin if DEBUG_TRACING is enabled, otherwise undefined.
 * Use this when registering plugins to optionally include debug tracing.
 */
export function getDebugPluginIfEnabled(): Plugin | undefined {
  if (isDebugTracingEnabled()) {
    console.log("[Debug] Debug tracing plugin enabled");
    return debugPlugin;
  }
  return undefined;
}
