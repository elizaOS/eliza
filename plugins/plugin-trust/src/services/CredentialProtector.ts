import { type IAgentRuntime, type UUID, logger, Service } from '@elizaos/core';

import { type SecurityContext, SecurityEventType } from '../types/security';

export interface CredentialThreatDetection {
  detected: boolean;
  confidence: number; // 0-1
  threatType: 'credential_request' | 'phishing' | 'social_engineering' | 'none';
  sensitiveData: string[];
  recommendation: string;
}

export class CredentialProtector extends Service {
  static serviceType = 'credential-protector' as const;

  capabilityDescription = 'Detects and prevents credential theft attempts, protects sensitive data';

  private securityModule: any;

  // Comprehensive patterns for sensitive data
  private readonly SENSITIVE_PATTERNS = [
    // Authentication tokens
    { pattern: /api[_\s-]?token/i, type: 'api_token' },
    { pattern: /auth[_\s-]?token/i, type: 'auth_token' },
    { pattern: /access[_\s-]?token/i, type: 'access_token' },
    { pattern: /bearer[_\s-]?token/i, type: 'bearer_token' },
    { pattern: /jwt[_\s-]?token/i, type: 'jwt_token' },
    { pattern: /session[_\s-]?token/i, type: 'session_token' },

    // Passwords and secrets
    { pattern: /password/i, type: 'password' },
    { pattern: /passwd/i, type: 'password' },
    { pattern: /secret[_\s-]?key/i, type: 'secret_key' },
    { pattern: /private[_\s-]?key/i, type: 'private_key' },
    { pattern: /encryption[_\s-]?key/i, type: 'encryption_key' },

    // Cryptocurrency
    { pattern: /seed[_\s-]?phrase/i, type: 'seed_phrase' },
    { pattern: /mnemonic[_\s-]?phrase/i, type: 'mnemonic' },
    { pattern: /wallet[_\s-]?(seed|phrase|key)/i, type: 'wallet_credentials' },
    { pattern: /private[_\s-]?wallet/i, type: 'wallet_key' },
    { pattern: /recovery[_\s-]?phrase/i, type: 'recovery_phrase' },

    // Personal information
    { pattern: /social[_\s-]?security/i, type: 'ssn' },
    { pattern: /credit[_\s-]?card/i, type: 'credit_card' },
    { pattern: /bank[_\s-]?account/i, type: 'bank_account' },
    { pattern: /routing[_\s-]?number/i, type: 'routing_number' },

    // Account credentials
    { pattern: /login[_\s-]?credentials/i, type: 'login_credentials' },
    { pattern: /account[_\s-]?(password|creds)/i, type: 'account_credentials' },
    { pattern: /2fa[_\s-]?code/i, type: '2fa_code' },
    { pattern: /otp[_\s-]?code/i, type: 'otp_code' },
    { pattern: /verification[_\s-]?code/i, type: 'verification_code' },
  ];

  // Request patterns that indicate credential theft
  private readonly THEFT_REQUEST_PATTERNS = [
    /send[_\s-]?(me|us)[_\s-]?(your|the)/i,
    /give[_\s-]?(me|us)[_\s-]?(your|the)/i,
    /share[_\s-]?(your|the)/i,
    /post[_\s-]?(your|the)/i,
    /dm[_\s-]?(me|us)[_\s-]?(your|the)/i,
    /provide[_\s-]?(your|the)/i,
    /tell[_\s-]?(me|us)[_\s-]?(your|the)/i,
    /show[_\s-]?(me|us)[_\s-]?(your|the)/i,
    /reveal[_\s-]?(your|the)/i,
    /disclose[_\s-]?(your|the)/i,
  ];

  // Legitimate context patterns (reduce false positives)
  private readonly LEGITIMATE_CONTEXTS = [
    /how[_\s-]?to[_\s-]?reset[_\s-]?password/i,
    /forgot[_\s-]?password/i,
    /password[_\s-]?requirements/i,
    /strong[_\s-]?password/i,
    /change[_\s-]?password/i,
    /update[_\s-]?password/i,
    /password[_\s-]?policy/i,
    /never[_\s-]?share[_\s-]?password/i,
    /keep[_\s-]?password[_\s-]?safe/i,
  ];

