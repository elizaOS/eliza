import { type IAgentRuntime, type UUID, logger, type Memory } from '@elizaos/core';

import {
  type SecurityEvent,
  SecurityEventType,
  type SecurityContext,
  type SecurityCheck,
  type ThreatAssessment,
  type PatternDetection,
  type MultiAccountDetection,
  type PhishingDetection,
  type ImpersonationDetection,
  type CoordinationDetection,
  type CredentialTheftDetection,
  type BehavioralProfile,
  type Message,
  type Action,
} from '../types/security';

import { type PermissionContext } from '../types/permissions';

import { TrustEvidenceType, type TrustInteraction } from '../types/trust';

export interface RiskScore {
  score: number; // 0-1
  factors: Record<string, number>;
  recommendation: string;
}

export interface AnomalyScore {
  score: number; // 0-1
  anomalies: string[];
  baseline?: any;
}

export interface SocialEngineeringFactors {
  urgency: number;
  authority: number;
  intimidation: number;
  liking: number;
  reciprocity: number;
  commitment: number;
  socialProof: number;
  scarcity: number;
}

export class SecurityModule {
  private runtime!: IAgentRuntime;
  private trustEngine: any;
  private behavioralProfiles: Map<UUID, BehavioralProfile> = new Map();
  private messageHistory: Map<UUID, Message[]> = new Map();
  private actionHistory: Map<UUID, Action[]> = new Map();

