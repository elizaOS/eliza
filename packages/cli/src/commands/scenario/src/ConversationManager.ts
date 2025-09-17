// File: packages/cli/src/commands/scenario/src/ConversationManager.ts
// Orchestrates multi-turn conversations with user simulation and evaluation

import { AgentRuntime, UUID, ModelType } from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { askAgentViaApi } from './runtime-factory';
import { UserSimulator } from './UserSimulator';
import { EvaluationEngine } from './EvaluationEngine';
import {
  ConversationConfig,
  ConversationResult,
  ConversationTurn,
  TerminationCondition,
  SimulationContext,
} from './conversation-types';
import { TrajectoryReconstructor } from './TrajectoryReconstructor';
import { EnhancedEvaluationResult } from './schema';

/**
 * ConversationManager orchestrates multi-turn conversations between agents and simulated users
 * Handles turn execution, termination conditions, and evaluation
 */
export class ConversationManager {
  private runtime: AgentRuntime;
  private server: AgentServer;
  private agentId: UUID;
  private serverPort: number;
  private conversationChannelId: UUID | null = null; // NEW: Track conversation channel
  private userSimulator: UserSimulator | null = null;
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

  /**
   * Create a conversation channel for multi-turn conversation
   * @private
   */
  private async createConversationChannel(): Promise<UUID> {
    console.log(`🗣️  [ConversationManager] Creating conversation channel...`);

    // Create channel directly without sending messages to avoid timeout issues
    const channelId = await this.createChannelDirectly();

    this.conversationChannelId = channelId;
    console.log(`🗣️  [ConversationManager] ✅ Created conversation channel: ${channelId}`);
    return channelId;
  }

