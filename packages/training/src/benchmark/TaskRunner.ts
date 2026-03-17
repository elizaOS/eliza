import {
  getAgentRuntimeManager,
  getAgentService,
  getTaskInteractor,
} from "../dependencies";
import { logger } from "../utils/logger";

export interface TaskRunnerConfig {
  agentName: string;
  taskPrompt: string;
  iterations: number;
  model: string;
}

export interface TaskRunResult {
  iteration: number;
  success: boolean;
  response: string;
  trajectoryId?: string;
  error?: string;
  duration: number;
}

export class TaskRunner {
  private config: TaskRunnerConfig;

  constructor(config: TaskRunnerConfig) {
    this.config = config;
  }

  async run(): Promise<TaskRunResult[]> {
    logger.info(
      "Starting Task Benchmark",
      { config: this.config },
      "TaskRunner",
    );

    const agentService = getAgentService();
    const runtimeManager = getAgentRuntimeManager();
    const taskInteractor = getTaskInteractor();

    // 1. Create or get agent
    // For simplicity, we assume we create a temp agent or use existing.
    // Let's create a temporary agent for this run to ensure clean state.
    const agentUser = await agentService.createAgent({
      userId: "task-benchmark-manager", // Dummy manager ID
      name: this.config.agentName,
      system: "You are a helpful assistant.", // Base system prompt
      bio: ["Helpful", "Smart"],
      modelTier: "standard", // or whatever maps to config.model internally
    });

    const runtime = await runtimeManager.getRuntime(agentUser.id);
    if (!runtime) {
      throw new Error(`Failed to get runtime for agent ${agentUser.id}`);
    }

    const results: TaskRunResult[] = [];

    // 2. Run iterations
    for (let i = 0; i < this.config.iterations; i++) {
      logger.info(
        `Running iteration ${i + 1}/${this.config.iterations}...`,
        {},
        "TaskRunner",
      );
      const start = Date.now();

      try {
        const result = await taskInteractor.executeTask(
          runtime,
          this.config.taskPrompt,
        );

        results.push({
          iteration: i + 1,
          success: result.success,
          response: result.response,
          trajectoryId: result.trajectoryId,
          error: result.error,
          duration: Date.now() - start,
        });
      } catch (err) {
        logger.error("Iteration failed", { error: err }, "TaskRunner");
        results.push({
          iteration: i + 1,
          success: false,
          response: "",
          error: err instanceof Error ? err.message : String(err),
          duration: Date.now() - start,
        });
      }
    }

    // 3. Cleanup ?
    // AgentService might not have delete method exposed in interface?
    // Dependencies has `resetRuntime` but not deleteAgent.
    // Access adapter if needed, but for now we leave it.

    return results;
  }
}
