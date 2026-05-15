/**
 * Debug Trace Renderer
 *
 * Renders DebugTrace objects to human-readable markdown with multiple view modes:
 * - summary: Quick overview with execution timeline
 * - prompts: Detailed prompt and response analysis
 * - actions: Action execution details
 * - failures: Detailed failure analysis with fixes
 * - full: Combined all views
 */

import type {
  ActionExecutionStepData,
  DebugRenderView,
  DebugTrace,
  DebugTraceRenderOptions,
  IterationBoundaryStepData,
  ModelCallStepData,
  ParseResultStepData,
  PromptCompositionStepData,
  StateCompositionStepData,
} from "./types";

// ============================================================================
// Utility Functions
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

function formatRelativeTime(timestamp: number, startTime: number): string {
  const relativeMs = timestamp - startTime;
  return `+${formatDuration(relativeMs)}`;
}

function truncate(text: string, maxLength: number = 500): string {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}

function statusEmoji(status: string): string {
  switch (status) {
    case "completed":
      return "✅";
    case "error":
      return "❌";
    case "timeout":
      return "⏰";
    case "running":
      return "🔄";
    default:
      return "❓";
  }
}

function successEmoji(success: boolean): string {
  return success ? "✅" : "❌";
}

function _escapeMarkdown(text: string): string {
  return text.replace(/[`]/g, "\\`");
}

// ============================================================================
// Debug Trace Renderer
// ============================================================================

export class DebugTraceRenderer {
  private trace: DebugTrace;

  constructor(trace: DebugTrace) {
    this.trace = trace;
  }

  render(options?: Partial<DebugTraceRenderOptions>): string {
    const opts: DebugTraceRenderOptions = {
      view: options?.view ?? "summary",
      maxPromptLength: options?.maxPromptLength ?? 1000,
      includeRawResponses: options?.includeRawResponses ?? true,
      includeTimestamps: options?.includeTimestamps ?? true,
      includeStepIndices: options?.includeStepIndices ?? false,
    };

    switch (opts.view) {
      case "summary":
        return this.renderSummary(opts);
      case "prompts":
        return this.renderPromptView(opts);
      case "actions":
        return this.renderActionView(opts);
      case "failures":
        return this.renderFailureView(opts);
      case "full":
        return this.renderFullView(opts);
      default:
        return this.renderSummary(opts);
    }
  }

  // ============================================================================
  // Summary View
  // ============================================================================

  renderSummary(opts: DebugTraceRenderOptions): string {
    const { trace } = this;
    const lines: string[] = [];

    // Header
    lines.push(`# Debug Trace: ${trace.runId.substring(0, 8)}`);
    lines.push("");

    // Status section
    lines.push("## Summary");
    lines.push(`- **Status**: ${statusEmoji(trace.status)} ${trace.status}`);
    lines.push(`- **Mode**: ${trace.agentMode.toUpperCase()}`);
    lines.push(`- **Duration**: ${formatDuration(trace.durationMs ?? 0)}`);
    lines.push(`- **Iterations**: ${trace.summary.iterationCount}/${trace.summary.maxIterations}`);
    lines.push(
      `- **Actions**: ${trace.summary.totalActions} executed, ${trace.summary.failedActions} failed`,
    );
    lines.push(`- **Model Calls**: ${trace.summary.totalModelCalls}`);
    lines.push(
      `- **Tokens**: ~${trace.summary.totalPromptTokens} prompt, ~${trace.summary.totalResponseTokens} response`,
    );
    lines.push(
      `- **Parse Failures**: ${trace.summary.parseFailures}/${trace.summary.parseAttempts}`,
    );
    lines.push("");

    // Input
    lines.push("## Input");
    lines.push(`> ${truncate(trace.inputMessage.text, 200)}`);
    lines.push("");

    // Execution Timeline
    lines.push("## Execution Timeline");
    lines.push("");

    let _currentIteration = 0;
    for (const step of trace.steps) {
      const relTime = opts.includeTimestamps
        ? `[${formatRelativeTime(step.timestamp, trace.startedAt)}] `
        : "";
      const stepIdx = opts.includeStepIndices ? `(#${step.stepIndex}) ` : "";

      switch (step.data.type) {
        case "iteration_boundary": {
          const data = step.data as IterationBoundaryStepData;
          if (data.isStart) {
            _currentIteration = data.iteration;
            lines.push(`### Iteration ${data.iteration}`);
          }
          break;
        }
        case "state_composition": {
          const data = step.data as StateCompositionStepData;
          lines.push(
            `${relTime}${stepIdx}State composed (${data.requestedProviders.length} providers, ${formatDuration(data.durationMs)})`,
          );
          break;
        }
        case "prompt_composition": {
          const data = step.data as PromptCompositionStepData;
          lines.push(
            `${relTime}${stepIdx}Prompt: **${data.purpose}** (~${data.estimatedTokens} tokens)`,
          );
          break;
        }
        case "model_call": {
          const data = step.data as ModelCallStepData;
          lines.push(
            `${relTime}${stepIdx}Model: ${data.modelType} (${formatDuration(data.durationMs)}) -> ~${data.responseTokensEstimate} tokens`,
          );
          break;
        }
        case "parse_result": {
          const data = step.data as ParseResultStepData;
          const result = data.success ? "success" : "failed";
          lines.push(`${relTime}${stepIdx}Parse: ${result}`);
          break;
        }
        case "action_execution": {
          const data = step.data as ActionExecutionStepData;
          const status = data.result.success ? "✅" : "❌";
          lines.push(
            `${relTime}${stepIdx}Action: **${data.actionName}** ${status} (${formatDuration(data.durationMs)})`,
          );
          break;
        }
      }
    }
    lines.push("");

    // Final Response
    if (trace.finalResponse) {
      lines.push("## Final Response");
      lines.push(`> ${truncate(trace.finalResponse.text, 300)}`);
      lines.push("");
    }

    // Failures summary
    if (trace.failures.length > 0) {
      lines.push("## Failures");
      for (const failure of trace.failures) {
        lines.push(`- **${failure.type}**: ${failure.message}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ============================================================================
  // Prompts View
  // ============================================================================

  renderPromptView(opts: DebugTraceRenderOptions): string {
    const { trace } = this;
    const lines: string[] = [];

    lines.push(`# Debug Trace: ${trace.runId.substring(0, 8)} - Prompts`);
    lines.push("");

    const promptSteps = trace.steps.filter((s) => s.data.type === "prompt_composition");
    const modelSteps = trace.steps.filter((s) => s.data.type === "model_call");
    const parseSteps = trace.steps.filter((s) => s.data.type === "parse_result");

    let promptIdx = 0;
    for (const step of promptSteps) {
      const data = step.data as PromptCompositionStepData;
      promptIdx++;

      lines.push(`## Prompt ${promptIdx}: ${data.purpose} (Iteration ${data.iteration})`);
      lines.push("");
      lines.push(`**Template**: \`${data.templateName}\``);
      lines.push(`**Estimated Tokens**: ~${data.estimatedTokens}`);
      lines.push("");

      lines.push("### Composed Prompt");
      lines.push("```");
      lines.push(truncate(data.composedPrompt, opts.maxPromptLength ?? 1000));
      lines.push("```");
      lines.push("");

      // Find corresponding model call and parse result
      const modelStep = modelSteps.find(
        (s) =>
          (s.data as ModelCallStepData).iteration === data.iteration &&
          (s.data as ModelCallStepData).purpose === data.purpose,
      );

      if (modelStep && opts.includeRawResponses) {
        const modelData = modelStep.data as ModelCallStepData;
        lines.push("### Model Response");
        lines.push(
          `**Model**: ${modelData.modelType} | **Duration**: ${formatDuration(modelData.durationMs)}`,
        );
        lines.push("```");
        lines.push(truncate(modelData.response, opts.maxPromptLength ?? 1000));
        lines.push("```");
        lines.push("");
      }

      // Find parse result
      const parseStep = parseSteps.find(
        (s) => (s.data as ParseResultStepData).iteration === data.iteration,
      );

      if (parseStep) {
        const parseData = parseStep.data as ParseResultStepData;
        lines.push("### Parse Result");
        lines.push(`**Success**: ${successEmoji(parseData.success)}`);
        if (parseData.parsedOutput) {
          lines.push("```json");
          lines.push(JSON.stringify(parseData.parsedOutput, null, 2));
          lines.push("```");
        }
        if (parseData.parseError) {
          lines.push(`**Error**: ${parseData.parseError}`);
        }
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }

    return lines.join("\n");
  }

  // ============================================================================
  // Actions View
  // ============================================================================

  renderActionView(opts: DebugTraceRenderOptions): string {
    const { trace } = this;
    const lines: string[] = [];

    lines.push(`# Debug Trace: ${trace.runId.substring(0, 8)} - Actions`);
    lines.push("");

    const actionSteps = trace.steps.filter((s) => s.data.type === "action_execution");

    if (actionSteps.length === 0) {
      lines.push("*No actions were executed in this trace.*");
      return lines.join("\n");
    }

    let actionIdx = 0;
    for (const step of actionSteps) {
      const data = step.data as ActionExecutionStepData;
      actionIdx++;

      lines.push(`## Action ${actionIdx}: ${data.actionName}`);
      lines.push("");
      lines.push(`**Iteration**: ${data.iteration}`);
      lines.push(
        `**Result**: ${successEmoji(data.result.success)} ${data.result.success ? "Success" : "Failed"}`,
      );
      lines.push(`**Duration**: ${formatDuration(data.durationMs)}`);
      lines.push("");

      if (data.thought) {
        lines.push("### Thought");
        lines.push(`> ${data.thought}`);
        lines.push("");
      }

      lines.push("### Input Parameters");
      lines.push("```json");
      lines.push(JSON.stringify(data.parameters, null, 2));
      lines.push("```");
      lines.push("");

      lines.push("### Result");
      if (data.result.text) {
        lines.push(`**Text**: ${truncate(data.result.text, 300)}`);
      }
      if (data.result.error) {
        lines.push(`**Error**: ${data.result.error}`);
      }
      if (data.result.values && Object.keys(data.result.values).length > 0) {
        lines.push("**Values**:");
        lines.push("```json");
        lines.push(JSON.stringify(data.result.values, null, 2));
        lines.push("```");
      }
      if (data.result.data && Object.keys(data.result.data).length > 0) {
        lines.push("**Data**:");
        lines.push("```json");
        lines.push(truncate(JSON.stringify(data.result.data, null, 2), 500));
        lines.push("```");
      }
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    return lines.join("\n");
  }

  // ============================================================================
  // Failures View
  // ============================================================================

  renderFailureView(opts: DebugTraceRenderOptions): string {
    const { trace } = this;
    const lines: string[] = [];

    lines.push(`# Debug Trace: ${trace.runId.substring(0, 8)} - Failures`);
    lines.push("");

    if (trace.failures.length === 0) {
      lines.push("*No failures detected in this trace.*");
      return lines.join("\n");
    }

    let failureIdx = 0;
    for (const failure of trace.failures) {
      failureIdx++;

      lines.push(`## Failure ${failureIdx}: ${failure.type}`);
      lines.push("");
      lines.push(`**Step**: ${failure.stepIndex}`);
      lines.push(`**Time**: ${formatRelativeTime(failure.timestamp, trace.startedAt)}`);
      lines.push("");

      lines.push("### What Happened");
      lines.push(failure.message);
      lines.push("");

      lines.push("### Details");
      lines.push("```json");
      lines.push(JSON.stringify(failure.details, null, 2));
      lines.push("```");
      lines.push("");

      if (failure.suggestedFix) {
        lines.push("### Suggested Fix");
        lines.push(failure.suggestedFix);
        lines.push("");
      }

      if (failure.relatedFiles && failure.relatedFiles.length > 0) {
        lines.push("### Related Files");
        for (const file of failure.relatedFiles) {
          const line = file.lineNumber ? `:${file.lineNumber}` : "";
          lines.push(`- \`${file.path}${line}\` - ${file.relevance}`);
        }
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }

    return lines.join("\n");
  }

  // ============================================================================
  // Full View
  // ============================================================================

  renderFullView(opts: DebugTraceRenderOptions): string {
    const sections: string[] = [];

    sections.push(this.renderSummary(opts));
    sections.push("");
    sections.push("---");
    sections.push("");
    sections.push(this.renderPromptView(opts));
    sections.push("");
    sections.push("---");
    sections.push("");
    sections.push(this.renderActionView(opts));
    sections.push("");
    sections.push("---");
    sections.push("");
    sections.push(this.renderFailureView(opts));

    return sections.join("\n");
  }
}

// ============================================================================
// Convenience Function
// ============================================================================

export function renderDebugTrace(
  trace: DebugTrace,
  view: DebugRenderView = "summary",
  options?: Partial<Omit<DebugTraceRenderOptions, "view">>,
): string {
  const renderer = new DebugTraceRenderer(trace);
  return renderer.render({ ...options, view });
}
