import {
  type IAgentRuntime,
  Service,
  type UUID,
  logger,
  type Component,
  stringToUuid,
  type Metadata,
  ServiceType,
} from '@elizaos/core';

import {
  type TrustProfile,
  type TrustDimensions,
  type TrustEvidence,
  TrustEvidenceType,
  type TrustContext,
  type TrustInteraction,
  type TrustCalculationConfig,
  type TrustDecision,
  type TrustRequirements,
} from '../types/trust';

/**
 * Default configuration for trust calculations
 */
const DEFAULT_CONFIG: TrustCalculationConfig = {
  recencyBias: 0.7,
  evidenceDecayRate: 0.5, // Points per day
  minimumEvidenceCount: 3,
  verificationMultiplier: 1.5,
  dimensionWeights: {
    reliability: 0.25,
    competence: 0.2,
    integrity: 0.25,
    benevolence: 0.2,
    transparency: 0.1,
  },
};

/**
 * Evidence impact mapping for different evidence types
 */
const EVIDENCE_IMPACT_MAP: Record<
  TrustEvidenceType,
  { dimensions: Partial<TrustDimensions>; baseImpact: number }
> = {
  // Positive evidence
  [TrustEvidenceType.PROMISE_KEPT]: {
    dimensions: { reliability: 15, integrity: 10 },
    baseImpact: 10,
  },
  [TrustEvidenceType.HELPFUL_ACTION]: {
    dimensions: { benevolence: 15, competence: 10 },
    baseImpact: 8,
  },
  [TrustEvidenceType.CONSISTENT_BEHAVIOR]: {
    dimensions: { reliability: 20, transparency: 10 },
    baseImpact: 12,
  },
  [TrustEvidenceType.VERIFIED_IDENTITY]: {
    dimensions: { transparency: 20, integrity: 10 },
    baseImpact: 15,
  },
  [TrustEvidenceType.COMMUNITY_CONTRIBUTION]: {
    dimensions: { benevolence: 20, competence: 15 },
    baseImpact: 12,
  },
  [TrustEvidenceType.SUCCESSFUL_TRANSACTION]: {
    dimensions: { reliability: 15, competence: 15 },
    baseImpact: 10,
  },

  // Negative evidence
  [TrustEvidenceType.PROMISE_BROKEN]: {
    dimensions: { reliability: -25, integrity: -15 },
    baseImpact: -15,
  },
  [TrustEvidenceType.HARMFUL_ACTION]: {
    dimensions: { benevolence: -30, integrity: -20 },
    baseImpact: -20,
  },
  [TrustEvidenceType.INCONSISTENT_BEHAVIOR]: {
    dimensions: { reliability: -20, transparency: -15 },
    baseImpact: -12,
  },
  [TrustEvidenceType.SUSPICIOUS_ACTIVITY]: {
    dimensions: { integrity: -15, transparency: -20 },
    baseImpact: -15,
  },
  [TrustEvidenceType.FAILED_VERIFICATION]: {
    dimensions: { transparency: -25, integrity: -10 },
    baseImpact: -10,
  },
  [TrustEvidenceType.SPAM_BEHAVIOR]: {
    dimensions: { benevolence: -15, competence: -10 },
    baseImpact: -10,
  },
  [TrustEvidenceType.SECURITY_VIOLATION]: {
    dimensions: { integrity: -35, reliability: -20 },
    baseImpact: -25,
  },

  // Neutral evidence
  [TrustEvidenceType.IDENTITY_CHANGE]: {
    dimensions: { transparency: -5 },
    baseImpact: 0,
  },
  [TrustEvidenceType.ROLE_CHANGE]: {
    dimensions: {},
    baseImpact: 0,
  },
  [TrustEvidenceType.CONTEXT_SWITCH]: {
    dimensions: {},
    baseImpact: 0,
  },
};

export class TrustEngine extends Service {
  static serviceType = 'trust-engine' as const;

  capabilityDescription = 'Multi-dimensional trust scoring and evaluation system';

  private trustConfig: TrustCalculationConfig;
  private profileCache: Map<string, TrustProfile> = new Map();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes
  private trustProfiles: Map<string, TrustProfile> = new Map();
  private interactions: TrustInteraction[] = [];

  constructor(config?: Partial<TrustCalculationConfig>) {
    super();
    this.trustConfig = { ...DEFAULT_CONFIG, ...config };
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    logger.info({ trustConfig: this.trustConfig }, '[TrustEngine] Initialized with config:');
  }

