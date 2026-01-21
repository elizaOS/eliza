import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";

export type TrajectoryScalar = string | number | boolean | null;
export type TrajectoryData = Record<string, TrajectoryScalar>;

export type TrajectoryProviderAccess = {
  stepId: string;
  providerName: string;
  purpose: string;
  data: TrajectoryData;
  query?: TrajectoryData;
  timestamp: number;
};

export type TrajectoryLlmCall = {
  stepId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  temperature: number;
  maxTokens: number;
  purpose: string;
  actionType: string;
  latencyMs: number;
  timestamp: number;
};

/**
 * No-op trajectory logger service by default.
 *
 * Runtimes call into this service when a `trajectoryStepId` is active to capture:
 * - Provider accesses during state composition
 * - LLM calls (prompt/response/latency)
 *
 * This is intentionally lightweight: it stores logs in memory and exposes them
 * for benchmark harnesses/tests. Production systems can subclass/replace this
 * via plugin registration.
 */
export class TrajectoryLoggerService extends Service {
  static serviceType = "trajectory_logger";
  capabilityDescription =
    "Captures provider/LLM traces for benchmarks and training trajectories";

  private providerAccess: TrajectoryProviderAccess[] = [];
  private llmCalls: TrajectoryLlmCall[] = [];

  static async start(runtime: IAgentRuntime): Promise<Service> {
    return new TrajectoryLoggerService(runtime);
  }

  async stop(): Promise<void> {
    // no-op (in-memory logs)
  }

  logProviderAccess(params: {
    stepId: string;
    providerName: string;
    data: TrajectoryData;
    purpose: string;
    query?: TrajectoryData;
  }): void {
    this.providerAccess.push({
      ...params,
      timestamp: Date.now(),
    });
  }

  logLlmCall(params: Omit<TrajectoryLlmCall, "timestamp">): void {
    this.llmCalls.push({
      ...params,
      timestamp: Date.now(),
    });
  }

  getProviderAccessLogs(): readonly TrajectoryProviderAccess[] {
    return this.providerAccess;
  }

  getLlmCallLogs(): readonly TrajectoryLlmCall[] {
    return this.llmCalls;
  }
}
