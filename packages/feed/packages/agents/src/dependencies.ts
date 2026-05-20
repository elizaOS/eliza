/**
 * External dependencies for agent training services.
 *
 * Training pipeline services live in @feed/agents now, but still need a small
 * injection layer so CLI/web entrypoints can provide live app services without
 * creating circular imports.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { User } from "@feed/db";
import type { JsonValue } from "@feed/shared";

export interface CreateAgentParams {
  userId: string;
  name: string;
  description?: string;
  profileImageUrl?: string;
  coverImageUrl?: string;
  system: string;
  bio?: string[];
  personality?: string;
  tradingStrategy?: string;
  initialDeposit?: number;
  modelTier?: "lite" | "standard" | "pro";
}

export interface IAgentService {
  createAgent(params: CreateAgentParams): Promise<User>;
}

export interface IAgentRuntimeManager {
  getRuntime(agentId: string): Promise<IAgentRuntime>;
  resetRuntime(agentId: string): Promise<void>;
}

export interface IAutonomousCoordinator {
  executeAutonomousTick(
    agentUserId: string,
    agentRuntime: IAgentRuntime,
    recordTrajectories?: boolean,
  ): Promise<{
    success: boolean;
    actionsExecuted?: {
      trades: number;
      posts: number;
      comments: number;
      messages: number;
      groupMessages: number;
      engagements: number;
    };
    trajectoryId?: string;
    error?: string;
  }>;
}

export interface ILLMCaller {
  callGroqDirect(params: {
    prompt: string;
    system: string;
    modelSize?: "small" | "medium" | "large";
    temperature?: number;
    maxTokens?: number;
    actionType?: string;
    responseFormat?: { type: "json_object" };
  }): Promise<string>;
}

export type ExportGroupedForGRPOFn = (options: {
  outputPath: string;
  minTrajectoriesPerGroup?: number;
  maxGroupSize?: number;
}) => Promise<{
  success: boolean;
  groupsExported: number;
  trajectoriesExported: number;
  outputPath: string;
  error?: string;
}>;

export type ExportToHuggingFaceFn = (options: {
  datasetName: string;
  trajectoryIds?: string[];
  format?: "parquet" | "jsonl";
}) => Promise<{ success: boolean; url?: string; error?: string }>;

export type ToTrainingMessagesFn = (
  trajectory: TrajectoryForTraining,
) => TrainingMessage[];

export interface TrajectoryForTraining {
  trajectoryId: string;
  agentId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  scenarioId?: string;
  steps: TrajectoryStepForTraining[];
  totalReward: number;
  rewardComponents: Record<string, number>;
  metrics: {
    episodeLength: number;
    finalStatus: string;
    finalPnL?: number;
  };
  metadata: {
    isTrainingData: boolean;
    [key: string]: JsonValue;
  };
}

export interface TrajectoryStepForTraining {
  stepId: string;
  stepNumber: number;
  timestamp: number;
  environmentState: Record<string, JsonValue> & {
    timestamp: number;
    agentPoints: number;
  };
  observation: Record<string, JsonValue>;
  providerAccesses: Array<{
    providerId: string;
    providerName: string;
    timestamp: number;
    query: Record<string, JsonValue>;
    data: Record<string, JsonValue>;
    purpose: string;
  }>;
  llmCalls: Array<{
    callId: string;
    timestamp: number;
    model: string;
    modelVersion?: string;
    systemPrompt: string;
    userPrompt: string;
    response: string;
    reasoning?: string;
    temperature: number;
    maxTokens: number;
    latencyMs?: number;
    purpose: "action" | "reasoning" | "evaluation" | "response" | "other";
    actionType?: string;
  }>;
  action: {
    attemptId: string;
    timestamp: number;
    actionType: string;
    actionName: string;
    parameters: Record<string, JsonValue>;
    reasoning?: string;
    success: boolean;
    result?: Record<string, JsonValue>;
    error?: string;
  };
  reward: number;
  done: boolean;
  metadata: Record<string, JsonValue>;
}

export interface TrainingMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

let agentService: IAgentService | null = null;
let agentRuntimeManager: IAgentRuntimeManager | null = null;
let autonomousCoordinator: IAutonomousCoordinator | null = null;
let llmCaller: ILLMCaller | null = null;
let exportGroupedForGRPO: ExportGroupedForGRPOFn | null = null;
let exportToHuggingFace: ExportToHuggingFaceFn | null = null;
let toTrainingMessages: ToTrainingMessagesFn | null = null;

export function configureTrainingDependencies(config: {
  agentService?: IAgentService;
  agentRuntimeManager?: IAgentRuntimeManager;
  autonomousCoordinator?: IAutonomousCoordinator;
  llmCaller?: ILLMCaller;
  exportGroupedForGRPO?: ExportGroupedForGRPOFn;
  exportToHuggingFace?: ExportToHuggingFaceFn;
  toTrainingMessages?: ToTrainingMessagesFn;
}): void {
  if (config.agentService) agentService = config.agentService;
  if (config.agentRuntimeManager) {
    agentRuntimeManager = config.agentRuntimeManager;
  }
  if (config.autonomousCoordinator) {
    autonomousCoordinator = config.autonomousCoordinator;
  }
  if (config.llmCaller) llmCaller = config.llmCaller;
  if (config.exportGroupedForGRPO) {
    exportGroupedForGRPO = config.exportGroupedForGRPO;
  }
  if (config.exportToHuggingFace) {
    exportToHuggingFace = config.exportToHuggingFace;
  }
  if (config.toTrainingMessages) {
    toTrainingMessages = config.toTrainingMessages;
  }
}

export function getAgentService(): IAgentService {
  if (!agentService) {
    throw new Error(
      "AgentService not configured. Call configureTrainingDependencies() first.",
    );
  }
  return agentService;
}

export function getAgentRuntimeManager(): IAgentRuntimeManager {
  if (!agentRuntimeManager) {
    throw new Error(
      "AgentRuntimeManager not configured. Call configureTrainingDependencies() first.",
    );
  }
  return agentRuntimeManager;
}

export function getAutonomousCoordinator(): IAutonomousCoordinator {
  if (!autonomousCoordinator) {
    throw new Error(
      "AutonomousCoordinator not configured. Call configureTrainingDependencies() first.",
    );
  }
  return autonomousCoordinator;
}

export function getLLMCaller(): ILLMCaller {
  if (!llmCaller) {
    throw new Error(
      "LLMCaller not configured. Call configureTrainingDependencies() first.",
    );
  }
  return llmCaller;
}

export function getExportGroupedForGRPO(): ExportGroupedForGRPOFn {
  if (!exportGroupedForGRPO) {
    throw new Error(
      "exportGroupedForGRPO not configured. Call configureTrainingDependencies() first.",
    );
  }
  return exportGroupedForGRPO;
}

export function getExportToHuggingFace(): ExportToHuggingFaceFn {
  if (!exportToHuggingFace) {
    throw new Error(
      "exportToHuggingFace not configured. Call configureTrainingDependencies() first.",
    );
  }
  return exportToHuggingFace;
}

export function getToTrainingMessages(): ToTrainingMessagesFn {
  if (!toTrainingMessages) {
    throw new Error(
      "toTrainingMessages not configured. Call configureTrainingDependencies() first.",
    );
  }
  return toTrainingMessages;
}

export function areDependenciesConfigured(): boolean {
  return (
    agentService !== null &&
    agentRuntimeManager !== null &&
    autonomousCoordinator !== null
  );
}

export function areAgentDependenciesConfigured(): boolean {
  return areDependenciesConfigured();
}