  async stop(): Promise<void> {
    this.profileCache.clear();
    logger.info('[TrustEngine] Stopped');
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new TrustEngine();
    await service.initialize(runtime);
    return service;
  }

  /**
   * Calculate trust profile for an entity
   */
  async calculateTrust(subjectId: UUID, context: TrustContext): Promise<TrustProfile> {
    const cacheKey = `${context.evaluatorId}-${subjectId}`;

    // Check cache
    const cached = this.profileCache.get(cacheKey);
    if (cached && Date.now() - cached.lastCalculated < this.cacheTimeout) {
      return cached;
    }

    // Load evidence from components
    const evidence = await this.loadEvidence(subjectId, context);

    // Calculate dimensions
    const dimensions = this.calculateDimensions(evidence);

    // Calculate overall trust
    const overallTrust = this.calculateOverallTrust(dimensions);

    // Calculate confidence
    const confidence = this.calculateConfidence(evidence);

    // Analyze trend
    const trend = await this.analyzeTrend(subjectId, context, overallTrust);

    const profile: TrustProfile = {
      entityId: subjectId,
      dimensions,
      overallTrust,
      confidence,
      interactionCount: evidence.length,
      evidence: evidence.slice(0, 100), // Keep most recent 100
      lastCalculated: Date.now(),
      calculationMethod: 'dimensional_aggregation_v1',
      trend,
      evaluatorId: context.evaluatorId,
    };

    // Save to cache and storage
    this.profileCache.set(cacheKey, profile);
    await this.saveTrustProfile(profile, context);

    return profile;
  }

  /**
   * Records a trust interaction
   */
  async recordInteraction(interaction: TrustInteraction): Promise<void> {
    this.interactions.push(interaction);

    // Update the trust profile immediately
    const key = `${interaction.sourceEntityId}-${interaction.targetEntityId}`;
    const profile = this.trustProfiles.get(key);

    if (profile) {
      // Apply the impact immediately
      profile.overallTrust = Math.max(0, Math.min(100, profile.overallTrust + interaction.impact));
      profile.interactionCount++;
      profile.lastCalculated = Date.now();

      // Add evidence
      const evidence: TrustEvidence = {
        type: interaction.type,
        timestamp: interaction.timestamp,
        impact: interaction.impact,
        weight: 1.0,
        description: interaction.details?.description || '',
        reportedBy: interaction.sourceEntityId,
        targetEntityId: interaction.targetEntityId,
        verified: true,
        context: interaction.context || { evaluatorId: this.runtime.agentId },
        evaluatorId: interaction.context?.evaluatorId || this.runtime.agentId,
      };
      profile.evidence.push(evidence);

      // Keep only last 100 evidence items
      if (profile.evidence.length > 100) {
        profile.evidence = profile.evidence.slice(-100);
      }
    }

    logger.info({
      type: interaction.type,
      impact: interaction.impact,
      source: interaction.sourceEntityId,
      target: interaction.targetEntityId,
    }, '[TrustEngine] Recorded interaction:');
  }

  /**
   * Evaluate if an action is allowed based on trust
   */
  async evaluateTrustDecision(
    entityId: UUID,
    requirements: TrustRequirements,
    context: TrustContext
  ): Promise<TrustDecision> {
    const profile = await this.calculateTrust(entityId, context);

    // Check overall trust
    if (profile.overallTrust < requirements.minimumTrust) {
      return {
        allowed: false,
        trustScore: profile.overallTrust,
        requiredScore: requirements.minimumTrust,
        dimensionsChecked: profile.dimensions,
        reason: `Trust score ${profile.overallTrust} is below required ${requirements.minimumTrust}`,
        suggestions: this.generateTrustBuildingSuggestions(profile, requirements),
      };
    }

    // Check specific dimensions
    if (requirements.dimensions) {
      for (const [dimension, required] of Object.entries(requirements.dimensions)) {
        const actual = profile.dimensions[dimension as keyof TrustDimensions];
        if (actual < required) {
          return {
            allowed: false,
            trustScore: profile.overallTrust,
            requiredScore: requirements.minimumTrust,
            dimensionsChecked: requirements.dimensions,
            reason: `${dimension} score ${actual} is below required ${required}`,
            suggestions: this.generateDimensionSuggestions(dimension as keyof TrustDimensions),
          };
        }
      }
    }

    // Check interaction count
    if (
      requirements.minimumInteractions &&
      profile.interactionCount < requirements.minimumInteractions
    ) {
      return {
        allowed: false,
        trustScore: profile.overallTrust,
        requiredScore: requirements.minimumTrust,
        dimensionsChecked: profile.dimensions,
        reason: `Insufficient interactions: ${profile.interactionCount} < ${requirements.minimumInteractions}`,
        suggestions: ['Engage in more interactions to build history'],
      };
    }

    // Check confidence
    if (requirements.minimumConfidence && profile.confidence < requirements.minimumConfidence) {
      return {
        allowed: false,
        trustScore: profile.overallTrust,
        requiredScore: requirements.minimumTrust,
        dimensionsChecked: profile.dimensions,
        reason: `Trust confidence ${profile.confidence} is below required ${requirements.minimumConfidence}`,
        suggestions: ['More consistent interactions needed to increase confidence'],
      };
    }

    return {
      allowed: true,
      trustScore: profile.overallTrust,
      requiredScore: requirements.minimumTrust,
      dimensionsChecked: profile.dimensions,
      reason: 'All trust requirements met',
    };
  }

