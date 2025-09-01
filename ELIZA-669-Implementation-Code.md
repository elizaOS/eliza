# ELIZA-669 Implementation Code

## 1. Schema Extensions

### File: `packages/cli/src/commands/scenario/src/schema.ts`

```typescript
import { z } from 'zod';

// NEW: Conversation configuration schema
const ConversationConfigSchema = z.object({
  max_turns: z.number().int().min(2).max(20),
  timeout_per_turn_ms: z.number().int().min(1000).optional().default(30000),
  total_timeout_ms: z.number().int().min(10000).optional().default(300000),
  
  user_simulator: z.object({
    model_type: z.string().optional().default('TEXT_LARGE'),
    temperature: z.number().min(0).max(2).optional().default(0.7),
    max_tokens: z.number().int().min(50).max(500).optional().default(200),
    persona: z.string(),
    objective: z.string(),
    style: z.string().optional(),
    constraints: z.array(z.string()).optional().default([]),
    emotional_state: z.string().optional(),
    knowledge_level: z.enum(['beginner', 'intermediate', 'expert']).optional().default('intermediate'),
  }),
  
  termination_conditions: z.array(z.object({
    type: z.enum([
      'max_turns_reached',
      'user_expresses_satisfaction', 
      'agent_provides_solution',
      'conversation_stuck',
      'escalation_needed',
      'goal_achieved',
      'custom_condition'
    ]),
    description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    llm_judge: z.object({
      prompt: z.string(),
      threshold: z.number().min(0).max(1).optional().default(0.8)
    }).optional()
  })).optional().default([]),
  
  turn_evaluations: z.array(EvaluationSchema).optional().default([]),
  final_evaluations: z.array(EvaluationSchema).optional().default([]),
  
  debug_options: z.object({
    log_user_simulation: z.boolean().optional().default(false),
    log_turn_decisions: z.boolean().optional().default(false),
    export_full_transcript: z.boolean().optional().default(true),
  }).optional().default({})
});

// NEW: Conversation-specific evaluation schemas
const ConversationLengthEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('conversation_length'),
  min_turns: z.number().int().min(1).optional(),
  max_turns: z.number().int().min(1).optional(),
  optimal_turns: z.number().int().min(1).optional(),
  target_range: z.array(z.number().int()).length(2).optional(),
});

const ConversationFlowEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('conversation_flow'),
  required_patterns: z.array(z.enum([
    'question_then_answer',
    'problem_then_solution', 
    'clarification_cycle',
    'empathy_then_solution',
    'escalation_pattern'
  ])),
  flow_quality_threshold: z.number().min(0).max(1).optional().default(0.7),
});

const UserSatisfactionEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('user_satisfaction'),
  satisfaction_threshold: z.number().min(0).max(1).optional().default(0.7),
  indicators: z.object({
    positive: z.array(z.string()).optional(),
    negative: z.array(z.string()).optional(),
  }).optional(),
  measurement_method: z.enum(['sentiment_analysis', 'keyword_analysis', 'llm_judge']).optional().default('llm_judge'),
});

const ContextRetentionEvaluationSchema = BaseEvaluationSchema.extend({
  type: z.literal('context_retention'),
  test_memory_of: z.array(z.string()),
  retention_turns: z.number().int().min(1).optional().default(3),
  memory_accuracy_threshold: z.number().min(0).max(1).optional().default(0.8),
});

// EXTEND existing RunStepSchema (backward compatible)
const RunStepSchema = z.object({
  name: z.string().optional(),
  lang: z.string().optional(), 
  code: z.string().optional(),
  input: z.string().optional(), // Natural language input to agent
  evaluations: z.array(EvaluationSchema),
  
  // NEW: Optional conversation configuration
  conversation: ConversationConfigSchema.optional(),
});

// UPDATE: Extend main EvaluationSchema with new types
export const EvaluationSchema = z.discriminatedUnion('type', [
  StringContainsEvaluationSchema,
  RegexMatchEvaluationSchema,
  FileExistsEvaluationSchema,
  TrajectoryContainsActionEvaluationSchema,
  LLMJudgeEvaluationSchema,
  ExecutionTimeEvaluationSchema,
  // NEW conversation evaluators
  ConversationLengthEvaluationSchema,
  ConversationFlowEvaluationSchema,
  UserSatisfactionEvaluationSchema,
  ContextRetentionEvaluationSchema,
]);
```

