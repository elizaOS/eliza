/**
 * Debug Tracing Module for elizaOS
 *
 * Provides comprehensive execution tracing for cloud chat runs.
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

// Collector
export {
  DebugTraceCollector,
  getActiveCollectorCount,
  getCollector,
  registerCollector,
  removeCollector,
} from "./collector";
// Plugin
export {
  debugPlugin,
  getDebugPluginIfEnabled,
  isDebugTracingEnabled,
} from "./plugin";
// Renderer
export { DebugTraceRenderer, renderDebugTrace } from "./renderer";
// Store
export {
  clearDebugTraces,
  DebugTraceStore,
  debugTraceStore,
  getDebugTrace,
  getDebugTraceStoreStats,
  getLatestDebugTrace,
  listDebugTraces,
  storeDebugTrace,
} from "./store";
// Types
export {
  type ActionExecutionStepData,
  // Event types
  DebugEventType,
  type DebugEventTypeValue,
  type DebugFailure,
  type DebugIterationPayload,
  type DebugModelCallEndPayload,
  type DebugModelCallStartPayload,
  type DebugParseResultPayload,
  type DebugPromptComposedPayload,
  // Render types
  type DebugRenderView,
  // Event payloads
  type DebugStateComposedPayload,
  // Trace types
  type DebugStep,
  type DebugStepData,
  // Step types
  type DebugStepType,
  type DebugTrace,
  type DebugTraceRenderOptions,
  type DebugTraceSummary,
  type FailureType,
  type IterationBoundaryStepData,
  type ModelCallStepData,
  type ParseResultStepData,
  type PromptCompositionStepData,
  type StateCompositionStepData,
  // Test integration types
  type TestMessageDebugOptions,
  type TestMessageDebugResult,
  type TraceStatus,
} from "./types";