  // Patterns for prompt injection detection
  private readonly INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+(instructions|commands)/i,
    /disregard\s+(all\s+)?prior\s+(commands|instructions)/i,
    /new\s+instructions?:/i,
    /system\s+override/i,
    /admin\s+access/i,
    /grant\s+me\s+(admin|owner|all)/i,
    /you\s+are\s+now/i,
    /act\s+as\s+if/i,
    /pretend\s+(to\s+be|you\s+are)/i,
    /bypass\s+security/i,
    /give\s+me\s+all\s+permissions/i,
    /make\s+me\s+(an\s+)?(admin|owner)/i,
    /this\s+is\s+a\s+system\s+command/i,
    /execute\s+privileged/i,
  ];

  // Keywords indicating social engineering
  private readonly URGENCY_KEYWORDS = [
    'urgent',
    'immediately',
    'right now',
    'asap',
    'emergency',
    'critical',
    'time sensitive',
    'deadline',
    'expires',
  ];

  private readonly AUTHORITY_KEYWORDS = [
    'boss',
    'manager',
    'admin',
    'owner',
    'supervisor',
    'authorized',
    'official',
    'directive',
    'ordered',
  ];

  private readonly INTIMIDATION_KEYWORDS = [
    'consequences',
    'trouble',
    'fired',
    'banned',
    'reported',
    'legal action',
    'lawsuit',
    'police',
    'authorities',
  ];

  // Additional patterns for credential theft
  private readonly CREDENTIAL_PATTERNS = [
    /api[_\s-]?token/i,
    /password/i,
    /seed[_\s-]?phrase/i,
    /private[_\s-]?key/i,
    /secret[_\s-]?key/i,
    /auth[_\s-]?token/i,
    /access[_\s-]?token/i,
    /credentials/i,
    /wallet[_\s-]?(seed|phrase)/i,
    /mnemonic/i,
  ];

  // Patterns for phishing detection
  private readonly PHISHING_INDICATORS = [
    /bit\.ly/i,
    /tinyurl/i,
    /click[_\s-]?here/i,
    /verify[_\s-]?account/i,
    /confirm[_\s-]?identity/i,
    /suspended[_\s-]?account/i,
    /urgent[_\s-]?action/i,
    /limited[_\s-]?time/i,
    /act[_\s-]?now/i,
  ];

  constructor() {
    // Runtime will be set during initialize
  }

  /**
   * Initialize the security module
   */
  async initialize(runtime: IAgentRuntime, trustEngine: any): Promise<void> {
    this.runtime = runtime;
    this.trustEngine = trustEngine;
    logger.info('[SecurityModule] Initialized');
  }

  /**
   * Detect prompt injection attempts
   */
  async detectPromptInjection(message: string, context: SecurityContext): Promise<SecurityCheck> {
    // Use LLM evaluator if available
    const llmEvaluator = this.runtime?.getService?.('llm-evaluator');
    if (llmEvaluator) {
      return await (llmEvaluator as any).evaluateSecurityThreat(message, context, []);
    }

    // Fallback to pattern matching only if LLM is not available
    const patternMatches = this.INJECTION_PATTERNS.filter((pattern) => pattern.test(message));

    if (patternMatches.length > 0) {
      await this.logSecurityEvent({
        type: SecurityEventType.PROMPT_INJECTION_ATTEMPT,
        entityId: context.entityId || ('unknown' as UUID),
        severity: 'high',
        context,
        details: {
          message,
          patterns: patternMatches.map((p) => p.toString()),
          context,
        },
      });

      return {
        detected: true,
        confidence: Math.min(0.9 + patternMatches.length * 0.05, 1),
        type: 'prompt_injection',
        severity: patternMatches.length > 2 ? 'critical' : 'high',
        action: 'block',
        details: `Detected ${patternMatches.length} injection patterns`,
      };
    }

    // Semantic analysis (simplified)
    const semanticScore = await this.analyzeSemantics(message);

    if (semanticScore > 0.8) {
      return {
        detected: true,
        confidence: semanticScore,
        type: 'prompt_injection',
        severity: 'medium',
        action: 'require_verification',
        details: 'Suspicious command structure detected',
      };
    }

    return {
      detected: false,
      confidence: 0,
      type: 'none',
      severity: 'low',
      action: 'allow',
    };
  }

  /**
   * Detect social engineering attempts
   */
  async detectSocialEngineering(message: string, context: SecurityContext): Promise<SecurityCheck> {
    // Use LLM evaluator if available
    const llmEvaluator = this.runtime?.getService?.('llm-evaluator');
    if (llmEvaluator) {
      const history = this.messageHistory.get(context.entityId || ('unknown' as UUID)) || [];
      return await (llmEvaluator as any).evaluateSecurityThreat(
        message, 
        context, 
        history.map(m => m.content)
      );
    }

    // Fallback to factor-based analysis
    const factors = this.analyzeSocialEngineeringFactors(message.toLowerCase());
    const riskScore = this.calculateSocialEngineeringRisk(factors);

    if (riskScore.score > 0.7) {
      await this.logSecurityEvent({
        type: SecurityEventType.SOCIAL_ENGINEERING_ATTEMPT,
        entityId: context.entityId || ('unknown' as UUID),
        severity: riskScore.score > 0.85 ? 'critical' : 'high',
        context,
        details: {
          requestedAction: context.requestedAction,
          factors,
          riskScore,
        },
      });

      return {
        detected: true,
        confidence: riskScore.score,
        type: 'social_engineering',
        severity: riskScore.score > 0.85 ? 'critical' : 'high',
        action: 'block',
        details: riskScore.recommendation,
      };
    }

    if (riskScore.score > 0.4) {
      return {
        detected: true,
        confidence: riskScore.score,
        type: 'social_engineering',
        severity: 'medium',
        action: 'require_verification',
        details: 'Suspicious interaction pattern detected',
      };
    }

    return {
      detected: false,
      confidence: 0,
      type: 'none',
      severity: 'low',
      action: 'allow',
    };
  }

  /**
   * Analyze a message for security threats
   */
  async analyzeMessage(
    message: string,
    entityId: UUID,
    context: SecurityContext
  ): Promise<SecurityCheck> {
    // Check for prompt injection
    const injectionCheck = await this.detectPromptInjection(message, {
      ...context,
      entityId,
    });

    if (injectionCheck.detected) {
      return injectionCheck;
    }

    // Check for social engineering
    const socialEngCheck = await this.detectSocialEngineering(message, {
      ...context,
      entityId,
    });

    if (socialEngCheck.detected) {
      return socialEngCheck;
    }

    // Check for credential theft
    const credTheftCheck = await this.detectCredentialTheft(message, entityId, {
      ...context,
      entityId,
    });

    if (credTheftCheck) {
      return {
        detected: true,
        confidence: credTheftCheck.confidence,
        type: 'anomaly',
        severity: 'critical',
        action: 'block',
        details: credTheftCheck.recommendation,
      };
    }

    // No threats detected
    return {
      detected: false,
      confidence: 0,
      type: 'none',
      severity: 'low',
      action: 'allow',
    };
  }

  /**
   * Assess overall threat level
   */
  async assessThreatLevel(context: SecurityContext): Promise<ThreatAssessment> {
    const recentIncidents = await this.getRecentSecurityIncidents(context.roomId, 24);

    // Calculate threat level based on recent incidents
    const incidentScore = recentIncidents.length * 0.1;
    const criticalIncidents = recentIncidents.filter((i) => i.severity === 'critical').length;
    const highIncidents = recentIncidents.filter((i) => i.severity === 'high').length;

    const threatScore = Math.min(incidentScore + criticalIncidents * 0.3 + highIncidents * 0.15, 1);

    let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (threatScore > 0.8) severity = 'critical';
    else if (threatScore > 0.6) severity = 'high';
    else if (threatScore > 0.3) severity = 'medium';

    return {
      detected: threatScore > 0.3,
      confidence: threatScore,
      type: criticalIncidents > 0 ? 'anomaly' : 'none',
      severity,
      action:
        severity === 'critical'
          ? 'block'
          : severity === 'high'
            ? 'require_verification'
            : 'log_only',
      details: `Threat score: ${threatScore.toFixed(2)}`,
      recommendation: `Recent incidents: ${recentIncidents.length} (${criticalIncidents} critical, ${highIncidents} high)`,
    };
  }

  /**
   * Get recent security incidents
   */
  async getRecentSecurityIncidents(roomId?: UUID, hours = 24): Promise<SecurityEvent[]> {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;

    // In a real implementation, this would query a database
    // For now, return empty array
    return [];
  }

  /**
   * Get security recommendations based on threat level
   */
  getSecurityRecommendations(threatLevel: number): string[] {
    const recommendations: string[] = [];

    if (threatLevel > 0.8) {
      recommendations.push('CRITICAL: Implement immediate lockdown procedures');
      recommendations.push('Restrict all high-privilege operations');
      recommendations.push('Enable multi-factor authentication for all actions');
      recommendations.push('Monitor all user activity closely');
    } else if (threatLevel > 0.6) {
      recommendations.push('HIGH ALERT: Increase security monitoring');
      recommendations.push('Require additional verification for sensitive operations');
      recommendations.push('Review recent security incidents');
    } else if (threatLevel > 0.4) {
      recommendations.push('ELEVATED: Maintain heightened awareness');
      recommendations.push('Monitor for suspicious patterns');
      recommendations.push('Consider additional security measures');
    } else {
      recommendations.push('Continue normal security monitoring');
      recommendations.push('Maintain security best practices');
    }

    return recommendations;
  }

  /**
   * Log security event (now public)
   */
  async logSecurityEvent(
    event: Omit<SecurityEvent, 'id' | 'timestamp' | 'handled'>
  ): Promise<void> {
    await this.runtime.log({
      entityId: event.entityId,
      roomId: this.runtime.agentId,
      type: 'security_event',
      body: {
        ...event,
        timestamp: Date.now(),
        handled: false,
      },
    });
  }

  /**
   * Analyze social engineering factors
   */
  private analyzeSocialEngineeringFactors(text: string): SocialEngineeringFactors {
    const factors: SocialEngineeringFactors = {
      urgency: this.calculateKeywordScore(text, this.URGENCY_KEYWORDS),
      authority: this.calculateKeywordScore(text, this.AUTHORITY_KEYWORDS),
      intimidation: this.calculateKeywordScore(text, this.INTIMIDATION_KEYWORDS),
      liking: this.detectLikingManipulation(text),
      reciprocity: this.detectReciprocityManipulation(text),
      commitment: this.detectCommitmentManipulation(text),
      socialProof: this.detectSocialProofManipulation(text),
      scarcity: this.detectScarcityManipulation(text),
    };

    return factors;
  }

  /**
   * Calculate keyword score
   */
  private calculateKeywordScore(text: string, keywords: string[]): number {
    const matches = keywords.filter((keyword) => text.includes(keyword.toLowerCase()));
    return Math.min(matches.length / keywords.length, 1);
  }

  /**
   * Detect liking manipulation
   */
  private detectLikingManipulation(text: string): number {
    const patterns = [
      'we are friends',
      'trust me',
      'help me out',
      'we go way back',
      'remember when',
      'you know me',
      'we are alike',
    ];
    return this.calculateKeywordScore(text, patterns);
  }

  /**
   * Detect reciprocity manipulation
   */
  private detectReciprocityManipulation(text: string): number {
    const patterns = [
      'i helped you',
      'you owe me',
      'return the favor',
      'i did this for you',
      'after all i',
      'remember i',
    ];
    return this.calculateKeywordScore(text, patterns);
  }

  /**
   * Detect commitment manipulation
   */
  private detectCommitmentManipulation(text: string): number {
    const patterns = [
      'you said',
      'you promised',
      'you agreed',
      'you committed',
      'keep your word',
      'honor your',
    ];
    return this.calculateKeywordScore(text, patterns);
  }

  /**
   * Detect social proof manipulation
   */
  private detectSocialProofManipulation(text: string): number {
    const patterns = [
      'everyone else',
      'others are',
      'normal to',
      'standard practice',
      'usual procedure',
      'always done',
    ];
    return this.calculateKeywordScore(text, patterns);
  }

  /**
   * Detect scarcity manipulation
   */
  private detectScarcityManipulation(text: string): number {
    const patterns = [
      'last chance',
      'limited time',
      'only one',
      'running out',
      'expires soon',
      'act now',
    ];
    return this.calculateKeywordScore(text, patterns);
  }

  /**
   * Calculate overall social engineering risk
   */
  private calculateSocialEngineeringRisk(factors: SocialEngineeringFactors): RiskScore {
    const weights = {
      urgency: 0.15,
      authority: 0.2,
      intimidation: 0.2,
      liking: 0.1,
      reciprocity: 0.1,
      commitment: 0.1,
      socialProof: 0.05,
      scarcity: 0.1,
    };

    let score = 0;
    for (const [factor, value] of Object.entries(factors)) {
      score += value * weights[factor as keyof typeof weights];
    }

    const topFactors = Object.entries(factors)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([factor]) => factor);

    return {
      score,
      factors: factors as any,
      recommendation: `High ${topFactors.join(', ')} manipulation detected. Verify request authenticity.`,
    };
  }

  /**
   * Analyze semantic patterns
   */
  private async analyzeSemantics(message: string): Promise<number> {
    // Simplified semantic analysis
    const suspiciousPatterns = [
      'system',
      'override',
      'admin',
      'root',
      'sudo',
      'execute',
      'command',
      'instruction',
      'directive',
    ];

    const words = message.toLowerCase().split(/\s+/);
    const suspiciousCount = words.filter((word) =>
      suspiciousPatterns.some((pattern) => word.includes(pattern))
    ).length;

    return Math.min(suspiciousCount * 0.2, 1);
  }

  /**
   * Log trust impact from security events
   */
  async logTrustImpact(
    entityId: UUID,
    event: SecurityEventType,
    impact: number,
    context?: { worldId?: UUID }
  ): Promise<void> {
    if (!this.trustEngine) return;

    const trustEvidenceType = this.mapSecurityEventToTrustEvidence(event);

    await this.trustEngine.recordInteraction({
      sourceEntityId: entityId,
      targetEntityId: this.runtime.agentId,
      type: trustEvidenceType,
      timestamp: Date.now(),
      impact,
      details: {
        securityEvent: event,
        description: `Security event: ${event}`,
      },
      context: {
        evaluatorId: this.runtime.agentId,
        worldId: context?.worldId,
      },
    });
  }

  /**
   * Maps security events to trust evidence types
   */
  private mapSecurityEventToTrustEvidence(event: SecurityEventType): TrustEvidenceType {
    const mapping: Record<SecurityEventType, TrustEvidenceType> = {
      [SecurityEventType.PROMPT_INJECTION_ATTEMPT]: TrustEvidenceType.SECURITY_VIOLATION,
      [SecurityEventType.SOCIAL_ENGINEERING_ATTEMPT]: TrustEvidenceType.SECURITY_VIOLATION,
      [SecurityEventType.PRIVILEGE_ESCALATION_ATTEMPT]: TrustEvidenceType.SECURITY_VIOLATION,
      [SecurityEventType.ANOMALOUS_REQUEST]: TrustEvidenceType.SUSPICIOUS_ACTIVITY,
      [SecurityEventType.TRUST_MANIPULATION]: TrustEvidenceType.SECURITY_VIOLATION,
      [SecurityEventType.IDENTITY_SPOOFING]: TrustEvidenceType.SECURITY_VIOLATION,
      [SecurityEventType.MULTI_ACCOUNT_ABUSE]: TrustEvidenceType.SECURITY_VIOLATION,
      [SecurityEventType.CREDENTIAL_THEFT_ATTEMPT]: TrustEvidenceType.SECURITY_VIOLATION,
      [SecurityEventType.PHISHING_ATTEMPT]: TrustEvidenceType.SECURITY_VIOLATION,
      [SecurityEventType.IMPERSONATION_ATTEMPT]: TrustEvidenceType.SECURITY_VIOLATION,
      [SecurityEventType.COORDINATED_ATTACK]: TrustEvidenceType.SECURITY_VIOLATION,
      [SecurityEventType.MALICIOUS_LINK_CAMPAIGN]: TrustEvidenceType.SECURITY_VIOLATION,
    };

    return mapping[event] || TrustEvidenceType.SECURITY_VIOLATION;
  }

  /**
   * Enhanced pattern detection capabilities
   */

  /**
   * Detect multi-account manipulation
   */
  async detectMultiAccountPattern(
    entities: UUID[],
    timeWindow: number = 3600000 // 1 hour
  ): Promise<MultiAccountDetection | null> {
    if (entities.length < 2) return null;

    const profiles = await this.getBehavioralProfiles(entities);
    const similarities = this.calculateProfileSimilarities(profiles);

    // Check for synchronized actions
    const syncScore = await this.checkSynchronizedActions(entities, timeWindow);

    // Calculate overall linkage confidence
    const linkageEvidence = {
      typingPattern: similarities.typing || 0,
      timingPattern: syncScore,
      vocabularyPattern: similarities.vocabulary || 0,
      behaviorPattern: similarities.behavior || 0,
    };

    const confidence = Object.values(linkageEvidence).reduce((a, b) => a + b, 0) / 4;

    if (confidence > 0.7) {
      await this.logSecurityEvent({
        type: SecurityEventType.MULTI_ACCOUNT_ABUSE,
        entityId: entities[0],
        severity: confidence > 0.85 ? 'critical' : 'high',
        context: { requestedAction: 'multi_account_detection' } as SecurityContext,
        details: { entities, linkageEvidence },
      });

      return {
        type: 'multi_account',
        confidence,
        evidence: [
          `Typing pattern similarity: ${(linkageEvidence.typingPattern * 100).toFixed(1)}%`,
          `Synchronized actions: ${(linkageEvidence.timingPattern * 100).toFixed(1)}%`,
          `Vocabulary match: ${(linkageEvidence.vocabularyPattern * 100).toFixed(1)}%`,
        ],
        relatedEntities: entities,
        recommendation: 'Investigate for multi-account abuse. Consider account linking.',
        primaryAccount: entities[0],
        linkedAccounts: entities.slice(1),
        linkageEvidence,
      };
    }

    return null;
  }

  /**
   * Detect credential theft attempts
   */
  async detectCredentialTheft(
    message: string,
    entityId: UUID,
    context: SecurityContext
  ): Promise<CredentialTheftDetection | null> {
    const detectedPatterns = this.CREDENTIAL_PATTERNS.filter((pattern) =>
      pattern.test(message.toLowerCase())
    );

    if (detectedPatterns.length > 0) {
      // Check if requesting someone else's credentials
      const isRequestingFromOthers = /send|give|share|post|dm/i.test(message);

      if (isRequestingFromOthers) {
        await this.logSecurityEvent({
          type: SecurityEventType.CREDENTIAL_THEFT_ATTEMPT,
          entityId,
          severity: 'critical',
          context,
          details: { message, patterns: detectedPatterns.map((p) => p.toString()) },
        });

        return {
          type: 'credential_theft',
          confidence: Math.min(0.8 + detectedPatterns.length * 0.1, 1),
          evidence: detectedPatterns.map((p) => `Pattern detected: ${p.source}`),
          recommendation: 'Block message and warn potential victims. Consider immediate ban.',
          sensitivePatterns: detectedPatterns.map((p) => p.source),
          attemptedTheft: ['credentials', 'tokens', 'passwords'],
          potentialVictims: [], // Would be populated from message context
        };
      }
    }

    return null;
  }

  /**
   * Detect phishing campaigns
   */
  async detectPhishing(messages: Message[], entityId: UUID): Promise<PhishingDetection | null> {
    const suspiciousMessages = messages.filter((msg) => {
      const content = msg.content.toLowerCase();
      return (
        this.PHISHING_INDICATORS.some((pattern) => pattern.test(content)) ||
        this.detectSuspiciousLinks(content)
      );
    });

    if (suspiciousMessages.length >= 3) {
      const targetedEntities = Array.from(
        new Set(suspiciousMessages.map((msg) => msg.replyTo).filter(Boolean) as UUID[])
      );

      const campaignId = `campaign_${Date.now()}`;

      await this.logSecurityEvent({
        type: SecurityEventType.PHISHING_ATTEMPT,
        entityId,
        severity: 'high',
        context: { requestedAction: 'phishing_detection' } as SecurityContext,
        details: { messageCount: suspiciousMessages.length, campaignId },
      });

      return {
        type: 'phishing',
        confidence: Math.min(0.6 + suspiciousMessages.length * 0.1, 1),
        evidence: [
          `${suspiciousMessages.length} suspicious messages detected`,
          `${targetedEntities.length} users targeted`,
        ],
        recommendation: 'Quarantine account and disable shared links. Notify affected users.',
        maliciousLinks: this.extractLinks(suspiciousMessages),
        targetedEntities,
        campaignId,
      };
    }

    return null;
  }

  /**
   * Detect impersonation attempts
   */
  async detectImpersonation(
    username: string,
    existingUsers: string[]
  ): Promise<ImpersonationDetection | null> {
    const similarUsers = existingUsers.filter((existing) => {
      const similarity = this.calculateStringSimilarity(
        username.toLowerCase(),
        existing.toLowerCase()
      );
      return similarity > 0.8 && username !== existing;
    });

    if (similarUsers.length > 0) {
      const mostSimilar = similarUsers[0];
      const visualSimilarity = this.calculateVisualSimilarity(username, mostSimilar);
      const timingCoincidence = 0.9; // Would check if original user is active

      await this.logSecurityEvent({
        type: SecurityEventType.IMPERSONATION_ATTEMPT,
        entityId: 'unknown' as UUID,
        severity: visualSimilarity > 0.9 ? 'critical' : 'high',
        context: { requestedAction: 'impersonation_check' } as SecurityContext,
        details: { impersonator: username, impersonated: mostSimilar },
      });

      return {
        type: 'impersonation',
        confidence: (visualSimilarity + timingCoincidence) / 2,
        evidence: [
          `Username "${username}" similar to "${mostSimilar}"`,
          `Visual similarity: ${(visualSimilarity * 100).toFixed(1)}%`,
        ],
        recommendation: 'Block registration and alert original user.',
        impersonator: username,
        impersonated: mostSimilar,
        visualSimilarity,
        timingCoincidence,
      };
    }

    return null;
  }

  /**
   * Detect coordinated activity
   */
  async detectCoordinatedActivity(
    entities: UUID[],
    timeWindow: number = 300000 // 5 minutes
  ): Promise<CoordinationDetection | null> {
    const actions = await this.getRecentActions(entities, timeWindow);

    if (actions.length < entities.length * 2) return null;

    // Group actions by time
    const timeBuckets = new Map<number, Action[]>();
    actions.forEach((action) => {
      const bucket = Math.floor(action.timestamp / 60000); // 1-minute buckets
      if (!timeBuckets.has(bucket)) timeBuckets.set(bucket, []);
      timeBuckets.get(bucket)!.push(action);
    });

    // Find synchronized actions
    let coordinationScore = 0;
    timeBuckets.forEach((bucketActions) => {
      const uniqueEntities = new Set(bucketActions.map((a) => a.entityId));
      if (uniqueEntities.size >= entities.length * 0.7) {
        coordinationScore += 1;
      }
    });

    const correlationScore = coordinationScore / timeBuckets.size;

    if (correlationScore > 0.5) {
      await this.logSecurityEvent({
        type: SecurityEventType.COORDINATED_ATTACK,
        entityId: entities[0],
        severity: correlationScore > 0.7 ? 'critical' : 'high',
        context: { requestedAction: 'coordination_detection' } as SecurityContext,
        details: { entities, correlationScore, timeWindow },
      });

      return {
        type: 'coordination',
        confidence: correlationScore,
        evidence: [
          `${entities.length} accounts acting in coordination`,
          `Correlation score: ${(correlationScore * 100).toFixed(1)}%`,
        ],
        recommendation:
          'Possible coordinated attack. Increase monitoring and consider rate limiting.',
        coordinatedEntities: entities,
        timeWindow,
        correlationScore,
      };
    }

    return null;
  }

  /**
   * Helper methods for pattern detection
   */

  private async getBehavioralProfiles(entities: UUID[]): Promise<BehavioralProfile[]> {
    const profiles: BehavioralProfile[] = [];

    for (const entity of entities) {
      let profile = this.behavioralProfiles.get(entity);
      if (!profile) {
        profile = await this.buildBehavioralProfile(entity);
        this.behavioralProfiles.set(entity, profile);
      }
      profiles.push(profile);
    }

    return profiles;
  }

  private async buildBehavioralProfile(entityId: UUID): Promise<BehavioralProfile> {
    const messages = this.messageHistory.get(entityId) || [];

    // Calculate typing speed (simplified)
    const typingSpeeds = messages.map((msg) => msg.content.split(' ').length);
    const avgTypingSpeed = typingSpeeds.reduce((a, b) => a + b, 0) / typingSpeeds.length || 0;

    // Calculate message length stats
    const lengths = messages.map((msg) => msg.content.length);
    const meanLength = lengths.reduce((a, b) => a + b, 0) / lengths.length || 0;
    const variance =
      lengths.reduce((a, b) => a + Math.pow(b - meanLength, 2), 0) / lengths.length || 0;
    const stdDev = Math.sqrt(variance);

    // Extract common phrases (simplified)
    const phrases = new Map<string, number>();
    messages.forEach((msg) => {
      const words = msg.content.toLowerCase().split(' ');
      for (let i = 0; i < words.length - 2; i++) {
        const phrase = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
        phrases.set(phrase, (phrases.get(phrase) || 0) + 1);
      }
    });

    const commonPhrases = Array.from(phrases.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([phrase]) => phrase);

    // Calculate active hours
    const hourCounts = new Array(24).fill(0);
    messages.forEach((msg) => {
      const hour = new Date(msg.timestamp).getHours();
      hourCounts[hour]++;
    });

    return {
      entityId,
      typingSpeed: avgTypingSpeed,
      vocabularyComplexity: 0.5, // Simplified
      messageLength: { mean: meanLength, stdDev },
      activeHours: hourCounts,
      commonPhrases,
      interactionPatterns: new Map(),
    };
  }

  private calculateProfileSimilarities(profiles: BehavioralProfile[]): Record<string, number> {
    if (profiles.length < 2) return {};

    const similarities = {
      typing: 0,
      vocabulary: 0,
      behavior: 0,
    };

    // Compare typing patterns
    const typingSpeeds = profiles.map((p) => p.typingSpeed);
    const typingVariance = this.calculateVariance(typingSpeeds);
    similarities.typing = 1 - Math.min(typingVariance / 10, 1);

    // Compare vocabulary
    const allPhrases = profiles.flatMap((p) => p.commonPhrases);
    const uniquePhrases = new Set(allPhrases);
    similarities.vocabulary = 1 - uniquePhrases.size / allPhrases.length;

    // Compare behavior patterns
    const messageLengths = profiles.map((p) => p.messageLength.mean);
    const lengthVariance = this.calculateVariance(messageLengths);
    similarities.behavior = 1 - Math.min(lengthVariance / 100, 1);

    return similarities;
  }

  private calculateVariance(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  }

  private async checkSynchronizedActions(entities: UUID[], timeWindow: number): Promise<number> {
    const actions = await this.getRecentActions(entities, timeWindow);

    // Group actions by entity and time
    const entityActions = new Map<UUID, number[]>();
    actions.forEach((action) => {
      if (!entityActions.has(action.entityId)) {
        entityActions.set(action.entityId, []);
      }
      entityActions.get(action.entityId)!.push(action.timestamp);
    });

    // Check for synchronized timestamps
    let syncCount = 0;
    const threshold = 5000; // 5 seconds

    entityActions.forEach((timestamps1, entity1) => {
      entityActions.forEach((timestamps2, entity2) => {
        if (entity1 !== entity2) {
          timestamps1.forEach((t1) => {
            timestamps2.forEach((t2) => {
              if (Math.abs(t1 - t2) < threshold) {
                syncCount++;
              }
            });
          });
        }
      });
    });

    const maxPossibleSync = entities.length * (entities.length - 1) * 3; // Approximate
    return Math.min(syncCount / maxPossibleSync, 1);
  }

  private async getRecentActions(entities: UUID[], timeWindow: number): Promise<Action[]> {
    const cutoff = Date.now() - timeWindow;
    const allActions: Action[] = [];

    entities.forEach((entity) => {
      const actions = this.actionHistory.get(entity) || [];
      allActions.push(...actions.filter((a) => a.timestamp > cutoff));
    });

    return allActions;
  }

  private detectSuspiciousLinks(content: string): boolean {
    const urlShorteners = /bit\.ly|tinyurl|short\.link|t\.co/i;
    const suspiciousPatterns = /click[_\s-]?here|verify[_\s-]?now|act[_\s-]?fast/i;

    return urlShorteners.test(content) || suspiciousPatterns.test(content);
  }

  private extractLinks(messages: Message[]): string[] {
    const linkPattern = /https?:\/\/[^\s]+/g;
    const links: string[] = [];

    messages.forEach((msg) => {
      const found = msg.content.match(linkPattern);
      if (found) links.push(...found);
    });

    return Array.from(new Set(links));
  }

  private calculateStringSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1.0;

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  private calculateVisualSimilarity(str1: string, str2: string): number {
    // Check for character substitution (l->I, 0->O, etc.)
    const visuallySimilar: Record<string, string[]> = {
      l: ['I', '1', '|'],
      I: ['l', '1', '|'],
      '1': ['l', 'I', '|'],
      '0': ['O', 'o'],
      O: ['0', 'o'],
      o: ['0', 'O'],
    };

    let matches = 0;
    for (let i = 0; i < Math.min(str1.length, str2.length); i++) {
      if (
        str1[i] === str2[i] ||
        visuallySimilar[str1[i]]?.includes(str2[i]) ||
        visuallySimilar[str2[i]]?.includes(str1[i])
      ) {
        matches++;
      }
    }

    return matches / Math.max(str1.length, str2.length);
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Store message for analysis
   */
  async storeMessage(message: Message): Promise<void> {
    if (!this.messageHistory.has(message.entityId)) {
      this.messageHistory.set(message.entityId, []);
    }
    const messages = this.messageHistory.get(message.entityId)!;
    messages.push(message);

    // Keep only recent messages (last 100)
    if (messages.length > 100) {
      messages.shift();
    }
  }

  /**
   * Store action for analysis
   */
  async storeAction(action: Action): Promise<void> {
    if (!this.actionHistory.has(action.entityId)) {
      this.actionHistory.set(action.entityId, []);
    }
    const actions = this.actionHistory.get(action.entityId)!;
    actions.push(action);

    // Keep only recent actions (last 100)
    if (actions.length > 100) {
      actions.shift();
    }
  }
}
