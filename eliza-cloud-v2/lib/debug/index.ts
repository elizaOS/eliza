/**
 * Debug Tracing Module for elizaOS
 *
 * Provides comprehensive execution tracing across all agent modes:
 * CHAT, ASSISTANT, BUILD, and MULTI_STEP
 *
 * Usage:
 *   1. Enable via environment variable: DEBUG_TRACING=true
 *   2. Register debugPlugin with runtime (optional auto-loading)
 *   3. Access traces via debugTraceStore or getLatestDebugTrace()
 *   4. Render traces with renderDebugTrace(trace, 'summary')
 *
 * @example
 * ```typescript
 * import {
 *   isDebugTracingEnabled,
 *   getLatestDebugTrace,
 *   renderDebugTrace,
 *   getDebugPluginIfEnabled,
 * } from '@/lib/debug';
 *
 * // Register plugin if enabled
 * const debugPlugin = getDebugPluginIfEnabled();
 * if (debugPlugin) {
 *   runtime.registerPlugin(debugPlugin);
 * }
 *
 * // After message processing
 * const trace = getLatestDebugTrace();
 * if (trace) {
 *   console.log(renderDebugTrace(trace, 'summary'));
 * }
 * ```
 */

// Types
export {
  // Event types
  DebugEventType,
  type DebugEventTypeValue,

  // Step types
  type DebugStepType,
  type DebugStepData,
  type StateCompositionStepData,
  type PromptCompositionStepData,
  type ModelCallStepData,
  type ParseResultStepData,
  type ActionExecutionStepData,
  type IterationBoundaryStepData,

  // Trace types
  type DebugStep,
  type DebugTrace,
  type DebugTraceSummary,
  type DebugFailure,
  type TraceStatus,
  type FailureType,

  // Event payloads
  type DebugStateComposedPayload,
  type DebugPromptComposedPayload,
  type DebugParseResultPayload,
  type DebugIterationPayload,
  type DebugModelCallStartPayload,
  type DebugModelCallEndPayload,

  // Render types
  type DebugRenderView,
  type DebugTraceRenderOptions,

  // Test integration types
  type TestMessageDebugOptions,
  type TestMessageDebugResult,
} from "./types";

// Collector
export {
  DebugTraceCollector,
  registerCollector,
  getCollector,
  removeCollector,
  getActiveCollectorCount,
} from "./collector";

// Store
export {
  DebugTraceStore,
  debugTraceStore,
  storeDebugTrace,
  getDebugTrace,
  getLatestDebugTrace,
  listDebugTraces,
  clearDebugTraces,
  getDebugTraceStoreStats,
} from "./store";

// Renderer
export { DebugTraceRenderer, renderDebugTrace } from "./renderer";

// Plugin
export {
  debugPlugin,
  isDebugTracingEnabled,
  getDebugPluginIfEnabled,
} from "./plugin";
