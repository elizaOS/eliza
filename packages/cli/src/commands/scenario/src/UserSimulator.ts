// File: packages/cli/src/commands/scenario/src/UserSimulator.ts
// User simulator for generating realistic user responses in multi-turn conversations

import { AgentRuntime, ModelType } from '@elizaos/core';
import { ConversationTurn, SimulationContext, UserSimulatorConfig } from './conversation-types';

/**
 * UserSimulator generates realistic user responses based on persona and objectives
 * Uses LLM to simulate believable user behavior in conversations
 */
export class UserSimulator {
  private runtime: AgentRuntime;
  private config: UserSimulatorConfig;

  constructor(runtime: AgentRuntime, config: UserSimulatorConfig) {
    this.runtime = runtime;
    this.config = config;
  }

  /**
   * Generate a user response based on conversation history and agent's latest response
   * @param conversationHistory - Previous turns in the conversation
   * @param latestAgentResponse - The agent's most recent response
   * @param context - Current simulation context (turn number, debug options, etc.)
   * @returns Simulated user response
   */
  async generateResponse(
    conversationHistory: ConversationTurn[],
    latestAgentResponse: string,
    context: SimulationContext
  ): Promise<string> {
    const prompt = this.buildSimulationPrompt(conversationHistory, latestAgentResponse, context);

    try {
      console.log(
        `👤 [UserSimulator] Calling LLM with model: ${this.config.model_type || ModelType.TEXT_LARGE}`
      );
      console.log(`👤 [UserSimulator] Prompt length: ${prompt.length}`);
      console.log(`👤 [UserSimulator] Prompt preview: ${prompt.substring(0, 200)}...`);

      const response = await this.runtime.useModel(this.config.model_type || ModelType.TEXT_LARGE, {
        prompt: prompt,
        temperature: this.config.temperature || 0.8,
      });

      console.log(`👤 [UserSimulator] Raw LLM response: "${response}"`);
      console.log(`👤 [UserSimulator] Response type: ${typeof response}`);
      console.log(`👤 [UserSimulator] Response length: ${response?.length || 0}`);

      // Log simulation for debugging
      if (context.debugOptions?.log_user_simulation) {
        console.log(`👤 [UserSimulator] Generated response: "${response}"`);
        console.log(`👤 [UserSimulator] Context: Turn ${context.turnNumber}/${context.maxTurns}`);
        console.log(`👤 [UserSimulator] Persona: ${this.config.persona}`);
      }

      // Clean up the response (remove any meta-commentary)
      const cleanedResponse = this.cleanResponse(response);
      console.log(`👤 [UserSimulator] Cleaned response: "${cleanedResponse}"`);

      // Ensure we never return an empty string
      if (!cleanedResponse || cleanedResponse.trim() === '') {
        console.log(`👤 [UserSimulator] ⚠️ Empty response detected, using fallback`);
        return this.generateFallbackResponse(latestAgentResponse, context);
      }

      return cleanedResponse;
    } catch (error) {
      console.error(`❌ [UserSimulator] Failed to generate response:`, error);
      console.error(`❌ [UserSimulator] Error details:`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        promptLength: prompt.length,
        modelType: this.config.model_type || 'TEXT_LARGE',
        temperature: this.config.temperature || 0.8,
        maxTokens: this.config.max_tokens || 200,
      });
      // Fallback to a simple response based on persona
      return this.generateFallbackResponse(latestAgentResponse, context);
    }
  }

  /**
   * Build the LLM prompt for user simulation
   * @private
   */
  private buildSimulationPrompt(
    history: ConversationTurn[],
    agentResponse: string,
    _context: SimulationContext
  ): string {
    const { persona, objective, style, constraints, emotional_state, knowledge_level } =
      this.config;

    // Simplified prompt structure to avoid LLM confusion
    let prompt = `Roleplay as a user with this profile:
Persona: ${persona}
Goal: ${objective}
Style: ${style || 'natural'}
Knowledge: ${knowledge_level}`;

    if (emotional_state) {
      prompt += `\nMood: ${emotional_state}`;
    }

    if (constraints.length > 0) {
      prompt += `\nConstraints: ${constraints.join(', ')}`;
    }

    // Add recent conversation context (limit to 2 turns to reduce complexity)
    const recentHistory = history.slice(-2);
    if (recentHistory.length > 0) {
      prompt += `\n\nRecent conversation:`;
      recentHistory.forEach((turn, i) => {
        const turnNum = history.length - recentHistory.length + i + 1;
        prompt += `\nTurn ${turnNum}: User: "${turn.userInput}" Agent: "${turn.agentResponse}"`;
      });
    }

    prompt += `\n\nAgent just said: "${agentResponse}"

Respond as the user (20-100 words, natural conversation):`;

    return prompt;
  }

  /**
   * Clean up the LLM response to remove any meta-commentary or formatting
   * @private
   */
  private cleanResponse(response: string): string {
    // Remove common meta-commentary patterns
    let cleaned = response.trim();

    // Remove "As a [persona]..." prefixes
    cleaned = cleaned.replace(/^As a [^,]+,?\s*/i, '');

    // Remove "The user would say:" or similar prefixes
    cleaned = cleaned.replace(/^(The user (would )?say|User response|Response):\s*/i, '');

    // Remove quotes if the entire response is quoted
    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
      cleaned = cleaned.slice(1, -1);
    }

    // Remove excessive whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
  }

  /**
   * Generate a fallback response when LLM fails
   * @private
   */
  private generateFallbackResponse(_agentResponse: string, context: SimulationContext): string {
    const { persona, objective } = this.config;

    // Simple fallback responses based on persona type
    if (persona.toLowerCase().includes('frustrated') || persona.toLowerCase().includes('angry')) {
      return "I'm still not getting the help I need. Can you please provide a clearer solution?";
    }

    if (persona.toLowerCase().includes('confused') || persona.toLowerCase().includes('beginner')) {
      return "I'm not sure I understand. Could you explain that differently?";
    }

    if (persona.toLowerCase().includes('technical') || persona.toLowerCase().includes('expert')) {
      return 'Can you provide more specific technical details?';
    }

    // Default fallback
    if (context.turnNumber === 1) {
      return `I need help with ${objective}. Can you assist me?`;
    }

    return 'Could you help me understand what I should do next?';
  }

  /**
   * Update the user simulator configuration during conversation
   * Useful for dynamic persona changes
   */
  updateConfig(newConfig: Partial<UserSimulatorConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration (useful for debugging)
   */
  getConfig(): UserSimulatorConfig {
    return { ...this.config };
  }
}
