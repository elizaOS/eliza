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
    SimulationContext
} from './conversation-types';
import { TrajectoryReconstructor } from './TrajectoryReconstructor';

/**
 * ConversationManager orchestrates multi-turn conversations between agents and simulated users
 * Handles turn execution, termination conditions, and evaluation
 */
export class ConversationManager {
    private runtime: AgentRuntime;
    private server: AgentServer;
    private agentId: UUID;
    private serverPort: number;
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

        // Initialize user simulator
        this.userSimulator = new UserSimulator(this.runtime, config.user_simulator);

        console.log(`🗣️  [ConversationManager] Starting conversation: max_turns=${config.max_turns}`);
        console.log(`🗣️  [ConversationManager] User persona: ${config.user_simulator.persona}`);
        console.log(`🗣️  [ConversationManager] User objective: ${config.user_simulator.objective}`);

        try {
            // Execute conversation turns
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

            console.log(`🎯 [ConversationManager] Conversation completed:`);
            console.log(`   - Turns: ${turns.length}/${config.max_turns}`);
            console.log(`   - Duration: ${(totalDuration / 1000).toFixed(1)}s`);
            console.log(`   - Success: ${result.success}`);
            console.log(`   - Termination: ${result.terminationReason || 'max_turns_reached'}`);

            return result;

        } catch (error) {
            console.error(`💥 [ConversationManager] Conversation failed:`, error);
            throw new Error(`Conversation execution failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Execute a single conversation turn
     * @private
     */
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
        const defaultKeywords = ['thank you', 'thanks', 'perfect', 'great', 'that works', 'solved', 'fixed', 'resolved'];
        const keywords = condition.keywords || defaultKeywords;

        if (turns.length === 0) return false;

        // Check both the last user input and agent response for satisfaction indicators
        const lastTurn = turns[turns.length - 1];
        const textToCheck = `${lastTurn.userInput} ${lastTurn.agentResponse}`.toLowerCase();

        return keywords.some(keyword => textToCheck.includes(keyword.toLowerCase()));
    }

    /**
     * Check for agent solution keywords
     * @private
     */
    private async checkSolutionKeywords(
        turns: ConversationTurn[],
        condition: TerminationCondition
    ): Promise<boolean> {
        const defaultKeywords = ['solution', 'try this', 'follow these steps', 'here\'s how', 'you can', 'to fix this'];
        const keywords = condition.keywords || defaultKeywords;

        if (turns.length === 0) return false;

        const lastTurn = turns[turns.length - 1];
        const agentResponse = lastTurn.agentResponse.toLowerCase();

        return keywords.some(keyword => agentResponse.includes(keyword.toLowerCase()));
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
        const defaultKeywords = ['escalate', 'supervisor', 'manager', 'specialist', 'human agent', 'transfer'];
        const keywords = condition.keywords || defaultKeywords;

        if (turns.length === 0) return false;

        const lastTurn = turns[turns.length - 1];
        const agentResponse = lastTurn.agentResponse.toLowerCase();

        return keywords.some(keyword => agentResponse.includes(keyword.toLowerCase()));
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
        const goalKeywords = condition.keywords || ['done', 'complete', 'finished', 'accomplished', 'achieved'];
        const conversationText = this.generateTranscript(turns).toLowerCase();

        return goalKeywords.some(keyword => conversationText.includes(keyword));
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
            const response = await this.runtime.useModel(
                ModelType.TEXT_LARGE,
                {
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1,
                }
            );

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

        const intersection = new Set([...words1].filter(x => words2.has(x)));
        const union = new Set([...words1, ...words2]);

        return union.size === 0 ? 0 : intersection.size / union.size;
    }

    /**
     * Create combined execution result for final evaluations
     * @private
     */
    private createCombinedExecutionResult(turns: ConversationTurn[], totalDuration: number) {
        const combinedTrajectory = turns.flatMap(turn => turn.trajectory || []);
        const combinedOutput = this.generateTranscript(turns);

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
        return turns.map((turn) =>
            `Turn ${turn.turnNumber}:\nUser: ${turn.userInput}\nAgent: ${turn.agentResponse}\n`
        ).join('\n');
    }

    /**
     * Determine overall conversation success
     * @private
     */
    private determineOverallSuccess(
        turns: ConversationTurn[],
        finalEvaluations: any[]
    ): boolean {
        // Check turn-level evaluations
        const turnEvaluationsSuccess = turns.every(turn =>
            turn.turnEvaluations.length === 0 || turn.turnEvaluations.some(evaluation => evaluation.success)
        );

        // Check final evaluations
        const finalEvaluationsSuccess = finalEvaluations.length === 0 ||
            finalEvaluations.every(evaluation => evaluation.success);

        return turnEvaluationsSuccess && finalEvaluationsSuccess;
    }
}