  constructor() {
    super();
  }

  async initialize(runtime: IAgentRuntime, securityModule: any): Promise<void> {
    this.securityModule = securityModule;
    logger.info('[CredentialProtector] Initialized');
  }

  async stop(): Promise<void> {
    logger.info('[CredentialProtector] Stopped');
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CredentialProtector();
    const securityModule = runtime.getService('security-module');
    await service.initialize(runtime, securityModule);
    return service;
  }

  /**
   * Scan message for credential theft attempts
   */
  async scanForCredentialTheft(
    message: string,
    entityId: UUID,
    context: SecurityContext
  ): Promise<CredentialThreatDetection> {
    // Use LLM evaluator if available
    const llmEvaluator = this.runtime?.getService?.('llm-evaluator');
    if (llmEvaluator) {
      const securityCheck = await (llmEvaluator as any).evaluateSecurityThreat(
        message,
        { ...context, entityId, requestedAction: 'credential_request' },
        []
      );

      if (securityCheck.detected && securityCheck.type === 'credential_theft') {
        return {
          detected: true,
          confidence: securityCheck.confidence,
          threatType: 'credential_request',
          sensitiveData: ['credentials'], // LLM doesn't specify exact types
          recommendation: securityCheck.details || 'Block message and investigate',
        };
      }
    }

    // Fallback to pattern-based detection
    const lowercaseMessage = message.toLowerCase();

    // Check if it's in a legitimate context first
    if (this.isLegitimateContext(lowercaseMessage)) {
      return {
        detected: false,
        confidence: 0,
        threatType: 'none',
        sensitiveData: [],
        recommendation: 'Message appears to be in legitimate context',
      };
    }

    // Detect sensitive data mentions
    const detectedSensitive = this.detectSensitiveData(message);

    // Check for theft request patterns
    const hasTheftRequest = this.THEFT_REQUEST_PATTERNS.some((pattern) =>
      pattern.test(lowercaseMessage)
    );

    if (detectedSensitive.length > 0 && hasTheftRequest) {
      // High confidence credential theft attempt
      const confidence = Math.min(0.8 + detectedSensitive.length * 0.05, 1);

      await this.logThreatEvent(entityId, message, detectedSensitive, confidence, context);

      return {
        detected: true,
        confidence,
        threatType: 'credential_request',
        sensitiveData: detectedSensitive,
        recommendation: 'Block message, warn potential victims, consider immediate action',
      };
    }

    // Check for phishing indicators
    if (detectedSensitive.length > 0 && this.hasPhishingIndicators(lowercaseMessage)) {
      const confidence = 0.7;

      await this.logThreatEvent(entityId, message, detectedSensitive, confidence, context);

      return {
        detected: true,
        confidence,
        threatType: 'phishing',
        sensitiveData: detectedSensitive,
        recommendation: 'Likely phishing attempt. Quarantine and investigate',
      };
    }

    // Low confidence but still suspicious
    if (detectedSensitive.length > 0) {
      return {
        detected: true,
        confidence: 0.4,
        threatType: 'social_engineering',
        sensitiveData: detectedSensitive,
        recommendation: 'Monitor user activity for additional suspicious behavior',
      };
    }

    return {
      detected: false,
      confidence: 0,
      threatType: 'none',
      sensitiveData: [],
      recommendation: 'No credential threats detected',
    };
  }

  /**
   * Protect sensitive data by redacting it
   */
  async protectSensitiveData(content: string): Promise<string> {
    let protectedContent = content;

    // Redact sensitive patterns
    for (const { pattern, type } of this.SENSITIVE_PATTERNS) {
      protectedContent = protectedContent.replace(pattern, `[REDACTED:${type}]`);
    }

    // Redact potential tokens (long alphanumeric strings)
    protectedContent = protectedContent.replace(
      /\b[A-Za-z0-9]{32,}\b/g,
      '[REDACTED:potential_token]'
    );

    // Redact credit card patterns
    protectedContent = protectedContent.replace(
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      '[REDACTED:credit_card_number]'
    );

    // Redact SSN patterns
    protectedContent = protectedContent.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED:ssn]');

