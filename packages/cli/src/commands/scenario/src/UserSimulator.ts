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
    const prompt = this.buildSimulationPrompt(
      conversationHistory,
      latestAgentResponse, 
      context
    );

    try {
      const response = await this.runtime.useModel(
        this.config.model_type as any || ModelType.TEXT_LARGE,
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
        console.log(`👤 [UserSimulator] Persona: ${this.config.persona}`);
      }

      // Clean up the response (remove any meta-commentary)
      const cleanedResponse = this.cleanResponse(response);
      return cleanedResponse;

    } catch (error) {
      console.error(`❌ [UserSimulator] Failed to generate response:`, error);
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
    context: SimulationContext
  ): string {
    const { persona, objective, style, constraints, emotional_state, knowledge_level } = this.config;
    
    let prompt = `You are simulating a user in a conversation with an AI agent. You must stay in character throughout the conversation.

**Your Character Profile:**
- **Persona:** ${persona}
- **Primary Objective:** ${objective}
- **Communication Style:** ${style || 'natural and conversational'}
- **Knowledge Level:** ${knowledge_level}`;

    if (emotional_state) {
      prompt += `\n- **Emotional State:** ${emotional_state}`;
    }

    if (constraints.length > 0) {
      prompt += `\n\n**Behavioral Constraints (you must follow these):**`;
      constraints.forEach(constraint => {
        prompt += `\n- ${constraint}`;
      });
    }

    prompt += `\n\n**Conversation Context:**
- This is turn ${context.turnNumber} of a maximum conversation
- Your goal is to ${objective}
- Stay consistent with your persona and objectives`;

    // Add conversation history (limit to recent turns to manage token usage)
    const recentHistory = history.slice(-3); // Only include last 3 turns
    if (recentHistory.length > 0) {
      prompt += `\n\n**Recent Conversation History:**`;
      recentHistory.forEach((turn, i) => {
        const turnNum = history.length - recentHistory.length + i + 1;
        prompt += `\nTurn ${turnNum}:`;
        prompt += `\n  User: ${turn.userInput}`;
        prompt += `\n  Agent: ${turn.agentResponse}`;
      });
    }

    prompt += `\n\n**Agent's Latest Response:**
${agentResponse}

**Instructions:**
1. Respond as the user persona described above
2. Keep your response realistic and natural (20-200 words)
3. Stay true to your personality, objectives, and constraints
4. Consider your knowledge level when asking questions or providing information
5. Progress toward your objective while maintaining realistic conversation flow
6. Do NOT break character or provide meta-commentary
7. Respond only with what the user would actually say

**Your Response (as the user):**`;

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
  private generateFallbackResponse(agentResponse: string, context: SimulationContext): string {
    const { persona, objective } = this.config;
    
    // Simple fallback responses based on persona type
    if (persona.toLowerCase().includes('frustrated') || persona.toLowerCase().includes('angry')) {
      return "I'm still not getting the help I need. Can you please provide a clearer solution?";
    }
    
    if (persona.toLowerCase().includes('confused') || persona.toLowerCase().includes('beginner')) {
      return "I'm not sure I understand. Could you explain that differently?";
    }
    
    if (persona.toLowerCase().includes('technical') || persona.toLowerCase().includes('expert')) {
      return "Can you provide more specific technical details?";
    }
    
    // Default fallback
    if (context.turnNumber === 1) {
      return `I need help with ${objective}. Can you assist me?`;
    }
    
    return "Could you help me understand what I should do next?";
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
