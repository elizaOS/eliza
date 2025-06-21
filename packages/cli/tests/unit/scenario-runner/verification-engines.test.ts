import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HybridVerificationEngine } from '../../../src/scenario-runner/hybrid-verification.js';
import { ExplainableVerificationEngine } from '../../../src/scenario-runner/explainable-verification.js';
import { SecureVerificationEngine } from '../../../src/scenario-runner/secure-verification.js';
import { VersionedVerificationEngine } from '../../../src/scenario-runner/versioned-verification.js';
import { PerformanceOptimizer } from '../../../src/scenario-runner/performance-optimizations.js';
import type {
  ScenarioContext,
  VerificationRule,
  VerificationResult,
} from '../../../src/scenario-runner/types.js';
import type { IAgentRuntime, UUID } from '@elizaos/core';

describe('HybridVerificationEngine', () => {
  let runtime: IAgentRuntime;
  let engine: HybridVerificationEngine;
  let mockContext: ScenarioContext;
  let mockRule: VerificationRule;

  beforeEach(() => {
    runtime = {
      agentId: 'test-agent' as UUID,
      generateText: vi.fn().mockResolvedValue('PASSED: Test passed successfully'),
    } as any;

    engine = new HybridVerificationEngine(runtime);

    mockContext = {
      scenario: {
        id: 'test-scenario',
        name: 'Test Scenario',
        description: 'Test',
        actors: [],
        setup: {},
        execution: {},
        verification: { rules: [] },
      },
      transcript: [
        {
          actorId: 'actor1',
          content: { text: 'Hello world' },
          timestamp: new Date().toISOString(),
          responseTime: 100,
        },
        {
          actorId: 'actor2',
          content: { text: 'Response message' },
          timestamp: new Date().toISOString(),
          responseTime: 150,
        },
      ],
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    } as any;

    mockRule = {
      id: 'test-rule',
      type: 'llm',
      description: 'Test rule',
      config: {
        deterministicType: 'message_count',
        minMessages: 2,
        maxMessages: 10,
      },
    };
  });

  describe('verify', () => {
    it('should run deterministic verification first', async () => {
      const results = await engine.verify([mockRule], mockContext);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].reason).toContain('Expected 2-10 messages, got 2');
    });

    it('should enhance with LLM when enabled', async () => {
      mockRule.config.llmEnhancement = true;
      vi.mocked(runtime).useModel = vi.fn().mockResolvedValue('Enhanced result');
      const results = await engine.verify([mockRule], mockContext);

      expect(results).toHaveLength(1);
    });

    it('should handle message count verification', async () => {
      // Test below minimum
      mockContext.transcript = [];
      let results = await engine.verify([mockRule], mockContext);
      expect(results[0].passed).toBe(false);

      // Test within range
      mockContext.transcript = Array(5).fill({
        actorId: 'test',
        content: { text: 'test' },
        timestamp: new Date().toISOString(),
      });
      results = await engine.verify([mockRule], mockContext);
      expect(results[0].passed).toBe(true);

      // Test above maximum
      mockContext.transcript = Array(15).fill({
        actorId: 'test',
        content: { text: 'test' },
        timestamp: new Date().toISOString(),
      });
      results = await engine.verify([mockRule], mockContext);
      expect(results[0].passed).toBe(false);
    });

    it('should verify response time requirements', async () => {
      mockRule.config.deterministicType = 'response_time';
      mockRule.config.maxResponseTimeMs = 200;

      const results = await engine.verify([mockRule], mockContext);

      expect(results[0].passed).toBe(true);
      expect(results[0].reason).toContain('Average response time');
    });

    it('should verify keyword presence', async () => {
      mockRule.config.deterministicType = 'keyword_presence';
      mockRule.config.requiredKeywords = ['hello', 'world'];
      mockRule.config.forbiddenKeywords = ['error'];

      const results = await engine.verify([mockRule], mockContext);

      expect(results[0].passed).toBe(true);
    });

    it('should cache deterministic results', async () => {
      // First call
      await engine.verify([mockRule], mockContext);

      // Second call with same context should use cache
      const results = await engine.verify([mockRule], mockContext);

      expect(results[0].passed).toBe(true);
    });
  });
});

