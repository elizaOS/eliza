import { logger } from '@elizaos/core';
import { createHash } from 'crypto';
import type { VerificationResult, ScenarioContext } from './types.js';

export interface SecurityConfig {
  useLocalLLM: boolean;
  dataAnonymization: boolean;
  auditLogging: boolean;
  encryptSensitiveData: boolean;
  allowExternalLLM: boolean;
}

export interface DataClassification {
  level: 'public' | 'internal' | 'confidential' | 'secret';
  patterns: RegExp[];
  maskingStrategy: 'redact' | 'hash' | 'synthetic' | 'none';
}

export class SecureVerificationEngine {
  private dataClassifiers: DataClassification[] = [
    {
      level: 'secret',
      patterns: [
        /api[_-]?key[s]?[:\s=]+[\w\-]{10,}/i,
        /password[s]?[:\s=]+\S+/i,
        /token[s]?[:\s=]+[\w\-\.]{20,}/i,
        /secret[s]?[:\s=]+\S+/i,
      ],
      maskingStrategy: 'redact',
    },
    {
      level: 'confidential',
      patterns: [
        /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/, // Credit card
        /\b\d{3}-\d{2}-\d{4}\b/, // SSN
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // Email
      ],
      maskingStrategy: 'hash',
    },
    {
      level: 'internal',
      patterns: [
        /\/[a-z]+\/[a-z]+\/[a-z0-9\-]+/i, // File paths
        /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}/i, // URLs
      ],
      maskingStrategy: 'synthetic',
    },
  ];

  constructor(private config: SecurityConfig) {}

  async secureVerify(rule: any, context: ScenarioContext): Promise<VerificationResult> {
    // Step 1: Classify and sanitize data
    const sanitizedContext = this.sanitizeContext(context);

    // Step 2: Choose verification method based on security requirements
    const dataLevel = this.classifyDataSensitivity(context);

    if (dataLevel === 'secret' || dataLevel === 'confidential') {
      // Use only local/deterministic verification for sensitive data
      return this.localVerification(rule, sanitizedContext);
    }

    if (this.config.useLocalLLM) {
      return this.localLLMVerification(rule, sanitizedContext);
    }

    if (this.config.allowExternalLLM && dataLevel === 'public') {
      return this.externalLLMVerification(rule, sanitizedContext);
    }

    // Fallback to deterministic verification
    return this.localVerification(rule, sanitizedContext);
  }

  private sanitizeContext(context: ScenarioContext): ScenarioContext {
    if (!this.config.dataAnonymization) {
      return context;
    }

    const sanitizedTranscript = context.transcript.map((message) => ({
      ...message,
      content: {
        ...message.content,
        text: this.sanitizeText(message.content?.text || ''),
      },
    }));

    return {
      ...context,
      transcript: sanitizedTranscript,
    };
  }

  private sanitizeText(text: string): string {
    let sanitized = text;

    for (const classifier of this.dataClassifiers) {
      for (const pattern of classifier.patterns) {
        const matches = text.match(pattern);
        if (matches) {
          for (const match of matches) {
            const replacement = this.applyMaskingStrategy(match, classifier.maskingStrategy);
            sanitized = sanitized.replace(match, replacement);

            if (this.config.auditLogging) {
              this.auditLog({
                action: 'data_sanitization',
                level: classifier.level,
                strategy: classifier.maskingStrategy,
                originalLength: match.length,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      }
    }

    return sanitized;
  }

  private applyMaskingStrategy(text: string, strategy: string): string {
    switch (strategy) {
      case 'redact':
        return '[REDACTED]';

      case 'hash':
        const hash = createHash('sha256').update(text).digest('hex').substring(0, 8);
        return `[HASH:${hash}]`;

      case 'synthetic':
        // Generate realistic but fake replacement
        if (text.includes('@')) {
          return 'user@example.com';
        }
        if (text.includes('/')) {
          return '/path/to/file';
        }
        if (text.includes('http')) {
          return 'https://example.com';
        }
        return '[SYNTHETIC]';

      default:
        return text;
    }
  }

  private classifyDataSensitivity(context: ScenarioContext): DataClassification['level'] {
    const allText = context.transcript.map((msg) => msg.content?.text || '').join(' ');

    // Check against classifiers, return highest sensitivity level found
    for (const classifier of this.dataClassifiers) {
      for (const pattern of classifier.patterns) {
        if (pattern.test(allText)) {
          return classifier.level;
        }
      }
    }

    return 'public';
  }

  private async localVerification(
    rule: any,
    context: ScenarioContext
  ): Promise<VerificationResult> {
    // Implement fully local verification without any external calls
    logger.debug('Using local verification for security compliance');

    // Example: Simple keyword-based verification
    const keywords = rule.config.requiredKeywords || [];
    const transcript = context.transcript
      .map((msg) => msg.content?.text || '')
      .join(' ')
      .toLowerCase();

    const foundKeywords = keywords.filter((keyword: string) =>
      transcript.includes(keyword.toLowerCase())
    );

    const passed = foundKeywords.length === keywords.length;

    return {
      ruleId: rule.id,
      passed,
      score: passed ? 1.0 : foundKeywords.length / keywords.length,
      reason: `Found ${foundKeywords.length}/${keywords.length} required keywords`,
      ruleName: rule.description || rule.id,
      evidence: foundKeywords,
    };
  }

  private async localLLMVerification(
    rule: any,
    context: ScenarioContext
  ): Promise<VerificationResult> {
    // Use local LLM (e.g., Ollama, LocalAI) for verification
    logger.debug('Using local LLM verification');

    try {
      // Example: Call to local LLM endpoint
      const response = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama2',
          prompt: this.createSecurePrompt(rule, context),
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Local LLM error: ${response.statusText}`);
      }

      const result = await response.json();
      return this.parseSecureLLMResponse(rule.id, result.response);
    } catch (error) {
      logger.warn('Local LLM verification failed, falling back to deterministic:', error);
      return this.localVerification(rule, context);
    }
  }

  private async externalLLMVerification(
    rule: any,
    context: ScenarioContext
  ): Promise<VerificationResult> {
    // Only for public data with explicit consent
    logger.debug('Using external LLM verification (public data only)');

    const dataLevel = this.classifyDataSensitivity(context);
    if (dataLevel !== 'public') {
      throw new Error('Cannot use external LLM for non-public data');
    }

    // Proceed with external LLM call...
    // Implementation would go here
    return this.localVerification(rule, context);
  }

  private createSecurePrompt(rule: any, context: ScenarioContext): string {
    const transcript = context.transcript
      .map((msg, i) => `[${i + 1}] ${msg.actorId}: ${msg.content?.text || ''}`)
      .join('\n');

    return `Analyze this conversation for: ${rule.description}

TRANSCRIPT:
${transcript}

Respond with only:
RESULT: PASS or FAIL
SCORE: 0.0 to 1.0
REASON: brief explanation

No additional text.`;
  }

  private parseSecureLLMResponse(ruleId: string, response: string): VerificationResult {
    const lines = response.split('\n');
    let passed = false;
    let score = 0;
    let reasoning = 'No reasoning provided';

    for (const line of lines) {
      if (line.startsWith('RESULT:')) {
        passed = line.includes('PASS');
      } else if (line.startsWith('SCORE:')) {
        score = parseFloat(line.split(':')[1]?.trim() || '0');
      } else if (line.startsWith('REASON:')) {
        reasoning = line.split(':')[1]?.trim() || reasoning;
      }
    }

    return {
      ruleId,
      passed,
      score,
      reason: reasoning,
      ruleName: ruleId,
      evidence: [],
    };
  }

  private auditLog(event: any): void {
    if (!this.config.auditLogging) return;

    // In production, this would write to secure audit log
    logger.info('AUDIT:', JSON.stringify(event));
  }

  // Security health check
  async validateSecurityCompliance(): Promise<{
    compliant: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    if (!this.config.useLocalLLM && !this.config.allowExternalLLM) {
      issues.push('No LLM verification method enabled');
    }

    if (!this.config.dataAnonymization) {
      recommendations.push('Enable data anonymization for enhanced privacy');
    }

    if (!this.config.auditLogging) {
      recommendations.push('Enable audit logging for compliance tracking');
    }

    if (this.config.allowExternalLLM) {
      recommendations.push('Consider using local LLM only for maximum security');
    }

    return {
      compliant: issues.length === 0,
      issues,
      recommendations,
    };
  }
}