## 2. Type Definitions

### File: `packages/cli/src/commands/scenario/src/conversation-types.ts`

```typescript
import { UUID } from '@elizaos/core';
import { ExecutionResult } from './providers';
import { TrajectoryStep } from './TrajectoryReconstructor';
import { EvaluationResult } from './EvaluationEngine';

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

export interface TerminationCondition {
  type: 'max_turns_reached' | 'user_expresses_satisfaction' | 'agent_provides_solution' | 
        'conversation_stuck' | 'escalation_needed' | 'goal_achieved' | 'custom_condition';
  description?: string;
  keywords?: string[];
  llm_judge?: {
    prompt: string;
    threshold: number;
  };
}

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

export interface ConversationTurn {
  turnNumber: number;
  userInput: string;
  agentResponse: string;
  roomId: UUID;
  trajectory: TrajectoryStep[];
  duration: number;
  executionResult: ExecutionResult;
  turnEvaluations: EvaluationResult[];
}

export interface ConversationResult {
  turns: ConversationTurn[];
  totalDuration: number;
  terminatedEarly: boolean;
  terminationReason: string | null;
  finalEvaluations: EvaluationResult[];
  conversationTranscript: string;
  success: boolean;
}

export interface SimulationContext {
  turnNumber: number;
  maxTurns: number;
  debugOptions?: {
    log_user_simulation: boolean;
    log_turn_decisions: boolean;
  };
}
```

## 3. User Simulator Implementation

### File: `packages/cli/src/commands/scenario/src/UserSimulator.ts`

```typescript
import { AgentRuntime, ModelType } from '@elizaos/core';
import { ConversationTurn, SimulationContext, UserSimulatorConfig } from './conversation-types';

export class UserSimulator {
  private runtime: AgentRuntime;
  private config: UserSimulatorConfig;
  
  constructor(runtime: AgentRuntime, config: UserSimulatorConfig) {
    this.runtime = runtime;
    this.config = config;
  }

  async generateResponse(
    conversationHistory: ConversationTurn[],
    latestAgentResponse: string,
    context: SimulationContext
  ): Promise<string> {
    const prompt = this.buildSimulationPrompt(
      conversationHistory,
      latestAgentResponse, 
      context
    );

    const response = await this.runtime.useModel(
      ModelType.TEXT_LARGE,
      {
        messages: [{ role: 'user', content: prompt }],
        temperature: this.config.temperature,
        maxTokens: this.config.max_tokens,
      }
    );

    // Log simulation for debugging
    if (context.debugOptions?.log_user_simulation) {
      console.log(`👤 [UserSimulator] Generated response: "${response}"`);
      console.log(`👤 [UserSimulator] Context: Turn ${context.turnNumber}/${context.maxTurns}`);
    }

    return response;
  }

  private buildSimulationPrompt(
    history: ConversationTurn[],
    agentResponse: string,
    context: SimulationContext
  ): string {
    const { persona, objective, style, constraints, emotionalState, knowledgeLevel } = this.config;
    
    let prompt = `You are simulating a user in a conversation with an AI agent.

**Your Persona:** ${persona}
**Your Objective:** ${objective}
**Your Communication Style:** ${style || 'natural and conversational'}
**Your Knowledge Level:** ${knowledgeLevel}`;

    if (emotionalState) {
      prompt += `\n**Your Emotional State:** ${emotionalState}`;
    }

    if (constraints.length > 0) {
      prompt += `\n**Behavioral Constraints:**\n${constraints.map(c => `- ${c}`).join('\n')}`;
    }

    prompt += `\n\n**Conversation Context:**
