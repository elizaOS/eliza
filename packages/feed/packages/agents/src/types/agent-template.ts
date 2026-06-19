/**
 * Agent Template Type Definition
 *
 * Pre-configured archetypes for creating new AI agents with personality,
 * trading strategy, and system prompts.
 */

export interface AgentTemplate {
  archetype: string;
  name: string;
  description: string;
  bio: string;
  system: string;
  personality: string;
  tradingStrategy: string;

  /**
   * Custom evaluation rubric for this archetype.
   * If not provided, uses the default rubric from the rubrics registry.
   */
  evaluationRubric?: string;

  /**
   * Metrics that are most important for this archetype.
   * Used to highlight key metrics in evaluation prompts.
   * Format: 'category.metric' e.g. 'trading.totalPnL', 'social.uniqueUsersInteracted'
   */
  priorityMetrics?: string[];

  /**
   * Training configuration overrides for this archetype.
   */
  trainingConfig?: {
    /** Minimum trajectories needed before training */
    minTrajectories?: number;
    /** Learning rate multiplier */
    learningRateMultiplier?: number;
    /** LoRA rank for fine-tuning */
    loraRank?: number;
  };
}
