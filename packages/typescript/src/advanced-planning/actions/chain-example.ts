import { v4 as uuidv4 } from "uuid";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import type { JsonValue } from "../types.ts";

type PlanningActionOptions = HandlerOptions & {
  abortSignal?: AbortSignal;
  previousResults?: ActionResult[];
  chainContext?: {
    chainId?: string;
    totalActions?: number;
  };
};

export const analyzeInputAction: Action = {
  name: "ANALYZE_INPUT",
  description: "Analyzes user input and extracts key information",

  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: PlanningActionOptions,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    if (options?.abortSignal?.aborted) {
      throw new Error("Analysis aborted");
    }

    const text = message.content.text || "";
    const words = text.trim() ? text.split(/\s+/) : [];
    const hasNumbers = /\d/.test(text);
    const lowerText = text.toLowerCase();
    const sentiment =
      lowerText.includes("urgent") ||
      lowerText.includes("emergency") ||
      lowerText.includes("critical")
        ? "urgent"
        : lowerText.includes("good")
          ? "positive"
          : lowerText.includes("bad")
            ? "negative"
            : "neutral";

    const analysis = {
      wordCount: words.length,
      hasNumbers,
      sentiment,
      topics: words.filter((w) => w.length >= 5).map((w) => w.toLowerCase()),
      timestamp: Date.now(),
    };

    return {
      success: true,
      data: analysis,
      text: `Analyzed ${words.length} words with ${sentiment} sentiment`,
    };
  },
};

export const processAnalysisAction: Action = {
  name: "PROCESS_ANALYSIS",
  description: "Processes the analysis results and makes decisions",

  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: PlanningActionOptions,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const previousResults =
      options?.previousResults ?? options?.actionContext?.previousResults;
    const previousResult = previousResults?.[0];
    if (!previousResult?.data) {
      throw new Error("No analysis data available");
    }

    const data = previousResult.data as {
      wordCount: number;
      sentiment: string;
    };

    const decisions = {
      needsMoreInfo: data.wordCount < 5,
      isComplex: data.wordCount > 20,
      requiresAction: data.sentiment !== "neutral" || data.wordCount > 8,
      suggestedResponse:
        data.sentiment === "positive"
          ? "Thank you for the positive feedback!"
          : data.sentiment === "negative"
            ? "I understand your concerns and will help address them."
            : "I can help you with that.",
    };

    await new Promise((resolve) => setTimeout(resolve, 200));

    if (options?.abortSignal?.aborted) {
      throw new Error("Processing aborted");
    }

    return {
      success: true,
      data: {
        analysis: data,
        decisions,
        processedAt: Date.now(),
        // Chain control flags stored in data for downstream access
        shouldContinue: !decisions.needsMoreInfo,
      },
      text: decisions.suggestedResponse,
      continueChain: !decisions.needsMoreInfo,
    };
  },
};

export const executeFinalAction: Action = {
  name: "EXECUTE_FINAL",
  description: "Executes the final action based on processing results",

  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: PlanningActionOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const previousResults =
      options?.previousResults ?? options?.actionContext?.previousResults;
    const processingResult = previousResults?.find(
      (r) =>
        (r.data as Record<string, JsonValue> | undefined)?.decisions !==
        undefined,
    );

    const processingData = processingResult?.data as
      | { decisions?: { suggestedResponse: string; requiresAction: boolean } }
      | undefined;

    if (!processingData?.decisions) {
      throw new Error("No processing results available");
    }

    const execution = {
      action: processingData.decisions.requiresAction
        ? "RESPOND"
        : "ACKNOWLEDGE",
      message: processingData.decisions.suggestedResponse,
      metadata: {
        chainId: options?.chainContext?.chainId,
        totalSteps: options?.chainContext?.totalActions,
        completedAt: Date.now(),
      },
    };

    await new Promise((resolve) => setTimeout(resolve, 100));

    if (callback) {
      await callback({
        text: execution.message,
        source: "chain_example",
      });
    }

    return {
      success: true,
      data: {
        ...execution,
        metadata: {
          chainId: String(execution.metadata.chainId || ""),
          totalSteps: Number(execution.metadata.totalSteps || 0),
          completedAt: Number(execution.metadata.completedAt || Date.now()),
        },
      },
      text: execution.message,
      cleanup: () => {
        // eslint-disable-next-line no-console
        console.log("[ChainExample] Cleaning up resources...");
      },
    };
  },
};

export const createPlanAction: Action = {
  name: "CREATE_PLAN",
  description:
    "Creates a comprehensive project plan with multiple phases and tasks",
  similes: ["PLAN_PROJECT", "GENERATE_PLAN", "MAKE_PLAN", "PROJECT_PLAN"],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text?.toLowerCase() || "";
    return (
      text.includes("plan") ||
      text.includes("project") ||
      text.includes("comprehensive") ||
      text.includes("organize") ||
      text.includes("strategy")
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: PlanningActionOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const plan = {
      id: uuidv4(),
      name: "Comprehensive Project Plan",
      description: "Multi-phase project plan with coordinated execution",
      createdAt: Date.now(),
      phases: [
        {
          id: "phase_1",
          name: "Setup and Infrastructure",
          description: "Initial project setup and infrastructure creation",
          tasks: [
            {
              id: "task_1_1",
              name: "Repository Setup",
              description: "Create GitHub repository with proper documentation",
              action: "CREATE_GITHUB_REPO",
              dependencies: [],
              estimatedDuration: "30 minutes",
            },
          ],
        },
      ],
      executionStrategy: "sequential",
      totalEstimatedDuration: "4 hours",
      successCriteria: ["All phases completed successfully"],
    };

    if (callback) {
      await callback({
        text: `I've created a comprehensive project plan with ${plan.phases.length} phase(s).`,
        actions: ["CREATE_PLAN"],
        source: "planning",
      });
    }

    return {
      success: true,
      data: {
        actionName: "CREATE_PLAN",
        phaseCount: plan.phases.length,
        taskCount: plan.phases.reduce(
          (total, phase) => total + phase.tasks.length,
          0,
        ),
        planId: plan.id,
      },
      text: `Created ${plan.phases.length}-phase plan`,
    };
  },
};
