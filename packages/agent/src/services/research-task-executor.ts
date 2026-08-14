/**
 * TaskExecutor for research-shaped work. It requires a real RESEARCH model and
 * translates provider failures into an explicit task failure at the executor boundary.
 */
import {
  ElizaError,
  type IAgentRuntime,
  isElizaError,
  ModelType,
} from "@elizaos/core";
import type { TaskExecutor, TaskResult, TaskSpec } from "./task-executor.ts";

const RESEARCH_PATTERNS =
  /\b(research|investigate|analyze|find out|look into|explore|summarize|compare|evaluate|review|study|assess)\b/i;

/** Executes research only through a provider that implements the RESEARCH contract. */
export class ResearchTaskExecutor implements TaskExecutor {
  readonly type = "research";
  readonly description =
    "Decomposes research questions and produces analysis artifacts";

  canHandle(spec: TaskSpec, _runtime: IAgentRuntime): boolean {
    if (spec.type === "research") return true;
    return RESEARCH_PATTERNS.test(spec.description);
  }

  async execute(spec: TaskSpec, runtime: IAgentRuntime): Promise<TaskResult> {
    const startTime = Date.now();
    try {
      let researchResult:
        | {
            text?: string;
            annotations?: Array<{ url?: string; title?: string }>;
          }
        | string;
      try {
        researchResult = (await runtime.useModel(ModelType.RESEARCH, {
          input: spec.description,
          tools: [{ type: "web_search_preview" }],
          background: true,
          reasoningSummary: "auto",
        })) as
          | {
              text?: string;
              annotations?: Array<{ url?: string; title?: string }>;
            }
          | string;
      } catch (cause) {
        // error-policy:J2 provider errors gain a stable research-task code and
        // preserve their cause before the executor boundary translates them.
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new ElizaError(
          `The configured research provider failed: ${detail}`,
          {
            code: "RESEARCH_PROVIDER_FAILED",
            cause,
            context: { taskId: spec.id },
            severity: "ephemeral",
          },
        );
      }

      const output =
        typeof researchResult === "string"
          ? researchResult
          : (researchResult.text ?? "");
      if (output.trim().length === 0) {
        throw new ElizaError("The research provider returned no report", {
          code: "RESEARCH_EMPTY_RESULT",
          context: { taskId: spec.id },
        });
      }

      return {
        taskId: spec.id,
        success: true,
        output,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      // error-policy:J1 TaskExecutor is the result boundary consumed by the
      // orchestrator, so typed failures become an explicit unsuccessful result.
      const failure = isElizaError(error)
        ? error
        : new ElizaError("Research execution failed", {
            code: "RESEARCH_EXECUTION_FAILED",
            cause: error,
            context: { taskId: spec.id },
          });
      return {
        taskId: spec.id,
        success: false,
        errorCode: failure.code,
        error: failure.message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async abort(_taskId: string): Promise<void> {
    // Research tasks are sequential LLM calls — no persistent process to abort.
  }
}