describe('ExplainableVerificationEngine', () => {
  let engine: ExplainableVerificationEngine;
  let mockContext: ScenarioContext;
  let mockRule: VerificationRule;

  beforeEach(() => {
    engine = new ExplainableVerificationEngine({
      includeStepByStep: true,
      includeCounterExamples: true,
      includeFixSuggestions: true,
      includeDataFlow: true,
      verbosityLevel: 'detailed',
    });

    mockContext = {
      scenario: {
        id: 'test-scenario',
        name: 'Test Scenario',
        description: 'Test',
        actors: [],
        setup: {},
        execution: {},
        verification: { rules: [] },
      },
      transcript: [
        {
          actorId: 'actor1',
          content: { text: 'Test message' },
          timestamp: new Date().toISOString(),
        },
      ],
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    } as any;

    mockRule = {
      id: 'test-rule',
      type: 'llm',
      description: 'Test rule',
      config: {
        deterministicType: 'message_count',
        minMessages: 5,
        maxMessages: 10,
      },
    };
  });

  describe('explainableVerify', () => {
    it('should include decision path', async () => {
      const result = await engine.explainableVerify(mockRule, mockContext);

      expect(result.explanation.decisionPath).toHaveLength(3);
      expect(result.explanation.decisionPath[0].description).toBe('Rule Analysis');
    });

    it('should include data flow tracking', async () => {
      const result = await engine.explainableVerify(mockRule, mockContext);

      expect(result.explanation.dataFlow).toHaveLength(1);
      expect(result.explanation.dataFlow[0].stage).toBe('preprocessing');
    });

    it('should generate counter examples', async () => {
      const result = await engine.explainableVerify(mockRule, mockContext);

      expect(result.explanation.counterExamples).toHaveLength(1);
      expect(result.explanation.counterExamples[0].whatWouldMakeItPass).toContain(
        'between 5 and 10 messages'
      );
    });

    it('should provide fix suggestions', async () => {
      const result = await engine.explainableVerify(mockRule, mockContext);

      expect(result.explanation.fixSuggestions.length).toBeGreaterThan(0);
      expect(result.explanation.fixSuggestions[0].type).toBeDefined();
      expect(result.explanation.fixSuggestions[0].implementation).toBeDefined();
    });

    it('should analyze confidence factors', async () => {
      const result = await engine.explainableVerify(mockRule, mockContext);

      expect(result.explanation.confidenceFactors.length).toBeGreaterThan(0);
      expect(result.explanation.confidenceFactors[0].factor).toBeDefined();
      expect(result.explanation.confidenceFactors[0].impact).toMatch(/positive|negative|neutral/);
    });
  });
});

describe('SecureVerificationEngine', () => {
  let engine: SecureVerificationEngine;
  let mockContext: ScenarioContext;
  let mockRule: VerificationRule;

  beforeEach(() => {
    engine = new SecureVerificationEngine({
      useLocalLLM: true,
      dataAnonymization: true,
      auditLogging: true,
      encryptSensitiveData: true,
      allowExternalLLM: false,
    });

    mockContext = {
      scenario: {
        id: 'test-scenario',
        name: 'Test Scenario',
        description: 'Test',
        actors: [],
        setup: {},
        execution: {},
        verification: { rules: [] },
      },
      transcript: [
        {
          actorId: 'actor1',
          content: { text: 'My API key is sk-1234567890 and password is secret123' },
          timestamp: new Date().toISOString(),
        },
        {
          actorId: 'actor2',
          content: { text: 'Email: user@example.com' },
          timestamp: new Date().toISOString(),
        },
      ],
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    } as any;

    mockRule = {
      id: 'test-rule',
      type: 'llm',
      description: 'Test rule',
      config: {},
    };
  });

  describe('secureVerify', () => {
    it('should sanitize sensitive data', async () => {
      const result = await engine.secureVerify(mockRule, mockContext);

      // The actual verification will be deterministic due to sensitive data
      expect(result).toBeDefined();
      expect(result.passed).toBeDefined();
    });

    it('should classify data sensitivity levels', async () => {
      // Test secret level (API keys)
      expect(engine['classifyDataSensitivity'](mockContext)).toBe('secret');

      // Test confidential level (email)
      mockContext.transcript = [
        {
          actorId: 'test',
          content: { text: 'Contact me at user@example.com' },
          timestamp: new Date().toISOString(),
        } as any,
      ];
      expect(engine['classifyDataSensitivity'](mockContext)).toBe('confidential');

      // Test public level
      mockContext.transcript = [
        {
          actorId: 'test',
          content: { text: 'Hello world' },
          timestamp: new Date().toISOString(),
        } as any,
      ];
      expect(engine['classifyDataSensitivity'](mockContext)).toBe('public');
    });

    it('should apply different masking strategies', async () => {
      const text = 'API key: sk-12345, email: test@example.com, path: /home/user';
      const sanitized = engine['sanitizeText'](text);

      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).toContain('[HASH:');
      expect(sanitized).not.toContain('sk-12345');
      expect(sanitized).not.toContain('test@example.com');
    });

    it('should validate security compliance', async () => {
      const compliance = await engine.validateSecurityCompliance();

      expect(compliance.compliant).toBeDefined();
      expect(compliance.issues).toBeInstanceOf(Array);
      expect(compliance.recommendations).toBeInstanceOf(Array);
    });
  });
});