  /**
   * Calculate trust dimensions from evidence
   */
  private calculateDimensions(evidence: TrustEvidence[]): TrustDimensions {
    const dimensions: TrustDimensions = {
      reliability: 50,
      competence: 50,
      integrity: 50,
      benevolence: 50,
      transparency: 50,
    };

    for (const ev of evidence) {
      const impact = EVIDENCE_IMPACT_MAP[ev.type];
      if (!impact) continue;

      // Apply age weight
      const ageWeight = this.calculateAgeWeight(ev.timestamp);

      // Apply verification multiplier
      const verificationMultiplier = ev.verified ? this.trustConfig.verificationMultiplier : 1.0;

      // Update dimensions
      for (const [dimension, value] of Object.entries(impact.dimensions)) {
        const adjustedValue = value * ev.weight * ageWeight * verificationMultiplier;
        dimensions[dimension as keyof TrustDimensions] = Math.max(
          0,
          Math.min(100, dimensions[dimension as keyof TrustDimensions] + adjustedValue)
        );
      }
    }

    return dimensions;
  }

  /**
   * Calculate overall trust score from dimensions
   */
  private calculateOverallTrust(dimensions: TrustDimensions): number {
    const weights = this.trustConfig.dimensionWeights;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const [dimension, value] of Object.entries(dimensions)) {
      const weight = weights[dimension as keyof TrustDimensions];
      weightedSum += value * weight;
      totalWeight += weight;
    }

