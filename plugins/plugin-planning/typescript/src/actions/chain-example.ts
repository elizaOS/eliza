import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";

export const analyzeInputAction: Action = {
  name: "ANALYZE_INPUT",
  description: "Analyzes user input and extracts key information",

  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    if ((options?.abortSignal as AbortSignal)?.aborted) {
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

  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const previousResults = options?.previousResults as ActionResult[] | undefined;
    const previousResult = previousResults?.[0];
    if (!previousResult?.data) {
      throw new Error("No analysis data available");
    }

    const analysis = previousResult.data as {
      wordCount: number;
      sentiment: string;
    };

    const decisions = {
      needsMoreInfo: analysis.wordCount < 5,
      isComplex: analysis.wordCount > 20,
      requiresAction: analysis.sentiment !== "neutral" || analysis.wordCount > 8,
      suggestedResponse:
        analysis.sentiment === "positive"
          ? "Thank you for the positive feedback!"
          : analysis.sentiment === "negative"
            ? "I understand your concerns and will help address them."
            : "I can help you with that.",
    };

    await new Promise((resolve) => setTimeout(resolve, 200));

    if ((options?.abortSignal as AbortSignal)?.aborted) {
      throw new Error("Processing aborted");
    }

    return {
      success: true,
      data: {
        analysis,
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

  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const previousResults = options?.previousResults as ActionResult[] | undefined;
    const processingResult = previousResults?.find(
      (r) => (r.data as Record<string, unknown>)?.decisions !== undefined
    );

    if (!(processingResult?.data as Record<string, unknown>)?.decisions) {
      throw new Error("No processing results available");
    }

    const decisions = (
      processingResult.data as Record<
        string,
        { suggestedResponse: string; requiresAction: boolean }
      >
    ).decisions;

    const execution = {
      action: decisions.requiresAction ? "RESPOND" : "ACKNOWLEDGE",
      message: decisions.suggestedResponse,
      metadata: {
        chainId: (options?.chainContext as Record<string, unknown>)?.chainId,
        totalSteps: (options?.chainContext as Record<string, unknown>)?.totalActions,
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
          chainId: String(execution.metadata?.chainId || ""),
          totalSteps: Number(execution.metadata?.totalSteps || 0),
          completedAt: Number(execution.metadata?.completedAt || Date.now()),
        },
      },
      text: execution.message,
      cleanup: () => {
        console.log("[ChainExample] Cleaning up resources...");
      },
    };
  },
};

export const createPlanAction: Action = {
  name: "CREATE_PLAN",
  description: "Creates a comprehensive project plan with multiple phases and tasks",
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
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
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
          {
            id: "phase_2",
            name: "Research and Knowledge",
            description: "Conduct research and build knowledge base",
            tasks: [
              {
                id: "task_2_1",
                name: "Research Best Practices",
                description: "Research best practices for the project domain",
                action: "start_research",
                dependencies: ["task_1_1"],
                estimatedDuration: "2 hours",
              },
              {
                id: "task_2_2",
                name: "Process Knowledge",
                description: "Store research findings in knowledge base",
                action: "PROCESS_KNOWLEDGE",
                dependencies: ["task_2_1"],
                estimatedDuration: "45 minutes",
              },
            ],
          },
          {
            id: "phase_3",
            name: "Task Management",
            description: "Create and organize project tasks",
            tasks: [
              {
                id: "task_3_1",
                name: "Create Initial Tasks",
                description: "Create todo tasks based on plan milestones",
                action: "CREATE_TODO",
                dependencies: ["task_2_2"],
                estimatedDuration: "30 minutes",
              },
            ],
          },
        ],
        executionStrategy: "sequential",
        totalEstimatedDuration: "4 hours",
        successCriteria: [
          "All phases completed successfully",
          "Repository created with documentation",
          "Research conducted and stored",
          "Tasks created and organized",
        ],
      };

      const planState = {
        planId: plan.id,
        currentPhase: 0,
        completedTasks: [] as string[],
        plan,
      };

      if (callback) {
        await callback({
          text: `I've created a comprehensive ${plan.phases.length}-phase project plan:

**Phase 1: Setup and Infrastructure**
- Repository setup with GitHub integration

**Phase 2: Research and Knowledge**  
- Research best practices
- Process and store findings

**Phase 3: Task Management**
- Create structured todo tasks

The plan includes ${plan.phases.reduce((total, phase) => total + phase.tasks.length, 0)} tasks with an estimated duration of ${plan.totalEstimatedDuration}. Each phase builds on the previous one to ensure proper coordination.

Ready to begin execution when you are!`,
          actions: ["CREATE_PLAN"],
          source: "planning",
        });
      }

      return {
        success: true,
        data: {
          actionName: "CREATE_PLAN",
          phaseCount: plan.phases.length,
          taskCount: plan.phases.reduce((total, phase) => total + phase.tasks.length, 0),
          ...planState,
        },
        text: `Created ${plan.phases.length}-phase plan with ${plan.phases.reduce((total, phase) => total + phase.tasks.length, 0)} tasks`,
      };
    } catch (error) {
      if (callback) {
        await callback({
          text: "I encountered an error while creating the comprehensive plan. Let me try a simpler approach.",
          actions: ["CREATE_PLAN"],
          source: "planning",
        });
      }

      return {
        success: false,
        text: `Failed to create plan: ${(error as Error).message}`,
        data: { actionName: "CREATE_PLAN", failed: true },
      };
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "I need to launch a new open-source project. Please create a comprehensive plan.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I've created a comprehensive 3-phase project plan for your open-source launch.",
          actions: ["CREATE_PLAN"],
        },
      },
    ],
  ],
};
