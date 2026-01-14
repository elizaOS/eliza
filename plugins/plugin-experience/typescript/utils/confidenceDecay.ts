import type { Experience } from "../types";
import { ExperienceType } from "../types";

export interface DecayConfig {
  halfLife: number; // Time in milliseconds for confidence to decay by half
  minConfidence: number; // Minimum confidence level (never decays below this)
  decayStartDelay: number; // Time before decay starts (grace period)
}

const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLife: 30 * 24 * 60 * 60 * 1000, // 30 days
  minConfidence: 0.1, // 10% minimum
  decayStartDelay: 7 * 24 * 60 * 60 * 1000, // 7 days grace period
};

export class ConfidenceDecayManager {
  private config: DecayConfig;

  constructor(config: Partial<DecayConfig> = {}) {
    this.config = { ...DEFAULT_DECAY_CONFIG, ...config };
  }

  /**
   * Calculate the decayed confidence for an experience
   */
  getDecayedConfidence(experience: Experience): number {
    const now = Date.now();
    const age = now - experience.createdAt;
    const specificConfig = this.getDomainSpecificDecay(experience);

    // No decay during grace period
    if (age < specificConfig.decayStartDelay) {
      return experience.confidence;
    }

    // Calculate decay based on half-life
    const decayTime = age - specificConfig.decayStartDelay;
    const halfLives = decayTime / specificConfig.halfLife;
    const decayFactor = 0.5 ** halfLives;

    // Apply decay but respect minimum
    const decayedConfidence = experience.confidence * decayFactor;
    return Math.max(specificConfig.minConfidence, decayedConfidence);
  }

  /**
   * Get experiences that need reinforcement (low confidence due to decay)
   */
  getExperiencesNeedingReinforcement(experiences: Experience[], threshold = 0.3): Experience[] {
    return experiences.filter((exp) => {
      const decayed = this.getDecayedConfidence(exp);
      return decayed < threshold && decayed > this.config.minConfidence;
    });
  }

  /**
   * Calculate reinforcement boost when an experience is validated
   */
  calculateReinforcementBoost(experience: Experience, validationStrength = 1.0): number {
    const currentConfidence = this.getDecayedConfidence(experience);
    const boost = (1 - currentConfidence) * validationStrength * 0.5;
    return Math.min(1, currentConfidence + boost);
  }

  /**
   * Adjust decay rate based on experience type and domain
   */
  getDomainSpecificDecay(experience: Experience): DecayConfig {
    const config = { ...this.config };

    // Facts and discoveries decay slower
    if (
      experience.type === ExperienceType.DISCOVERY ||
      experience.type === ExperienceType.LEARNING
    ) {
      config.halfLife *= 2; // Double the half-life
    }

    // Warnings and corrections decay slower (important to remember)
    if (
      experience.type === ExperienceType.WARNING ||
      experience.type === ExperienceType.CORRECTION
    ) {
      config.halfLife *= 1.5;
      config.minConfidence = 0.2; // Higher minimum
    }

    // Domain-specific adjustments
    switch (experience.domain) {
      case "security":
      case "safety":
        config.halfLife *= 3; // Security lessons decay very slowly
        config.minConfidence = 0.3;
        break;
      case "performance":
        config.halfLife *= 0.5; // Performance insights may change quickly
        break;
      case "user_preference":
        config.halfLife *= 0.7; // User preferences can change
        break;
    }

    return config;
  }

  /**
   * Get confidence trend for an experience over time
   */
  getConfidenceTrend(
    experience: Experience,
    points = 10
  ): Array<{ timestamp: number; confidence: number }> {
    const trend: Array<{ timestamp: number; confidence: number }> = [];
    const now = Date.now();
    const totalTime = now - experience.createdAt;
    const interval = totalTime / (points - 1);
    const specificConfig = this.getDomainSpecificDecay(experience);

    for (let i = 0; i < points; i++) {
      const timestamp = experience.createdAt + interval * i;
      const age = timestamp - experience.createdAt;

      let confidence: number;
      if (age < specificConfig.decayStartDelay) {
        confidence = experience.confidence;
      } else {
        const decayTime = age - specificConfig.decayStartDelay;
        const halfLives = decayTime / specificConfig.halfLife;
        const decayFactor = 0.5 ** halfLives;
        confidence = Math.max(specificConfig.minConfidence, experience.confidence * decayFactor);
      }

      trend.push({ timestamp, confidence });
    }

    return trend;
  }
}
