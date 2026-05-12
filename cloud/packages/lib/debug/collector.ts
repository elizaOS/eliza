/**
 * Debug Trace Collector
 *
 * Collects execution trace data from event handlers and builds
 * a comprehensive DebugTrace for analysis.
 */

import type { UUID } from "@elizaos/core";
import type {
  ActionExecutionStepData,
  DebugFailure,
  DebugStep,
  DebugStepData,
  DebugTrace,
  DebugTraceSummary,
  FailureType,
  IterationBoundaryStepData,
  ModelCallStepData,
  ParseResultStepData,
  PromptCompositionStepData,
  StateCompositionStepData,
} from "./types";

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Estimate token count from text (rough approximation: ~4 chars per token)
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Create an empty summary object
 */
function createEmptySummary(): DebugTraceSummary {
  return {
    totalModelCalls: 0,
    totalActions: 0,
    failedActions: 0,
    successfulActions: 0,
    iterationCount: 0,
    maxIterations: 6,
    totalPromptTokens: 0,
    totalResponseTokens: 0,
    parseAttempts: 0,
    parseFailures: 0,
    totalDurationMs: 0,
  };
}

// ============================================================================
// Debug Trace Collector
// ============================================================================

export class DebugTraceCollector {
  private trace: DebugTrace;
  private stepIndex: number = 0;
  private currentIteration: number = 0;

  // Pending state for async operations
  private pendingModelCall?: {
    startTime: number;
    modelType: string;
    prompt: string;
    purpose: string;
    iteration: number;
    hasStreaming: boolean;
  };

  private pendingAction?: {
    startTime: number;
    actionName: string;
    actionId?: UUID;
    parameters: Record<string, unknown>;
    thought?: string;
    iteration: number;
  };

  constructor(
    runId: UUID,
    messageId: UUID | undefined,
    roomId: UUID,
    entityId: UUID,
    agentId: UUID,
    inputText: string,
    source: string,
    agentMode: "chat" | "unknown" = "unknown",
    maxIterations: number = 6,
  ) {
    this.trace = {
      runId,
      messageId,
      roomId,
      entityId,
      agentId,
      agentMode,
      source,
      startedAt: Date.now(),
      status: "running",
      inputMessage: {
        text: inputText,
        source,
      },
      steps: [],
      summary: {
        ...createEmptySummary(),
        maxIterations,
      },
      failures: [],
    };
  }

  // ============================================================================
  // Iteration Tracking
  // ============================================================================

  recordIterationStart(iteration: number): void {
    this.currentIteration = iteration;
    this.trace.summary.iterationCount = Math.max(this.trace.summary.iterationCount, iteration);

    const stepData: IterationBoundaryStepData = {
      type: "iteration_boundary",
      iteration,
      isStart: true,
      timestamp: Date.now(),
    };

    this.addStep("iteration_boundary", stepData);
  }

  recordIterationEnd(iteration: number): void {
    const stepData: IterationBoundaryStepData = {
      type: "iteration_boundary",
      iteration,
      isStart: false,
      timestamp: Date.now(),
    };

    this.addStep("iteration_boundary", stepData);
  }

  // ============================================================================
  // State Composition
  // ============================================================================

  recordStateComposition(
    requestedProviders: string[],
    providerOutputs: Record<
      string,
      {
        text?: string;
        values?: Record<string, unknown>;
        durationMs?: number;
        error?: string;
      }
    >,
    composedValues: Record<string, unknown>,
    durationMs: number,
  ): void {
    const stepData: StateCompositionStepData = {
      type: "state_composition",
      requestedProviders,
      providerOutputs,
      composedValues,
      durationMs,
    };

    this.addStep("state_composition", stepData, durationMs);

    // Auto-detect missing provider data
    for (const [name, output] of Object.entries(providerOutputs)) {
      if (output.error) {
        this.addFailure("missing_provider_data", `Provider ${name} failed`, {
          providerName: name,
          error: output.error,
        });
      }
    }
  }

  // ============================================================================
  // Prompt Composition
  // ============================================================================

