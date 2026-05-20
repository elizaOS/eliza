/**
 * External Dependencies for Training Package
 *
 * Defines interfaces for external dependencies that must be provided
 * by the consuming application (e.g., apps/web). The training package
 * is decoupled from specific implementations to maintain clean
 * package boundaries.
 *
 * Usage:
 * ```typescript
 * import { configureTrainingDependencies } from '@feed/training';
 *
 * configureTrainingDependencies({
 *   agentService,
 *   agentRuntimeManager,
 *   autonomousCoordinator,
 *   llmCaller,
 * });
 * ```
 *
 * @packageDocumentation
 */

import type { User } from '@feed/db';
import type { JsonValue } from '@feed/shared';
import type { IAgentRuntime } from '@elizaos/core';

/**
 * Parameters for creating an agent
 */
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
  modelTier?: 'lite' | 'standard' | 'pro';
}

/**
 * Interface for agent creation service
 */
export interface IAgentService {
  createAgent(params: CreateAgentParams): Promise<User>;
}

/**
 * Interface for managing agent runtimes
 */
export interface IAgentRuntimeManager {
  getRuntime(agentId: string): Promise<IAgentRuntime>;
  resetRuntime(agentId: string): Promise<void>;
}

/**
 * Interface for LLM calling functionality
 */
export interface ILLMCaller {
  callGroqDirect(params: {
    prompt: string;
    system: string;
    modelSize?: 'small' | 'medium' | 'large';
    temperature?: number;
    maxTokens?: number;
    actionType?: string;
    responseFormat?: { type: 'json_object' };
  }): Promise<string>;
}

/**
 * Export function type for trajectory data
 */
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

/**
 * Export function type for HuggingFace
 */
export type ExportToHuggingFaceFn = (options: {
  datasetName: string;
  trajectoryIds?: string[];
  format?: 'parquet' | 'jsonl';
}) => Promise<{ success: boolean; url?: string; error?: string }>;

/**
 * Convert trajectory to training format messages
 */
export type ToTrainingMessagesFn = (
  trajectory: TrajectoryForTraining
) => TrainingMessage[];

/**
 * Rich trajectory type for training and RLAIF scoring
 */
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
    purpose: 'action' | 'reasoning' | 'evaluation' | 'response' | 'other';
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
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Global configuration for external dependencies
 * This should be initialized before using the training package
 */
let _agentService: IAgentService | null = null;
let _agentRuntimeManager: IAgentRuntimeManager | null = null;
let _autonomousCoordinator: IAutonomousCoordinator | null = null;
let _llmCaller: ILLMCaller | null = null;
let _exportGroupedForGRPO: ExportGroupedForGRPOFn | null = null;
let _exportToHuggingFace: ExportToHuggingFaceFn | null = null;
let _toTrainingMessages: ToTrainingMessagesFn | null = null;

/**
 * Configure external dependencies
 */
export function configureTrainingDependencies(config: {
  agentService?: IAgentService;
  agentRuntimeManager?: IAgentRuntimeManager;
  autonomousCoordinator?: IAutonomousCoordinator;
  llmCaller?: ILLMCaller;
  exportGroupedForGRPO?: ExportGroupedForGRPOFn;
  exportToHuggingFace?: ExportToHuggingFaceFn;
  toTrainingMessages?: ToTrainingMessagesFn;
}): void {
  if (config.agentService) {
    _agentService = config.agentService;
  }
  if (config.agentRuntimeManager) {
    _agentRuntimeManager = config.agentRuntimeManager;
  }
  if (config.autonomousCoordinator) {
    _autonomousCoordinator = config.autonomousCoordinator;
  }
  if (config.llmCaller) {
    _llmCaller = config.llmCaller;
  }
  if (config.exportGroupedForGRPO) {
    _exportGroupedForGRPO = config.exportGroupedForGRPO;
  }
  if (config.exportToHuggingFace) {
    _exportToHuggingFace = config.exportToHuggingFace;
  }
  if (config.toTrainingMessages) {
    _toTrainingMessages = config.toTrainingMessages;
  }
}

/**
 * Get the agent service
 * @throws Error if not configured
 */
export function getAgentService(): IAgentService {
  if (!_agentService) {
    throw new Error(
      'AgentService not configured. Call configureTrainingDependencies() first.'
    );
  }
  return _agentService;
}

/**
 * Get the agent runtime manager
 * @throws Error if not configured
 */
export function getAgentRuntimeManager(): IAgentRuntimeManager {
  if (!_agentRuntimeManager) {
    throw new Error(
      'AgentRuntimeManager not configured. Call configureTrainingDependencies() first.'
    );
  }
  return _agentRuntimeManager;
}

/**
 * Get the autonomous coordinator
 * @throws Error if not configured
 */
export function getAutonomousCoordinator(): IAutonomousCoordinator {
  if (!_autonomousCoordinator) {
    throw new Error(
      'AutonomousCoordinator not configured. Call configureTrainingDependencies() first.'
    );
  }
  return _autonomousCoordinator;
}

/**
 * Get the LLM caller
 * @throws Error if not configured
 */
export function getLLMCaller(): ILLMCaller {
  if (!_llmCaller) {
    throw new Error(
      'LLMCaller not configured. Call configureTrainingDependencies() first.'
    );
  }
  return _llmCaller;
}

/**
 * Get the export function for GRPO
 * @throws Error if not configured
 */
export function getExportGroupedForGRPO(): ExportGroupedForGRPOFn {
  if (!_exportGroupedForGRPO) {
    throw new Error(
      'exportGroupedForGRPO not configured. Call configureTrainingDependencies() first.'
    );
  }
  return _exportGroupedForGRPO;
}

/**
 * Get the export function for HuggingFace
 * @throws Error if not configured
 */
export function getExportToHuggingFace(): ExportToHuggingFaceFn {
  if (!_exportToHuggingFace) {
    throw new Error(
      'exportToHuggingFace not configured. Call configureTrainingDependencies() first.'
    );
  }
  return _exportToHuggingFace;
}

/**
 * Get the toTrainingMessages function
 * @throws Error if not configured
 */
export function getToTrainingMessages(): ToTrainingMessagesFn {
  if (!_toTrainingMessages) {
    throw new Error(
      'toTrainingMessages not configured. Call configureTrainingDependencies() first.'
    );
  }
  return _toTrainingMessages;
}
/**
 * Check if dependencies are configured
 */
export function areDependenciesConfigured(): boolean {
  return (
    _agentService !== null &&
    _agentRuntimeManager !== null &&
    _autonomousCoordinator !== null
  );
}

/**
 * Check if specific agent dependencies are configured for parallel generation
 */
export function areAgentDependenciesConfigured(): boolean {
  return (
    _agentService !== null &&
    _agentRuntimeManager !== null &&
    _autonomousCoordinator !== null
  );
}

/**
 * Interface for autonomous tick execution
 */
export interface IAutonomousCoordinator {
  executeAutonomousTick(
    agentUserId: string,
    agentRuntime: IAgentRuntime,
    recordTrajectories?: boolean
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