    return protectedContent;
  }

  /**
   * Alert potential victims of credential theft
   */
  async alertPotentialVictims(
    threatActor: UUID,
    victims: UUID[],
    threatDetails: CredentialThreatDetection
  ): Promise<void> {
    for (const victimId of victims) {
      await this.runtime.log({
        entityId: victimId,
        roomId: this.runtime.agentId,
        type: 'security_alert',
        body: {
          alertType: 'credential_theft_warning',
          threatActor,
          message:
            '⚠️ Security Alert: Someone attempted to request your credentials. Never share passwords, tokens, or seed phrases with anyone.',
          threatDetails: {
            confidence: threatDetails.confidence,
            sensitiveDataRequested: threatDetails.sensitiveData,
          },
          timestamp: Date.now(),
        },
      });
    }

    logger.info(
      `[CredentialProtector] Alerted ${victims.length} potential victims of credential theft attempt by ${threatActor}`
    );
  }

  /**
   * Analyze a conversation for credential theft patterns
   */
  async analyzeConversation(
    messages: Array<{ entityId: UUID; content: string; timestamp: number }>,
    context: SecurityContext
  ): Promise<{
    overallThreat: number;
    suspiciousEntities: UUID[];
    recommendations: string[];
  }> {
    const entityThreats = new Map<UUID, number>();
    const detectedThreats: CredentialThreatDetection[] = [];

    // Analyze each message
    for (const message of messages) {
      const threat = await this.scanForCredentialTheft(message.content, message.entityId, context);

      if (threat.detected) {
        detectedThreats.push(threat);
        const currentThreat = entityThreats.get(message.entityId) || 0;
        entityThreats.set(message.entityId, Math.max(currentThreat, threat.confidence));
      }
    }

    // Calculate overall threat
    const overallThreat =
      detectedThreats.length > 0
        ? detectedThreats.reduce((sum, t) => sum + t.confidence, 0) / detectedThreats.length
        : 0;

    // Identify suspicious entities
    const suspiciousEntities = Array.from(entityThreats.entries())
      .filter(([, threat]) => threat > 0.5)
      .map(([entity]) => entity);

    // Generate recommendations
    const recommendations: string[] = [];
    if (overallThreat > 0.8) {
      recommendations.push(
        'Immediate action required: Multiple credential theft attempts detected'
      );
      recommendations.push('Consider temporary channel lockdown');
      recommendations.push('Alert all users about ongoing credential theft campaign');
    } else if (overallThreat > 0.5) {
      recommendations.push('Elevated threat level: Monitor closely for escalation');
      recommendations.push('Warn users about potential credential theft attempts');
    } else if (overallThreat > 0.2) {
      recommendations.push('Low-level threat detected: Continue monitoring');
    }

    return {
      overallThreat,
      suspiciousEntities,
      recommendations,
    };
  }

  /**
   * Private helper methods
   */

  private detectSensitiveData(message: string): string[] {
    const detected: string[] = [];
    const lowercaseMessage = message.toLowerCase();

    for (const { pattern, type } of this.SENSITIVE_PATTERNS) {
      if (pattern.test(lowercaseMessage)) {
        detected.push(type);
      }
    }

    // Remove duplicates
    return Array.from(new Set(detected));
  }

  private isLegitimateContext(message: string): boolean {
    return this.LEGITIMATE_CONTEXTS.some((pattern) => pattern.test(message));
  }

  private hasPhishingIndicators(message: string): boolean {
    const phishingKeywords = [
      'urgent',
      'verify account',
      'suspended',
      'click here',
      'limited time',
      'act now',
      'confirm identity',
    ];

    return phishingKeywords.some((keyword) => message.includes(keyword));
  }

  private async logThreatEvent(
    entityId: UUID,
    message: string,
    sensitiveData: string[],
    confidence: number,
    context: SecurityContext
  ): Promise<void> {
    if (this.securityModule) {
      await this.securityModule.logSecurityEvent({
        type: SecurityEventType.CREDENTIAL_THEFT_ATTEMPT,
        entityId,
        severity: confidence > 0.8 ? 'critical' : 'high',
        context,
        details: {
          message: await this.protectSensitiveData(message),
          sensitiveDataTypes: sensitiveData,
          confidence,
        },
      });
    }
  }
}