    return Math.round(weightedSum / totalWeight);
  }

  /**
   * Calculate confidence based on evidence quantity and consistency
   */
  private calculateConfidence(evidence: TrustEvidence[]): number {
    if (evidence.length < this.trustConfig.minimumEvidenceCount) {
      return 0;
    }

    // Base confidence from evidence count
    const countConfidence = Math.min(1, evidence.length / 20);

    // Consistency factor - how consistent is the evidence?
    const positiveCount = evidence.filter((e) => e.impact > 0).length;
    const negativeCount = evidence.filter((e) => e.impact < 0).length;
    const consistency = 1 - Math.abs(positiveCount - negativeCount) / evidence.length;

    // Recency factor - how recent is the evidence?
    const recentEvidence = evidence.filter(
      (e) => Date.now() - e.timestamp < 7 * 24 * 60 * 60 * 1000 // 7 days
    );
    const recencyFactor = recentEvidence.length / evidence.length;

    return countConfidence * 0.4 + consistency * 0.3 + recencyFactor * 0.3;
  }

  /**
   * Calculate age weight for evidence based on recency
   */
  private calculateAgeWeight(timestamp: number): number {
    const ageInDays = (Date.now() - timestamp) / (24 * 60 * 60 * 1000);
    const decayFactor = Math.exp(-this.trustConfig.evidenceDecayRate * ageInDays);

    // Blend with recency bias
    return this.trustConfig.recencyBias * decayFactor + (1 - this.trustConfig.recencyBias) * 0.5;
  }

  /**
   * Analyze trust trend over time
   */
  private async analyzeTrend(
    entityId: UUID,
    context: TrustContext,
    currentScore: number
  ): Promise<TrustProfile['trend']> {
    // Load historical trust scores
    const components = await this.runtime.getComponents(entityId);
    const historicalProfiles = components
      .filter((c) => c.type === 'trust_profile' && c.agentId === context.evaluatorId)
      .map((c) => c.data as unknown as TrustProfile)
      .sort((a, b) => b.lastCalculated - a.lastCalculated)
      .slice(0, 10);

    if (historicalProfiles.length < 2) {
      return {
        direction: 'stable',
        changeRate: 0,
        lastChangeAt: Date.now(),
      };
    }

    // Calculate trend
    const previousScore = historicalProfiles[0].overallTrust;
    const oldestScore = historicalProfiles[historicalProfiles.length - 1].overallTrust;
    const timeSpanDays =
      (Date.now() - historicalProfiles[historicalProfiles.length - 1].lastCalculated) /
      (24 * 60 * 60 * 1000);

    const changeRate = (currentScore - oldestScore) / timeSpanDays;

    let direction: 'increasing' | 'decreasing' | 'stable';
    if (Math.abs(changeRate) < 0.5) {
      direction = 'stable';
    } else if (changeRate > 0) {
      direction = 'increasing';
    } else {
      direction = 'decreasing';
    }

    return {
      direction,
      changeRate: Math.round(changeRate * 10) / 10,
      lastChangeAt:
        currentScore !== previousScore
          ? Date.now()
          : historicalProfiles[0].trend?.lastChangeAt || Date.now(),
    };
  }

  /**
   * Load evidence from storage
   */
  private async loadEvidence(entityId: UUID, context: TrustContext): Promise<TrustEvidence[]> {
    const components = await this.runtime.getComponents(entityId);

    const evidenceComponents = components.filter(
      (c) =>
        c.type === 'trust_evidence' &&
        (!context.worldId || c.worldId === context.worldId) &&
        (!context.roomId || c.roomId === context.roomId)
    );

    const evidence: TrustEvidence[] = [];
    for (const component of evidenceComponents) {
      const ev = component.data as unknown as TrustEvidence;

      // Apply time window filter
      if (context.timeWindow) {
        if (ev.timestamp < context.timeWindow.start || ev.timestamp > context.timeWindow.end) {
          continue;
        }
      }

      evidence.push(ev);
    }

    return evidence.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Save trust profile to storage
   */
  private async saveTrustProfile(profile: TrustProfile, context: TrustContext): Promise<void> {
    console.log('saveTrustProfile')
    const componentId = stringToUuid(`trust-profile-${profile.entityId}-${context.evaluatorId}`);

    const worldId = context.worldId || stringToUuid('trust-world')
    await this.runtime.ensureWorldExists({
      id: worldId,
      name: 'trust-world',
      agentId: this.runtime.agentId,
      serverId: stringToUuid('default'),
      metadata: {},
    });

    // Check if component already exists
    const existingComponent = await this.runtime.getComponent(
      profile.entityId,
      'trust_profile',
      worldId,
      context.evaluatorId
    );

    const component: Component = {
      id: componentId,
      type: 'trust_profile',
      agentId: context.evaluatorId,
      entityId: profile.entityId,
      roomId: context.roomId || stringToUuid('trust-global'),
      worldId,
      sourceEntityId: context.evaluatorId,
      data: profile as unknown as Metadata,
      createdAt: existingComponent?.createdAt || Date.now(),
    };

    if (existingComponent) {
      // Update existing component
      await this.runtime.updateComponent(component);
    } else {
      // Create new component
      await this.runtime.createComponent(component);
    }
  }

  /**
   * Save evidence to storage
   */
  private async saveEvidence(entityId: UUID, evidence: TrustEvidence): Promise<void> {
    console.log('saveEvidence')
    const componentId = stringToUuid(`trust-evidence-${entityId}-${evidence.timestamp}`);

    const worldId = evidence.context?.worldId || stringToUuid('trust-world')
    await this.runtime.ensureWorldExists({
      id: worldId,
      name: 'trust-world',
      agentId: this.runtime.agentId,
      serverId: stringToUuid('default'),
      metadata: {},
    });

    // Check if component already exists
    const existingComponent = await this.runtime.getComponent(
      entityId,
      'trust_evidence',
      worldId,
      evidence.reportedBy || this.runtime.agentId
    );

    const component: Component = {
      id: componentId,
      type: 'trust_evidence',
      agentId: this.runtime.agentId,
      entityId,
      roomId: evidence.context?.roomId || stringToUuid('trust-global'),
      worldId,
      sourceEntityId: evidence.reportedBy || this.runtime.agentId,
      data: evidence as unknown as Metadata,
      createdAt: evidence.timestamp,
    };

    if (existingComponent) {
      // Update existing component
      await this.runtime.updateComponent(component);
    } else {
      // Create new component
      await this.runtime.createComponent(component);
    }
  }

  /**
   * Clear cache for an entity
   */
  private clearCacheForEntity(entityId: UUID): void {
    const keysToDelete: string[] = [];
    for (const key of this.profileCache.keys()) {
      if (key.includes(entityId)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => this.profileCache.delete(key));
  }

  /**
   * Generate suggestions for building trust
   */
  private generateTrustBuildingSuggestions(
    profile: TrustProfile,
    requirements: TrustRequirements
  ): string[] {
    const suggestions: string[] = [];

    // Overall trust suggestions
    if (profile.overallTrust < requirements.minimumTrust) {
      const gap = requirements.minimumTrust - profile.overallTrust;
      suggestions.push(`Build ${gap} more trust points through positive interactions`);
    }

    // Dimension-specific suggestions
    const weakestDimension = Object.entries(profile.dimensions).sort(([, a], [, b]) => a - b)[0][0];

    suggestions.push(
      ...this.generateDimensionSuggestions(weakestDimension as keyof TrustDimensions)
    );

    // Interaction count suggestions
    if (profile.interactionCount < 10) {
      suggestions.push('Engage in more conversations and activities');
    }

    return suggestions;
  }

  /**
   * Generate suggestions for improving specific dimensions
   */
  private generateDimensionSuggestions(dimension: keyof TrustDimensions): string[] {
    const suggestions: Record<keyof TrustDimensions, string[]> = {
      reliability: [
        'Keep your promises and commitments',
        'Be consistent in your actions',
        'Follow through on what you say',
      ],
      competence: [
        'Demonstrate your skills through helpful contributions',
        'Share valuable knowledge or resources',
        'Complete tasks successfully',
      ],
      integrity: [
        'Be honest and transparent in your communications',
        'Admit mistakes when they happen',
        'Follow community guidelines consistently',
      ],
      benevolence: [
        'Help other community members',
        "Show genuine interest in others' wellbeing",
        'Contribute positively to discussions',
      ],
      transparency: [
        'Be open about your intentions',
        'Share information freely when appropriate',
        'Verify your identity on multiple platforms',
      ],
    };

    return suggestions[dimension] || ['Continue building trust through positive interactions'];
  }

  /**
   * Evaluates trust for an entity (simplified API for actions)
   */
  async evaluateTrust(
    entityId: UUID,
    evaluatorId: UUID,
    context?: Partial<TrustContext>
  ): Promise<TrustProfile> {
    const fullContext: TrustContext = {
      evaluatorId,
      ...context,
    };
    return this.calculateTrust(entityId, fullContext);
  }

  /**
   * Get recent trust interactions for an entity
   */
  async getRecentInteractions(entityId: UUID, limit = 10): Promise<TrustInteraction[]> {
    const cutoff = Date.now() - limit * 24 * 60 * 60 * 1000;
    return this.interactions.filter(
      (i) => (i.sourceEntityId === entityId || i.targetEntityId === entityId) && i.timestamp > cutoff
    );
  }

  /**
   * Gets recent security incidents for a room
   */
  async getRecentSecurityIncidents(roomId: UUID, hours: number = 24): Promise<any[]> {
    // This would typically query a security incidents table
    // For now, returning empty array
    return [];
  }

  /**
   * Assesses the current threat level for a room
   */
  async assessThreatLevel(roomId: UUID): Promise<number> {
    // This would analyze recent incidents and patterns
    // For now, returning a low threat level
    return 0.2;
  }

  /**
   * Analyzes a message for security concerns
   */
  async analyzeMessage(text: string, entityId: UUID, context: any): Promise<any> {
    // Delegate to security module if available
    const securityModule = this.runtime.getService('security-module') as any;
    if (securityModule) {
      return securityModule.analyzeMessage(text, entityId, context);
    }

    return {
      detected: false,
      type: null,
    };
  }

  /**
   * Gets security recommendations based on threat level
   */
  getSecurityRecommendations(threatLevel: number): string[] {
    if (threatLevel > 0.7) {
      return [
        'Enable enhanced monitoring',
        'Require additional verification for sensitive actions',
        'Review recent permission changes',
        'Consider temporary restrictions',
      ];
    } else if (threatLevel > 0.4) {
      return [
        'Monitor for unusual patterns',
        'Review recent security events',
        'Ensure all users are verified',
      ];
    }
    return ['Continue normal operations', 'Maintain standard security practices'];
  }
}