describe('VersionedVerificationEngine', () => {
  let engine: VersionedVerificationEngine;
  let mockContext: ScenarioContext;
  let mockRule: VerificationRule;
  let mockResult: VerificationResult;

  beforeEach(() => {
    engine = new VersionedVerificationEngine('./test-snapshots');

    mockContext = {
      scenario: {
        id: 'test-scenario',
        name: 'Test Scenario',
        description: 'Test',
        actors: [],
        setup: {},
        execution: {},
        verification: { rules: [] },
      },
      transcript: [
        {
          actorId: 'actor1',
          content: { text: 'Test message' },
          timestamp: new Date().toISOString(),
        },
      ],
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    } as any;

    mockRule = {
      id: 'test-rule',
      type: 'llm',
      description: 'Test rule',
      config: {},
    };

    mockResult = {
      ruleId: 'test-rule',
      ruleName: 'Test Rule',
      passed: true,
      score: 0.9,
      reason: 'Test passed',
    };
  });

  afterEach(async () => {
    // Clean up test snapshots
    const fs = await import('fs/promises');
    try {
      await fs.rm('./test-snapshots', { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  });

  describe('versioning operations', () => {
    it('should initialize versioning system', async () => {
      await engine.initializeVersioning();

      const fs = await import('fs/promises');
      const versionData = await fs.readFile('./test-snapshots/versions.json', 'utf8');
      const versions = JSON.parse(versionData);

      expect(versions).toHaveLength(1);
      expect(versions[0].version).toBe('1.0.0');
    });

    it('should create snapshots', async () => {
      await engine.initializeVersioning();
      const snapshotFile = await engine.createSnapshot(mockRule, mockContext, mockResult);

      expect(snapshotFile).toContain('test-rule');
      expect(snapshotFile).toContain('1.0.0');
    });

    it('should validate against snapshots', async () => {
      await engine.initializeVersioning();
      await engine.createSnapshot(mockRule, mockContext, mockResult);

      const validation = await engine.validateAgainstSnapshots(mockRule, mockContext, mockResult);

      expect(validation.isValid).toBe(true);
      expect(validation.differences).toHaveLength(0);
      expect(validation.matchingSnapshots.length).toBeGreaterThan(0);
    });

    it('should detect regressions', async () => {
      await engine.initializeVersioning();
      await engine.createSnapshot(mockRule, mockContext, mockResult);

      const failingResult = { ...mockResult, passed: false, score: 0.3 };
      const validation = await engine.validateAgainstSnapshots(
        mockRule,
        mockContext,
        failingResult
      );

      expect(validation.regressions.length).toBeGreaterThan(0);
      expect(validation.regressions[0]).toContain('was passing');
    });

    it('should create new versions', async () => {
      await engine.initializeVersioning();
      await engine.createNewVersion('1.1.0', 'Test update', [
        {
          type: 'modified',
          component: 'test',
          description: 'Test change',
          impact: 'non-breaking',
        },
      ]);

      const fs = await import('fs/promises');
      const versionData = await fs.readFile('./test-snapshots/versions.json', 'utf8');
      const versions = JSON.parse(versionData);

      expect(versions).toHaveLength(2);
      expect(versions[1].version).toBe('1.1.0');
    });
  });
});

describe('PerformanceOptimizer', () => {
  let optimizer: PerformanceOptimizer;

  beforeEach(() => {
    optimizer = new PerformanceOptimizer(
      {
        enabled: true,
        ttlMs: 60000,
        maxSize: 100,
      },
      {
        enabled: true,
        maxBatchSize: 5,
        batchTimeoutMs: 50,
      }
    );
  });

  describe('caching', () => {
    it('should cache computation results', async () => {
      const compute = vi.fn().mockResolvedValue('result');

      // First call - compute
      const result1 = await optimizer.getFromCacheOrCompute('test-key', compute);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(result1).toBe('result');

      // Second call - from cache
      const result2 = await optimizer.getFromCacheOrCompute('test-key', compute);
      expect(compute).toHaveBeenCalledTimes(1); // Not called again
      expect(result2).toBe('result');
    });

    it('should evict old entries when cache is full', async () => {
      const smallOptimizer = new PerformanceOptimizer({
        enabled: true,
        ttlMs: 60000,
        maxSize: 3,
      });

      // Fill cache
      await smallOptimizer.getFromCacheOrCompute('key1', () => 'result1');
      await smallOptimizer.getFromCacheOrCompute('key2', () => 'result2');
      await smallOptimizer.getFromCacheOrCompute('key3', () => 'result3');

      // This should trigger eviction
      await smallOptimizer.getFromCacheOrCompute('key4', () => 'result4');

      const stats = smallOptimizer.getCacheStats();
      expect(stats.size).toBeLessThanOrEqual(3);
    });
  });

  describe('batching', () => {
    it('should batch multiple LLM verifications', async () => {
      const mockContext: ScenarioContext = {
        scenario: { id: 'test', name: 'Test' },
        transcript: [],
      } as any;

      const promises = [];
      for (let i = 0; i < 3; i++) {
        promises.push(
          optimizer.batchLLMVerification({ id: `rule${i}`, description: `Rule ${i}` }, mockContext)
        );
      }

      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);
      expect(results[0].ruleId).toBe('rule0');
    });

    it('should process batch when timeout is reached', async () => {
      const mockContext: ScenarioContext = {
        scenario: { id: 'test', name: 'Test' },
        transcript: [],
      } as any;

      const result = await optimizer.batchLLMVerification(
        { id: 'single-rule', description: 'Single Rule' },
        mockContext
      );

      expect(result.ruleId).toBe('single-rule');
    });
  });
});