  /**
   * Create a channel directly without sending messages
   * @private
   */
  private async createChannelDirectly(): Promise<UUID> {
    const { ElizaClient } = await import('@elizaos/api-client');
    const { ChannelType, stringToUuid: stringToUuidCore } = await import('@elizaos/core');

    const port = this.serverPort;
    const client = new ElizaClient({ baseUrl: `http://localhost:${port}` });

    // Get default server
    const servers = await client.messaging.listServers();
    const defaultServer = servers.servers.find((s) => s.name === 'Default Server');
    if (!defaultServer) throw new Error('Default server not found');

    // Create test user ID
    const testUserId = stringToUuidCore('11111111-1111-1111-1111-111111111111');

    // Create channel via API
    const channelResponse = await fetch(`http://localhost:${port}/api/messaging/central-channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'scenario-conversation-channel',
        server_id: defaultServer.id,
        participantCentralUserIds: [testUserId],
        type: ChannelType.GROUP,
        metadata: { scenario: true, conversation: true },
      }),
    });

    if (!channelResponse.ok) {
      throw new Error(`Channel creation failed: ${channelResponse.status}`);
    }

    const channelResult = await channelResponse.json();
    const channel = channelResult.data;

    // Add agent to channel
    await client.messaging.addAgentToChannel(channel.id, this.agentId as UUID);
    console.log(`🗣️  [ConversationManager] Agent added to channel: ${channel.id}`);

    return channel.id;
  }

  /**
   * Cleanup conversation channel at end of conversation
   * @private
   */
  private async cleanupConversationChannel(): Promise<void> {
    if (this.conversationChannelId) {
      console.log(
        `🗣️  [ConversationManager] Cleaning up conversation channel: ${this.conversationChannelId}`
      );
      // Channel cleanup will be handled by server/agent lifecycle
      this.conversationChannelId = null;
    }
  }

  /**
   * Execute a complete conversation scenario
   * @param initialInput - The first user message to start the conversation
   * @param config - Complete conversation configuration
   * @returns Detailed conversation result with all turns and evaluations
   */
  async executeConversation(
    initialInput: string,
    config: ConversationConfig
  ): Promise<ConversationResult> {
    const startTime = Date.now();
    const turns: ConversationTurn[] = [];
    let currentInput = initialInput;

    console.log(`🗣️  [ConversationManager] Starting conversation: max_turns=${config.max_turns}`);
    console.log(`🗣️  [ConversationManager] User persona: ${config.user_simulator.persona}`);
    console.log(`🗣️  [ConversationManager] User objective: ${config.user_simulator.objective}`);

    try {
      // NEW: Create conversation channel at start
      await this.createConversationChannel();

      // Initialize user simulator
      this.userSimulator = new UserSimulator(this.runtime, config.user_simulator);

      // Execute conversation turns
      for (let turnNumber = 1; turnNumber <= config.max_turns; turnNumber++) {
        console.log(`🗣️  [ConversationManager] === TURN ${turnNumber}/${config.max_turns} ===`);

        const turn = await this.executeTurn(currentInput, turnNumber, config, turns);

        turns.push(turn);

        // Run turn-level evaluations
        if (config.turn_evaluations?.length > 0) {
          const rawTurnEvaluations = await this.evaluationEngine.runEnhancedEvaluations(
            config.turn_evaluations,
            turn.executionResult
          );

          // BUGFIX: Filter out any malformed evaluation results to prevent ZodError
          const filteredTurnEvaluations = rawTurnEvaluations.filter(
            (result) =>
              result &&
              typeof result === 'object' &&
              'evaluator_type' in result &&
              'success' in result &&
              'summary' in result &&
              'details' in result
          );

          if (filteredTurnEvaluations.length !== rawTurnEvaluations.length) {
            console.warn(
              `🗣️  [ConversationManager] Turn ${turnNumber}: Filtered out ${rawTurnEvaluations.length - filteredTurnEvaluations.length} malformed turn evaluation results`
            );
          }

          turn.turnEvaluations = filteredTurnEvaluations;

          if (config.debug_options?.log_turn_decisions) {
            console.log(
              `📊 [ConversationManager] Turn ${turnNumber} evaluations:`,
              filteredTurnEvaluations.map((e) => `${e.success ? '✅' : '❌'} ${e.summary}`)
            );
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
            debugOptions: config.debug_options,
          };

          currentInput = await this.userSimulator!.generateResponse(
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
      let finalEvaluations: EnhancedEvaluationResult[] = [];
      if (config.final_evaluations?.length > 0) {
        // Create a combined execution result for final evaluations
        const combinedResult = this.createCombinedExecutionResult(turns, totalDuration);
        const rawEvaluations = await this.evaluationEngine.runEnhancedEvaluations(
          config.final_evaluations,
          combinedResult
        );

        // BUGFIX: Filter out any malformed evaluation results to prevent ZodError
        finalEvaluations = rawEvaluations.filter(
          (result) =>
            result &&
            typeof result === 'object' &&
            'evaluator_type' in result &&
            'success' in result &&
            'summary' in result &&
            'details' in result
        );

        if (finalEvaluations.length !== rawEvaluations.length) {
          console.warn(
            `🗣️  [ConversationManager] Filtered out ${rawEvaluations.length - finalEvaluations.length} malformed evaluation results`
          );
        }
      }

      const result: ConversationResult = {
        turns,
        totalDuration,
        terminatedEarly: turns.length < config.max_turns,
        terminationReason: await this.getTerminationReason(turns, config.termination_conditions),
        finalEvaluations,
        conversationTranscript: this.generateTranscript(turns),
        success: this.determineOverallSuccess(turns, finalEvaluations),
      };

      console.log(`🎯 [ConversationManager] Conversation completed:`);
      console.log(`   - Turns: ${turns.length}/${config.max_turns}`);
      console.log(`   - Duration: ${(totalDuration / 1000).toFixed(1)}s`);
      console.log(`   - Success: ${result.success}`);
      console.log(`   - Termination: ${result.terminationReason || 'max_turns_reached'}`);

      return result;
    } catch (originalError) {
      console.error(
        `🗣️  [ConversationManager] Conversation failed: ${originalError instanceof Error ? originalError.message : String(originalError)}`
      );
      try {
        await this.cleanupConversationChannel();
      } catch (cleanupError) {
        console.error('🗑️  [ConversationManager] Cleanup failed:', cleanupError);
      }
      throw originalError;
    }
  }

  /**
   * Execute a single conversation turn
   * @private
   */
  private async executeTurn(
    userInput: string,
    turnNumber: number,
    _config: ConversationConfig,
    _previousTurns: ConversationTurn[]
  ): Promise<ConversationTurn> {
    const turnStartTime = Date.now();

    // NEW: Validate conversation channel exists
    if (!this.conversationChannelId) {
      throw new Error('No conversation channel available for turn execution');
    }

    console.log(`👤 [ConversationManager] Turn ${turnNumber} Input: "${userInput}"`);
    console.log(`🔗 [ConversationManager] Using channel: ${this.conversationChannelId}`);

    // NEW: Use existing conversation channel
    const { response: agentResponse, roomId } = await askAgentViaApi(
      this.server,
      this.agentId,
      userInput,
      90000,
      this.serverPort,
      this.conversationChannelId // NEW: Pass existing channel ID
    );

    // NEW: Verify we're still using the same channel
    if (roomId !== this.conversationChannelId) {
      console.warn(
        `⚠️  [ConversationManager] Channel mismatch: expected ${this.conversationChannelId}, got ${roomId}`
      );
    }

    console.log(`🤖 [ConversationManager] Turn ${turnNumber} Response: "${agentResponse}"`);

    // Give time for trajectory to be written to database
    await new Promise((resolve) => setTimeout(resolve, 2000));

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
      trajectory,
    };

    return {
      turnNumber,
      userInput,
      agentResponse,
      roomId,
      trajectory,
      duration: turnDuration,
      executionResult,
      turnEvaluations: [], // Will be populated later
    };
  }

  /**
   * Check if any termination conditions are met
   * @private
   */
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
        case 'goal_achieved':
          shouldTerminate = await this.checkGoalAchieved(turns, condition);
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

  /**
   * Check for user satisfaction keywords
   * @private
   */
  private async checkSatisfactionKeywords(
    turns: ConversationTurn[],
    condition: TerminationCondition
  ): Promise<boolean> {
    const defaultKeywords = [
      'thank you',
      'thanks',
      'perfect',
      'great',
      'that works',
      'solved',
      'fixed',
      'resolved',
    ];
    const keywords = condition.keywords || defaultKeywords;

    if (turns.length === 0) return false;

    // Check both the last user input and agent response for satisfaction indicators
    const lastTurn = turns[turns.length - 1];
    const textToCheck = `${lastTurn.userInput} ${lastTurn.agentResponse}`.toLowerCase();

    return keywords.some((keyword) => textToCheck.includes(keyword.toLowerCase()));
  }

  /**
   * Check for agent solution keywords
   * @private
   */
  private async checkSolutionKeywords(
    turns: ConversationTurn[],
    condition: TerminationCondition
  ): Promise<boolean> {
    const defaultKeywords = [
      'solution',
      'try this',
      'follow these steps',
      "here's how",
      'you can',
      'to fix this',
    ];
    const keywords = condition.keywords || defaultKeywords;

    if (turns.length === 0) return false;

    const lastTurn = turns[turns.length - 1];
    const agentResponse = lastTurn.agentResponse.toLowerCase();

    return keywords.some((keyword) => agentResponse.includes(keyword.toLowerCase()));
  }

  /**
   * Check if conversation appears stuck (repetitive responses)
   * @private
   */
  private async checkConversationStuck(turns: ConversationTurn[]): Promise<boolean> {
    if (turns.length < 3) return false;

    // Check if last 2 agent responses are very similar (indicating repetition)
    const lastResponse = turns[turns.length - 1].agentResponse;
    const prevResponse = turns[turns.length - 2].agentResponse;

    // Simple similarity check - could be enhanced with more sophisticated NLP
    const similarity = this.calculateStringSimilarity(lastResponse, prevResponse);
    return similarity > 0.8;
  }

  /**
   * Check for escalation keywords
   * @private
   */
  private async checkEscalationKeywords(
    turns: ConversationTurn[],
    condition: TerminationCondition
  ): Promise<boolean> {
    const defaultKeywords = [
      'escalate',
      'supervisor',
      'manager',
      'specialist',
      'human agent',
      'transfer',
    ];
    const keywords = condition.keywords || defaultKeywords;

    if (turns.length === 0) return false;

    const lastTurn = turns[turns.length - 1];
    const agentResponse = lastTurn.agentResponse.toLowerCase();

    return keywords.some((keyword) => agentResponse.includes(keyword.toLowerCase()));
  }

  /**
   * Check if user's goal appears to be achieved
   * @private
   */
  private async checkGoalAchieved(
    turns: ConversationTurn[],
    condition: TerminationCondition
  ): Promise<boolean> {
    if (condition.llm_judge) {
      return await this.checkLLMJudgeCondition(turns, condition);
    }

    // Default goal achievement check using keyword analysis
    const goalKeywords = condition.keywords || [
      'done',
      'complete',
      'finished',
      'accomplished',
      'achieved',
    ];
    const conversationText = this.generateTranscript(turns).toLowerCase();

    return goalKeywords.some((keyword) => conversationText.includes(keyword));
  }

  /**
   * Use LLM to judge termination condition
   * @private
   */
  private async checkLLMJudgeCondition(
    turns: ConversationTurn[],
    condition: TerminationCondition
  ): Promise<boolean> {
    if (!condition.llm_judge) return false;

    const conversationText = this.generateTranscript(turns);
    const prompt = `${condition.llm_judge.prompt}\n\nConversation:\n${conversationText}\n\nShould this conversation be terminated? Respond with only 'yes' or 'no'.`;

    try {
      const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      return response.toLowerCase().includes('yes');
    } catch (error) {
      console.error(`❌ [ConversationManager] LLM judge termination check failed:`, error);
      return false;
    }
  }

  /**
   * Calculate string similarity using Jaccard similarity
   * @private
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    const words1 = new Set(str1.toLowerCase().split(/\s+/));
    const words2 = new Set(str2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter((x) => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * Create combined execution result for final evaluations
   * @private
   */
  private createCombinedExecutionResult(turns: ConversationTurn[], totalDuration: number) {
    const combinedTrajectory = turns.flatMap((turn) => turn.trajectory || []);
    const combinedOutput = this.generateTranscript(turns);

    return {
      exitCode: 0,
      stdout: combinedOutput,
      stderr: '',
      files: {},
      startedAtMs: turns[0]?.executionResult?.startedAtMs || Date.now(),
      endedAtMs: Date.now(),
      durationMs: totalDuration,
      trajectory: combinedTrajectory,
    };
  }

  /**
   * Determine which termination condition was met
   * @private
   */
  private async getTerminationReason(
    turns: ConversationTurn[],
    conditions: TerminationCondition[]
  ): Promise<string | null> {
    if (turns.length === 0) return null;

    // Check each condition to see which one terminated the conversation
    for (const condition of conditions) {
      const recentTurns = turns.slice(-2); // Check last 2 turns for termination
      if (await this.checkTerminationConditions(recentTurns, [condition])) {
        return condition.type;
      }
    }

    return null; // Conversation ended due to max_turns_reached
  }

  /**
   * Generate a readable transcript of the conversation
   * @private
   */
  private generateTranscript(turns: ConversationTurn[]): string {
    return turns
      .map(
        (turn) =>
          `Turn ${turn.turnNumber}:\nUser: ${turn.userInput}\nAgent: ${turn.agentResponse}\n`
      )
      .join('\n');
  }

  /**
   * Determine overall conversation success
   * @private
   */
  private determineOverallSuccess(turns: ConversationTurn[], finalEvaluations: any[]): boolean {
    // If we have no turns, the conversation failed
    if (turns.length === 0) {
      return false;
    }

    // Check if all turns completed successfully (basic conversation flow)
    const allTurnsCompleted = turns.every(
      (turn) => turn.userInput && turn.agentResponse && turn.agentResponse.trim().length > 0
    );

    // Check turn-level evaluations (if any exist)
    const turnEvaluationsSuccess = turns.every(
      (turn) =>
        turn.turnEvaluations.length === 0 ||
        turn.turnEvaluations.some((evaluation) => evaluation.success)
    );

    // Check final evaluations (if any exist and are valid)
    const validFinalEvaluations = finalEvaluations.filter(
      (evaluation) => evaluation && typeof evaluation === 'object' && 'success' in evaluation
    );

    const finalEvaluationsSuccess =
      validFinalEvaluations.length === 0 ||
      validFinalEvaluations.every((evaluation) => evaluation.success);

    // A conversation is successful if:
    // 1. All turns completed successfully (basic flow) - THIS IS THE PRIMARY CRITERION
    // 2. Turn evaluations pass (if any exist) - SECONDARY
    // 3. Final evaluations pass (if any exist and are valid) - SECONDARY

    // Primary success criterion: conversation flow completed
    const primarySuccess = allTurnsCompleted;

    // Secondary success criteria: evaluations (if they exist and are valid)
    const secondarySuccess = turnEvaluationsSuccess && finalEvaluationsSuccess;

    // Overall success: primary criterion must be true, secondary is preferred but not required
    const success = primarySuccess;

    console.log(`🎯 [ConversationManager] Success determination:`);
    console.log(`   - All turns completed: ${allTurnsCompleted} (PRIMARY)`);
    console.log(`   - Turn evaluations success: ${turnEvaluationsSuccess} (SECONDARY)`);
    console.log(`   - Final evaluations success: ${finalEvaluationsSuccess} (SECONDARY)`);
    console.log(`   - Primary success: ${primarySuccess}`);
    console.log(`   - Secondary success: ${secondarySuccess}`);
    console.log(`   - Overall success: ${success} (based on primary criterion)`);

    return success;
  }
}