  recordPromptComposition(
    templateName: string,
    composedPrompt: string,
    purpose: "planning" | "response" | "shouldRespond" | "singleShot" | "other",
    templateSource?: string,
  ): void {
    const stepData: PromptCompositionStepData = {
      type: "prompt_composition",
      templateName,
      templateSource,
      composedPrompt,
      estimatedTokens: estimateTokens(composedPrompt),
      iteration: this.currentIteration,
      purpose,
    };

    this.addStep("prompt_composition", stepData);
  }

  // ============================================================================
  // Model Calls
  // ============================================================================

  recordModelCallStart(
    modelType: string,
    prompt: string,
    purpose: string,
    hasStreaming: boolean = false,
  ): void {
    this.pendingModelCall = {
      startTime: Date.now(),
      modelType,
      prompt,
      purpose,
      iteration: this.currentIteration,
      hasStreaming,
    };
  }

  recordModelCallEnd(
    response: string,
    provider?: string,
    settings?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
    },
  ): void {
    if (!this.pendingModelCall) {
      console.warn("[DebugTraceCollector] recordModelCallEnd called without matching start");
      return;
    }

    const durationMs = Date.now() - this.pendingModelCall.startTime;
    const promptTokens = estimateTokens(this.pendingModelCall.prompt);
    const responseTokens = estimateTokens(response);

    const stepData: ModelCallStepData = {
      type: "model_call",
      modelType: this.pendingModelCall.modelType,
      provider,
      prompt: this.pendingModelCall.prompt,
      promptTokensEstimate: promptTokens,
      response,
      responseTokensEstimate: responseTokens,
      durationMs,
      iteration: this.pendingModelCall.iteration,
      purpose: this.pendingModelCall.purpose,
      settings,
      hasStreaming: this.pendingModelCall.hasStreaming,
    };

    this.addStep("model_call", stepData, durationMs);

    // Update summary
    this.trace.summary.totalModelCalls++;
    this.trace.summary.totalPromptTokens += promptTokens;
    this.trace.summary.totalResponseTokens += responseTokens;

    this.pendingModelCall = undefined;
  }

  // ============================================================================
  // Parse Results
  // ============================================================================

  recordParseResult(
    rawInput: string,
    success: boolean,
    parsedOutput?: Record<string, unknown>,
    parseError?: string,
    attemptNumber: number = 1,
    maxAttempts: number = 3,
  ): void {
    const stepData: ParseResultStepData = {
      type: "parse_result",
      rawInput,
      success,
      parsedOutput,
      parseError,
      attemptNumber,
      maxAttempts,
      iteration: this.currentIteration,
    };

    this.addStep("parse_result", stepData);

    // Update summary
    this.trace.summary.parseAttempts++;
    if (!success) {
      this.trace.summary.parseFailures++;

      // Auto-detect parse failure patterns and suggest fixes
      let suggestedFix: string | undefined;

      if (rawInput.includes("<think>") || rawInput.includes("<thinking>")) {
        suggestedFix =
          "Model is including <think> tags. Add instruction to suppress thinking in output.";
      } else if (!rawInput.trim().startsWith("<")) {
        suggestedFix =
          "Model is adding preamble text before XML. Add instruction: 'Start your response immediately with <response>'";
      } else if (!rawInput.includes("</response>") && rawInput.includes("<response>")) {
        suggestedFix =
          "Response appears truncated. Check maxTokens setting or simplify expected output structure.";
      }

      if (attemptNumber >= maxAttempts) {
        this.addFailure(
          "parse_failure",
          `Failed to parse model response after ${maxAttempts} attempts`,
          {
            rawInput: rawInput.substring(0, 500),
            parseError,
            attemptNumber,
            maxAttempts,
          },
          suggestedFix,
        );
      }
    }
  }

  // ============================================================================
  // Action Execution
  // ============================================================================

  recordActionStart(
    actionName: string,
    parameters: Record<string, unknown>,
    thought?: string,
    actionId?: UUID,
  ): void {
    this.pendingAction = {
      startTime: Date.now(),
      actionName,
      actionId,
      parameters,
      thought,
      iteration: this.currentIteration,
    };
  }

  recordActionEnd(result: {
    success: boolean;
    text?: string;
    values?: Record<string, unknown>;
    data?: Record<string, unknown>;
    error?: string;
  }): void {
    if (!this.pendingAction) {
      console.warn("[DebugTraceCollector] recordActionEnd called without matching start");
      return;
    }

    const durationMs = Date.now() - this.pendingAction.startTime;

    const stepData: ActionExecutionStepData = {
      type: "action_execution",
      actionName: this.pendingAction.actionName,
      actionId: this.pendingAction.actionId,
      parameters: this.pendingAction.parameters,
      result,
      iteration: this.pendingAction.iteration,
      durationMs,
      thought: this.pendingAction.thought,
    };

    this.addStep("action_execution", stepData, durationMs);

    // Update summary
    this.trace.summary.totalActions++;
    if (result.success) {
      this.trace.summary.successfulActions++;
    } else {
      this.trace.summary.failedActions++;

      this.addFailure("action_failure", `Action ${this.pendingAction.actionName} failed`, {
        actionName: this.pendingAction.actionName,
        parameters: this.pendingAction.parameters,
        error: result.error,
      });
    }

    this.pendingAction = undefined;
  }

  // ============================================================================
  // Failure Recording
  // ============================================================================

  recordActionNotFound(actionName: string): void {
    this.addFailure(
      "action_not_found",
      `Action '${actionName}' was requested but not found in available actions`,
      { actionName },
    );
  }

  recordMaxIterationsReached(): void {
    this.addFailure(
      "max_iterations_reached",
      `Maximum iterations (${this.trace.summary.maxIterations}) reached without completing task`,
      {
        iterationCount: this.trace.summary.iterationCount,
        maxIterations: this.trace.summary.maxIterations,
      },
    );
  }

  recordServiceUnavailable(serviceName: string): void {
    this.addFailure("service_unavailable", `Service '${serviceName}' is not available`, {
      serviceName,
    });
  }

  // ============================================================================
  // Completion
  // ============================================================================

  complete(
    status: "completed" | "error" | "timeout",
    finalResponse?: { text: string; thought?: string },
    errorMessage?: string,
  ): DebugTrace {
    this.trace.endedAt = Date.now();
    this.trace.durationMs = this.trace.endedAt - this.trace.startedAt;
    this.trace.status = status;
    this.trace.summary.totalDurationMs = this.trace.durationMs;

    if (finalResponse) {
      this.trace.finalResponse = finalResponse;
    }

    if (errorMessage) {
      this.trace.errorMessage = errorMessage;
      this.addFailure("unknown_error", errorMessage, { errorMessage });
    }

    if (status === "timeout") {
      this.addFailure("model_timeout", "Message processing timed out", {
        durationMs: this.trace.durationMs,
      });
    }

    return this.trace;
  }

  // ============================================================================
  // Accessors
  // ============================================================================

  getTrace(): DebugTrace {
    return this.trace;
  }

  getRunId(): UUID {
    return this.trace.runId;
  }

  getCurrentIteration(): number {
    return this.currentIteration;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private addStep(type: DebugStepData["type"], data: DebugStepData, durationMs?: number): void {
    const step: DebugStep = {
      stepIndex: this.stepIndex++,
      type,
      timestamp: Date.now(),
      durationMs,
      data,
    };

    this.trace.steps.push(step);
  }

  private addFailure(
    type: FailureType,
    message: string,
    details: Record<string, unknown>,
    suggestedFix?: string,
  ): void {
    const failure: DebugFailure = {
      type,
      stepIndex: this.stepIndex - 1,
      timestamp: Date.now(),
      message,
      details,
      suggestedFix,
    };

    this.trace.failures.push(failure);
  }
}

// ============================================================================
// Collector Registry (for tracking active collectors by runId)
// ============================================================================

const activeCollectors = new Map<string, DebugTraceCollector>();

export function registerCollector(collector: DebugTraceCollector): void {
  activeCollectors.set(collector.getRunId(), collector);
}

export function getCollector(runId: UUID): DebugTraceCollector | undefined {
  return activeCollectors.get(runId);
}

export function removeCollector(runId: UUID): void {
  activeCollectors.delete(runId);
}

export function getActiveCollectorCount(): number {
  return activeCollectors.size;
}
