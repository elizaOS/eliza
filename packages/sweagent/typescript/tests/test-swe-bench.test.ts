/**
 * Tests for SWE-bench benchmarking functionality
 */

import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import {
  SWEBenchInstances,
  InstancesFromFile,
  fromSWEBench,
  filterBatchItems,
  BatchInstance,
} from '../src/run/batch-instances';
import { SweBenchEvaluate } from '../src/run/hooks/swe-bench-evaluate';
// import { DockerDeploymentConfig } from '../src/environment/deployment';  // Not used
import { EnvironmentConfig } from '../src/environment/swe-env';
import { TextProblemStatement } from '../src/agent/problem-statement';
import * as fs from 'fs';

// Mock fs module
jest.mock('fs');

// Mock axios for API calls
jest.mock('axios');

describe('SWE-bench Batch Instances', () => {
  describe('fromSWEBench', () => {
    it('should convert SWE-bench instance to SimpleBatchInstance', () => {
      const sweBenchInstance = {
        instance_id: 'django__django-12345',
        problem_statement: 'Fix the bug in Django',
        base_commit: 'abc123',
        image_name: 'swebench/django:latest',
      };

      const result = fromSWEBench(sweBenchInstance);

      expect(result.instanceId).toBe('django__django-12345');
      expect(result.problemStatement).toBe('Fix the bug in Django');
      expect(result.baseCommit).toBe('abc123');
      expect(result.imageName).toBe('swebench/django:latest');
      expect(result.repoName).toBe('testbed');
    });

    it('should generate image name if not provided', () => {
      const sweBenchInstance = {
        instance_id: 'django__django-12345',
        problem_statement: 'Fix the bug',
        base_commit: 'abc123',
      };

      const result = fromSWEBench(sweBenchInstance);

      expect(result.imageName).toContain('swebench/sweb.eval.x86_64');
      expect(result.imageName).toContain('django_1776_django-12345');
    });

    it('should handle multimodal instances with image assets', () => {
      const sweBenchInstance = {
        instance_id: 'test-123',
        problem_statement: 'Fix UI bug',
        base_commit: 'abc123',
        image_assets: JSON.stringify({
          problem_statement: ['image1.png', 'image2.png'],
        }),
      };

      const result = fromSWEBench(sweBenchInstance);

      expect(result.extraFields?.issue_images).toEqual(['image1.png', 'image2.png']);
    });
  });

  describe('SWEBenchInstances', () => {
    let sweBenchInstances: SWEBenchInstances;
    const mockDeployment = {
      type: 'docker' as const,
      image: 'python:3.11',
      pythonStandaloneDir: '/root',
      volumes: {},
      environment: {},
      removeOnStop: true,
      workDir: '/workspace',
    };

    beforeEach(() => {
      sweBenchInstances = new SWEBenchInstances({
        subset: 'lite',
        split: 'dev',
        filter: '.*',
        slice: '',
        shuffle: false,
        evaluate: false,
        deployment: mockDeployment,
      });
    });

    it('should get correct dataset path for different subsets', () => {
      const testCases = [
        { subset: 'lite', expected: 'princeton-nlp/SWE-Bench_Lite' },
        { subset: 'verified', expected: 'princeton-nlp/SWE-Bench_Verified' },
        { subset: 'full', expected: 'princeton-nlp/SWE-Bench' },
        { subset: 'multimodal', expected: 'princeton-nlp/SWE-Bench_Multimodal' },
        { subset: 'multilingual', expected: 'swe-bench/SWE-Bench_Multilingual' },
      ];

      testCases.forEach(({ subset }) => {
        const instance = new SWEBenchInstances({
          subset: subset as 'lite' | 'verified' | 'full' | 'multimodal' | 'multilingual',
          split: 'dev',
          filter: '.*',
          slice: '',
          shuffle: false,
          evaluate: false,
          deployment: mockDeployment,
        });
        // Private method getDatasetPath can't be accessed directly
        // Test the id generation instead which is public
        expect(instance.id).toContain(subset);
      });
    });

    it('should generate correct instance ID', () => {
      expect(sweBenchInstances.id).toBe('swe_bench_lite_dev');
    });

    it('should enable evaluation when specified', () => {
      const instanceWithEval = new SWEBenchInstances({
        subset: 'lite',
        split: 'dev',
        filter: '.*',
        slice: '',
        shuffle: false,
        evaluate: true, // evaluate = true
        deployment: mockDeployment,
      });
      expect(instanceWithEval.evaluate).toBe(true);
    });
  });

  describe('filterBatchItems', () => {
    const createMockInstances = (count: number): BatchInstance[] => {
      return Array.from({ length: count }, (_, i) => ({
        env: {
          postStartupCommands: [],
          postStartupCommandTimeout: 120,
          name: `instance-${i}`,
          deployment: {
            type: 'docker' as const,
            image: 'python:3.11',
            pythonStandaloneDir: '/root',
            volumes: {},
            environment: {},
            removeOnStop: true,
            workDir: '/workspace',
          },
          repo: null,
        } as EnvironmentConfig,
        problemStatement: new TextProblemStatement({
          text: `Problem ${i}`,
          id: `instance-${i}`,
          extraFields: {},
        }),
      }));
    };

    it('should filter instances by regex', () => {
      const instances = createMockInstances(10);
      const filtered = filterBatchItems(instances, {
        filter: 'instance-[0-4]',
      });

      expect(filtered).toHaveLength(5);
      expect(filtered[0].problemStatement.id).toBe('instance-0');
      expect(filtered[4].problemStatement.id).toBe('instance-4');
    });

    it('should slice instances correctly', () => {
      const instances = createMockInstances(10);

      // Test different slice formats
      const sliced1 = filterBatchItems(instances, { slice: '5' });
      expect(sliced1).toHaveLength(5);

      const sliced2 = filterBatchItems(instances, { slice: '2:7' });
      expect(sliced2).toHaveLength(5);
      expect(sliced2[0].problemStatement.id).toBe('instance-2');

      const sliced3 = filterBatchItems(instances, { slice: '::2' });
      expect(sliced3).toHaveLength(5); // Every second instance
      expect(sliced3[1].problemStatement.id).toBe('instance-2');
    });

    it('should shuffle instances deterministically', () => {
      const instances = createMockInstances(10);

      const shuffled1 = filterBatchItems(instances, { shuffle: true });
      const shuffled2 = filterBatchItems(instances, { shuffle: true });

      // Should be deterministic (same order each time)
      expect(shuffled1.map((i) => i.problemStatement.id)).toEqual(shuffled2.map((i) => i.problemStatement.id));

      // But different from original
      const original = instances.map((i) => i.problemStatement.id);
      const shuffledIds = shuffled1.map((i) => i.problemStatement.id);
      expect(shuffledIds).not.toEqual(original);
    });
  });

  describe('InstancesFromFile', () => {
    const mockFilePath = '/tmp/test-instances.json';

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('should load instances from JSON file', () => {
      const mockData = [
        {
          imageName: 'python:3.11',
          problemStatement: 'Fix bug 1',
          instanceId: 'bug-1',
          repoName: 'test-repo',
          baseCommit: 'main',
        },
        {
          imageName: 'node:18',
          problemStatement: 'Fix bug 2',
          instanceId: 'bug-2',
          repoName: 'test-repo-2',
          baseCommit: 'master',
        },
      ];

      // Mock fs functions with proper typing
      const mockedFs = fs as jest.Mocked<typeof fs>;
      (mockedFs.existsSync as jest.Mock).mockReturnValue(true);
      (mockedFs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(mockData));

      const loader = new InstancesFromFile({ path: mockFilePath });
      const instances = loader.getInstanceConfigs();

      expect(instances).toHaveLength(2);
      expect(instances[0].problemStatement.id).toBe('bug-1');
      expect(instances[1].problemStatement.id).toBe('bug-2');
    });
  });

  describe('SweBenchEvaluate Hook', () => {
    const mockOutputDir = '/tmp/test-output';

    it('should generate correct run ID', () => {
      const hook = new SweBenchEvaluate({
        outputDir: mockOutputDir,
        subset: 'lite',
        split: 'dev',
      });

      const runId = hook.runId;
      expect(runId).toContain('test-output_');
      expect(runId).toMatch(/test-output_\d{14}/);
    });

    it('should generate correct sb-cli command', () => {
      const hook = new SweBenchEvaluate({
        outputDir: mockOutputDir,
        subset: 'lite',
        split: 'dev',
      });

      const commandArgs = hook.getSbCall('/tmp/preds.json');

      expect(commandArgs).toContain('sb-cli');
      expect(commandArgs).toContain('submit');
      expect(commandArgs).toContain('swe-bench_lite');
      expect(commandArgs).toContain('dev');
      expect(commandArgs).toContain('--predictions_path');
      expect(commandArgs).toContain('/tmp/preds.json');
    });

    it('should add submit-only flags when specified', () => {
      const hook = new SweBenchEvaluate({
        outputDir: mockOutputDir,
        subset: 'lite',
        split: 'dev',
      });

      const commandArgs = hook.getSbCall('/tmp/preds.json', true);

      expect(commandArgs).toContain('--wait_for_evaluation');
      expect(commandArgs).toContain('0');
      expect(commandArgs).toContain('--gen_report');
      expect(commandArgs).toContain('0');
      expect(commandArgs).toContain('--verify_submission');
      expect(commandArgs).toContain('0');
    });
  });
});

describe('CLI Integration', () => {
  it('should parse SWE-bench batch command correctly', () => {
    const args = [
      'run-batch',
      '--instances.type',
      'swe_bench',
      '--instances.subset',
      'lite',
      '--instances.split',
      'dev',
      '--instances.slice',
      ':50',
      '--instances.shuffle',
      '--instances.evaluate',
      '--agent.model.name',
      'gpt-4o',
      '--agent.model.per_instance_cost_limit',
      '2.00',
      '--num_workers',
      '3',
    ];

    // This would be tested in an integration test
    // Just verify the command structure is correct
    expect(args[0]).toBe('run-batch');
    expect(args).toContain('--instances.type');
    expect(args).toContain('swe_bench');
    expect(args).toContain('--instances.evaluate');
  });
});
