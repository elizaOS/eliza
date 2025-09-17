// File: packages/cli/src/commands/scenario/src/conversation-types.ts
// TypeScript interfaces for dynamic prompting and conversation management

import { UUID } from '@elizaos/core';
import { ExecutionResult } from './providers';
import { TrajectoryStep } from './TrajectoryReconstructor';
import { EnhancedEvaluationResult } from './schema';

/**
 * Configuration for the user simulator component
 */
export interface UserSimulatorConfig {
  model_type: string;
  temperature: number;
  max_tokens: number;
  persona: string;
  objective: string;
  style?: string;
  constraints: string[];
  emotional_state?: string;
  knowledge_level: 'beginner' | 'intermediate' | 'expert';
}

/**
 * Conditions that can terminate a conversation early
 */
export interface TerminationCondition {
  type:
    | 'max_turns_reached'
    | 'user_expresses_satisfaction'
    | 'agent_provides_solution'
    | 'conversation_stuck'
    | 'escalation_needed'
    | 'goal_achieved'
    | 'custom_condition';
  description?: string;
  keywords?: string[];
  llm_judge?: {
    prompt: string;
    threshold: number;
  };
}

/**
 * Complete configuration for a conversation scenario
 */
export interface ConversationConfig {
  max_turns: number;
  timeout_per_turn_ms: number;
  total_timeout_ms: number;
  user_simulator: UserSimulatorConfig;
  termination_conditions: TerminationCondition[];
  turn_evaluations: any[]; // EvaluationSchema[]
  final_evaluations: any[]; // EvaluationSchema[]
  debug_options: {
    log_user_simulation: boolean;
    log_turn_decisions: boolean;
    export_full_transcript: boolean;
  };
}

/**
 * Single turn in a conversation with complete metadata
 */
export interface ConversationTurn {
  turnNumber: number;
  userInput: string;
  agentResponse: string;
  roomId: UUID;
  trajectory: TrajectoryStep[];
  duration: number;
  executionResult: ExecutionResult;
  turnEvaluations: EnhancedEvaluationResult[];
}

/**
 * Complete result of a conversation execution
 */
export interface ConversationResult {
  turns: ConversationTurn[];
  totalDuration: number;
  terminatedEarly: boolean;
  terminationReason: string | null;
  finalEvaluations: EnhancedEvaluationResult[];
  conversationTranscript: string;
  success: boolean;
}

/**
 * Context passed to user simulator for response generation
 */
export interface SimulationContext {
  turnNumber: number;
  maxTurns: number;
  debugOptions?: {
    log_user_simulation: boolean;
    log_turn_decisions: boolean;
  };
}

/**
 * Extended execution result with conversation metadata
 */
export interface ConversationExecutionResult extends ExecutionResult {
  conversationMetadata?: {
    turnCount: number;
    terminatedEarly: boolean;
    terminationReason: string | null;
    finalEvaluations: EnhancedEvaluationResult[];
  };
}

/**
 * Performance metrics specific to conversations
 */
export interface ConversationMetrics {
  totalDuration: number;
  turnCount: number;
  avgTurnDuration: number;
  llmCallsPerTurn: number;
  tokenUsage: {
    total: number;
    userSimulation: number;
    agentResponses: number;
    evaluations: number;
  };
}

/**
 * Pattern analysis result for conversation flow evaluation
 */
export interface ConversationPattern {
  pattern: string;
  detected: boolean;
  confidence: number;
  evidence: string[];
}

/**
 * Memory test result for context retention evaluation
 */
export interface MemoryTest {
  item: string;
  accuracy: number;
  mentionTurn: number;
  retentionTurns: number[];
}

/**
 * Satisfaction analysis result with breakdown
 */
export interface SatisfactionAnalysis {
  score: number;
  method: 'sentiment_analysis' | 'keyword_analysis' | 'llm_judge';
  positiveIndicators: string[];
  negativeIndicators: string[];
  reasoning: string;
}