- This is turn ${context.turnNumber} of a maximum ${context.maxTurns} turn conversation
- Your goal is to ${objective}`;

    if (history.length > 0) {
      prompt += `\n\n**Conversation History:**`;
      history.forEach((turn, i) => {
        prompt += `\n${i + 1}. User: ${turn.userInput}`;
        prompt += `\n${i + 1}. Agent: ${turn.agentResponse}`;
      });
    }

    prompt += `\n\n**Latest Agent Response:** ${agentResponse}

**Instructions:**
1. Respond as the user persona described above
2. Keep your response realistic and natural (50-200 words)
3. Stay true to your personality and objective
4. Consider your knowledge level when asking questions or providing information
5. Progress toward your objective while maintaining realistic conversation flow

**Your Response:**`;

    return prompt;
  }
}
```

## 4. Conversation Manager Implementation

### File: `packages/cli/src/commands/scenario/src/ConversationManager.ts`

```typescript
import { AgentRuntime, UUID } from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { askAgentViaApi } from './runtime-factory';
import { UserSimulator } from './UserSimulator';
import { EvaluationEngine } from './EvaluationEngine';
import {
  ConversationConfig,
  ConversationResult,
  ConversationTurn,
  TerminationCondition,
  SimulationContext
} from './conversation-types';
import { TrajectoryReconstructor } from './TrajectoryReconstructor';

export class ConversationManager {
  private runtime: AgentRuntime;
  private server: AgentServer;
  private agentId: UUID;
  private serverPort: number;
  private userSimulator: UserSimulator;
  private evaluationEngine: EvaluationEngine;
  private trajectoryReconstructor: TrajectoryReconstructor;

  constructor(
    runtime: AgentRuntime,
    server: AgentServer, 
    agentId: UUID,
    serverPort: number,
    trajectoryReconstructor: TrajectoryReconstructor
  ) {
    this.runtime = runtime;
    this.server = server;
    this.agentId = agentId;
    this.serverPort = serverPort;
    this.evaluationEngine = new EvaluationEngine(runtime);
    this.trajectoryReconstructor = trajectoryReconstructor;
  }

  async executeConversation(
    initialInput: string,
    config: ConversationConfig
  ): Promise<ConversationResult> {
    const startTime = Date.now();
    const turns: ConversationTurn[] = [];
    let currentInput = initialInput;
    
    // Initialize user simulator
    this.userSimulator = new UserSimulator(this.runtime, config.user_simulator);
    
    console.log(`🗣️  [ConversationManager] Starting conversation: max_turns=${config.max_turns}`);
    console.log(`🗣️  [ConversationManager] User persona: ${config.user_simulator.persona}`);
    
    try {
      for (let turnNumber = 1; turnNumber <= config.max_turns; turnNumber++) {
        console.log(`🗣️  [ConversationManager] === TURN ${turnNumber}/${config.max_turns} ===`);
        
        const turn = await this.executeTurn(
          currentInput,
          turnNumber,
          config,
          turns
        );
        
        turns.push(turn);

        // Run turn-level evaluations
        if (config.turn_evaluations?.length > 0) {
          const turnEvaluations = await this.evaluationEngine.runEvaluations(
            config.turn_evaluations,
            turn.executionResult
          );
          
          turn.turnEvaluations = turnEvaluations;
          
          if (config.debug_options?.log_turn_decisions) {
            console.log(`📊 [ConversationManager] Turn ${turnNumber} evaluations:`, 
              turnEvaluations.map(e => `${e.success ? '✅' : '❌'} ${e.message}`));
          }
        }

        // Check termination conditions
        if (await this.checkTerminationConditions(turns, config.termination_conditions)) {
          console.log(`🛑 [ConversationManager] Termination condition met at turn ${turnNumber}`);
          break;
        }

        // Generate next user input (if not last turn)
        if (turnNumber < config.max_turns) {
          const simulationContext: SimulationContext = {
            turnNumber: turnNumber + 1,
            maxTurns: config.max_turns,
            debugOptions: config.debug_options
          };

          currentInput = await this.userSimulator.generateResponse(
            turns,
            turn.agentResponse,
            simulationContext
          );

          console.log(`👤 [ConversationManager] User (simulated): "${currentInput}"`);
        }
      }

      const endTime = Date.now();
      const totalDuration = endTime - startTime;

      // Run final evaluations
      let finalEvaluations = [];
      if (config.final_evaluations?.length > 0) {
        // Create a combined execution result for final evaluations
        const combinedResult = this.createCombinedExecutionResult(turns, totalDuration);
        finalEvaluations = await this.evaluationEngine.runEvaluations(
          config.final_evaluations,
          combinedResult
        );
      }

      const result: ConversationResult = {
        turns,
        totalDuration,
        terminatedEarly: turns.length < config.max_turns,
        terminationReason: await this.getTerminationReason(turns, config.termination_conditions),
        finalEvaluations,
        conversationTranscript: this.generateTranscript(turns),
        success: this.determineOverallSuccess(turns, finalEvaluations)
      };

      console.log(`🎯 [ConversationManager] Conversation completed: ${turns.length} turns, success=${result.success}`);
      
      return result;

    } catch (error) {
      console.error(`💥 [ConversationManager] Conversation failed:`, error);
      throw new Error(`Conversation execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async executeTurn(
    userInput: string,
    turnNumber: number,
    config: ConversationConfig,
    previousTurns: ConversationTurn[]
  ): Promise<ConversationTurn> {
    const turnStartTime = Date.now();
    
    console.log(`👤 [ConversationManager] Turn ${turnNumber} Input: "${userInput}"`);

    // Use existing askAgentViaApi infrastructure
    const { response: agentResponse, roomId } = await askAgentViaApi(
      this.server,
      this.agentId,
      userInput,
      config.timeout_per_turn_ms,
      this.serverPort
    );

    console.log(`🤖 [ConversationManager] Turn ${turnNumber} Response: "${agentResponse}"`);

    // Give time for trajectory to be written to database
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Reconstruct trajectory for this turn
    const trajectory = await this.trajectoryReconstructor.getLatestTrajectory(roomId);

    const turnEndTime = Date.now();
    const turnDuration = turnEndTime - turnStartTime;

    // Create execution result for this turn (following existing pattern)
    const executionResult = {
      exitCode: 0,
      stdout: agentResponse,
      stderr: '',
      files: {}, // No file operations in conversation turns
      startedAtMs: turnStartTime,
      endedAtMs: turnEndTime,
      durationMs: turnDuration,
      trajectory
    };

    return {
      turnNumber,
      userInput,
      agentResponse,
      roomId,
      trajectory,
      duration: turnDuration,
      executionResult,
      turnEvaluations: [] // Will be populated later
    };
  }

  private async checkTerminationConditions(
    turns: ConversationTurn[],
    conditions: TerminationCondition[]
  ): Promise<boolean> {
    if (!conditions || conditions.length === 0) return false;

    for (const condition of conditions) {
      let shouldTerminate = false;

      switch (condition.type) {
        case 'user_expresses_satisfaction':
          shouldTerminate = await this.checkSatisfactionKeywords(turns, condition);
          break;
        case 'agent_provides_solution':
          shouldTerminate = await this.checkSolutionKeywords(turns, condition);
          break;
        case 'conversation_stuck':
          shouldTerminate = await this.checkConversationStuck(turns);
          break;
        case 'escalation_needed':
          shouldTerminate = await this.checkEscalationKeywords(turns, condition);
          break;
        case 'custom_condition':
          if (condition.llm_judge) {
            shouldTerminate = await this.checkLLMJudgeCondition(turns, condition);
          }
          break;
      }

      if (shouldTerminate) {
        console.log(`🛑 [ConversationManager] Termination condition met: ${condition.type}`);
        return true;
      }
    }

    return false;
  }

  private async checkSatisfactionKeywords(
    turns: ConversationTurn[],
    condition: TerminationCondition
  ): Promise<boolean> {
    const defaultKeywords = ['thank you', 'thanks', 'perfect', 'great', 'that works', 'solved', 'fixed'];
    const keywords = condition.keywords || defaultKeywords;
    
    const lastTurn = turns[turns.length - 1];
    const lastUserInput = turns.length > 1 ? turns[turns.length - 2]?.userInput || '' : '';
    const lastAgentResponse = lastTurn.agentResponse;
    
    const textToCheck = `${lastUserInput} ${lastAgentResponse}`.toLowerCase();
    
    return keywords.some(keyword => textToCheck.includes(keyword.toLowerCase()));
  }

  private async checkSolutionKeywords(
    turns: ConversationTurn[],
    condition: TerminationCondition  
  ): Promise<boolean> {
    const defaultKeywords = ['solution', 'try this', 'follow these steps', 'here\'s how', 'you can'];
    const keywords = condition.keywords || defaultKeywords;
    
    const lastTurn = turns[turns.length - 1];
    const agentResponse = lastTurn.agentResponse.toLowerCase();
    
    return keywords.some(keyword => agentResponse.includes(keyword.toLowerCase()));
  }

  private async checkConversationStuck(turns: ConversationTurn[]): Promise<boolean> {
    if (turns.length < 3) return false;
    
    // Check if last 2 agent responses are very similar (indicating repetition)
    const lastResponse = turns[turns.length - 1].agentResponse;
    const prevResponse = turns[turns.length - 2].agentResponse;
    
    // Simple similarity check - could be enhanced with more sophisticated NLP
    const similarity = this.calculateStringSimilarity(lastResponse, prevResponse);
    return similarity > 0.8;
  }

  private async checkEscalationKeywords(
    turns: ConversationTurn[],
    condition: TerminationCondition
  ): Promise<boolean> {
    const defaultKeywords = ['escalate', 'supervisor', 'manager', 'specialist', 'human agent'];
    const keywords = condition.keywords || defaultKeywords;
    
    const lastTurn = turns[turns.length - 1];
    const agentResponse = lastTurn.agentResponse.toLowerCase();
    
    return keywords.some(keyword => agentResponse.includes(keyword.toLowerCase()));
  }

  private async checkLLMJudgeCondition(
    turns: ConversationTurn[],
    condition: TerminationCondition
  ): Promise<boolean> {
    if (!condition.llm_judge) return false;
    
    const conversationText = this.generateTranscript(turns);
    const prompt = `${condition.llm_judge.prompt}\n\nConversation:\n${conversationText}\n\nShould this conversation be terminated? Respond with only 'yes' or 'no'.`;
    
    const response = await this.runtime.useModel(
      ModelType.TEXT_LARGE,
      {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }
    );
    
    return response.toLowerCase().includes('yes');
  }

  private calculateStringSimilarity(str1: string, str2: string): number {
    // Simple Jaccard similarity for words
    const words1 = new Set(str1.toLowerCase().split(/\s+/));
    const words2 = new Set(str2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  private createCombinedExecutionResult(turns: ConversationTurn[], totalDuration: number) {
    const combinedTrajectory = turns.flatMap(turn => turn.trajectory || []);
    const combinedOutput = turns.map((turn, i) => 
      `Turn ${i + 1}:\nUser: ${turn.userInput}\nAgent: ${turn.agentResponse}`
    ).join('\n\n');

    return {
      exitCode: 0,
      stdout: combinedOutput,
      stderr: '',
      files: {},
      startedAtMs: turns[0]?.executionResult?.startedAtMs || Date.now(),
      endedAtMs: Date.now(),
      durationMs: totalDuration,
      trajectory: combinedTrajectory
    };
  }

  private async getTerminationReason(
    turns: ConversationTurn[],
    conditions: TerminationCondition[]
  ): Promise<string | null> {
    if (turns.length === 0) return null;
    
    // Check which condition caused termination
    for (const condition of conditions) {
      if (await this.checkTerminationConditions([turns[turns.length - 1]], [condition])) {
        return condition.type;
      }
    }
    
    return 'max_turns_reached';
  }

  private generateTranscript(turns: ConversationTurn[]): string {
    return turns.map((turn, i) => 
      `Turn ${i + 1}:\nUser: ${turn.userInput}\nAgent: ${turn.agentResponse}\n`
    ).join('\n');
  }

  private determineOverallSuccess(
    turns: ConversationTurn[],
    finalEvaluations: any[]
  ): boolean {
    // Simple success criteria - can be made configurable
    const hasSuccessfulTurns = turns.some(turn => 
      turn.turnEvaluations?.every(eval => eval.success) !== false
    );
    
    const finalEvaluationsPass = finalEvaluations.length === 0 || 
      finalEvaluations.every(eval => eval.success);
    
    return hasSuccessfulTurns && finalEvaluationsPass;
  }
}
```

## 5. Configuration Examples

### Basic Multi-Turn Conversation

```yaml
name: "Basic Multi-Turn Support Test"
description: "Tests agent's ability to handle basic customer support conversation"

plugins:
  - "@elizaos/plugin-bootstrap"
  - "@elizaos/plugin-openai"

environment:
  type: local

run:
  - name: "Customer support conversation"
    input: "Hi, I need help with something"
    
    conversation:
      max_turns: 4
      user_simulator:
        persona: "polite customer with a billing question"
        objective: "find out why charged twice this month"
        temperature: 0.6
      
      final_evaluations:
        - type: "llm_judge"
          prompt: "Did the agent successfully help resolve the billing issue?"
          expected: "yes"

judgment:
  strategy: all_pass
```

### Advanced Persona-Driven Conversation

```yaml
name: "Complex Customer Persona Test"
description: "Tests agent handling of difficult customer personas"

run:
  - name: "Frustrated customer scenario"
    input: "This is ridiculous! Your product doesn't work!"
    
    conversation:
      max_turns: 6
      user_simulator:
        model_type: "TEXT_REASONING_LARGE"
        temperature: 0.8
        persona: "angry customer who had bad experience"
        objective: "vent frustration but eventually want help"
        style: "initially hostile, gradually becomes cooperative if handled well"
        constraints:
          - "Start with complaints and criticism"
          - "Don't accept first solution immediately"
          - "Become more cooperative if agent shows empathy"
          - "Provide specific details when asked properly"
      
      termination_conditions:
        - type: "user_expresses_satisfaction"
        - type: "agent_escalates_to_human"
        - type: "conversation_becomes_unproductive"
      
      turn_evaluations:
        - type: "llm_judge"
          prompt: "Did the agent respond appropriately to customer's emotional state?"
          expected: "yes"
        - type: "llm_judge"
          prompt: "Did the agent avoid being defensive or argumentative?"
          expected: "yes"
      
      final_evaluations:
        - type: "llm_judge"
          prompt: "Was the customer's frustration appropriately addressed?"
          expected: "yes"
          capabilities:
            - "Acknowledged customer's frustration with empathy"
            - "Asked clarifying questions to understand the issue"
            - "Provided actionable solutions"
            - "Maintained professional tone despite hostility"
            - "De-escalated the emotional tension"
        - type: "conversation_flow"
          required_patterns:
            - "empathy_then_solution"
            - "clarification_cycle"
        - type: "user_satisfaction"
          satisfaction_threshold: 0.6

judgment:
  strategy: all_pass
```




