import { describe, it, expect, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { AgentRuntime } from '../runtime';
import {
  type Action,
  type ActionResult,
  type Memory,
  type State,
  type UUID,
  type ActionPlan,
  type PlanningContext,
  type HandlerCallback,
  ModelType,
  asUUID,
} from '../types';
import { planningScenarios } from './planning-scenarios';
import { createLogger } from '../logger';
import * as fs from 'fs/promises';
import * as path from 'path';

interface BenchmarkResult {
  scenarioId: string;
  scenarioName: string;
  iteration: number;
  success: boolean;
  duration: number;
  completedSteps: number;
  totalSteps: number;
  errors?: string[];
  planGenerated: boolean;
  planValidated: boolean;
  adaptations?: string[];
}

interface BenchmarkSummary {
  scenarioId: string;
  scenarioName: string;
  iterations: number;
  successRate: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  avgCompletedSteps: number;
  planGenerationRate: number;
  planValidationRate: number;
  errorTypes: Record<string, number>;
}

// Create runtime with deterministic mock actions
function createBenchmarkRuntime(): AgentRuntime {
  const runtime = new AgentRuntime({
    agentId: asUUID(uuidv4()),
    character: {
      name: 'BenchmarkAgent',
      bio: ['Benchmark test agent'],
      settings: {
        enablePlanning: true,
      },
    },
    settings: {},
  });

  // Register test actions
  const benchmarkActions: Action[] = [
    {
      name: 'MUTE_ROOM',
      description: 'Mute a room',
      validate: async () => true,
      handler: async (runtime, message, state, options) => {
        const iteration = options?.iteration || 0;
        const shouldFail = (iteration as number) % 10 === 9;

        await new Promise((resolve) => setTimeout(resolve, 50));

        if (shouldFail) {
          throw new Error('Simulated mute failure');
        }

        return {
          data: { actionName: 'MUTE_ROOM', muted: true },
          values: { roomMuteState: 'MUTED', muteSuccess: true },
          text: 'Room muted',
        };
      },
      similes: [],
    },
    {
      name: 'FOLLOW_ROOM',
      description: 'Follow a room',
      validate: async () => true,
      handler: async (runtime, message, state, options) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          data: { actionName: 'FOLLOW_ROOM', followed: true },
          values: { roomFollowState: 'FOLLOWED', followSuccess: true },
          text: 'Room followed',
        };
      },
      similes: [],
    },
    {
      name: 'UPDATE_SETTINGS',
      description: 'Update settings',
      validate: async () => true,
      handler: async (runtime, message, state, options) => {
        const key = options?.key || 'setting';
        const value = options?.value || 'value';

        await new Promise((resolve) => setTimeout(resolve, 30));

        // Simulate validation error for specific values
        if (value === 'invalid') {
          throw new Error('Invalid setting value');
        }

        return {
          data: { actionName: 'UPDATE_SETTINGS', key, value, updated: true },
          values: { [`setting_${key}`]: value, updateSuccess: true },
          text: `Setting ${key} updated to ${value}`,
        };
      },
      similes: [],
    },
    {
      name: 'REPLY',
      description: 'Reply to a message',
      validate: async () => true,
      handler: async (runtime, message, state, options) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          data: { actionName: 'REPLY', response: 'Done' },
          values: { lastReply: 'Done' },
          text: 'Done',
        };
      },
      similes: [],
    },
  ];

  benchmarkActions.forEach((action) => runtime.registerAction(action));

  // Mock plan generation
  (runtime as any).useModel = async (modelType: any, params: any) => {
    if (modelType === ModelType.TEXT_REASONING_LARGE || modelType === ModelType.TEXT_LARGE) {
      return `<plan>
<goal>Test goal</goal>
<steps>
<step>
<id>${uuidv4()}</id>
<action>MUTE_ROOM</action>
<parameters>{}</parameters>
</step>
<step>
<id>${uuidv4()}</id>
<action>REPLY</action>
<parameters>{}</parameters>
</step>
</steps>
<executionModel>sequential</executionModel>
</plan>`;
    }
    return '';
  };

  return runtime;
}

describe('Planning Benchmarks', () => {
  const ITERATIONS = 10;
  const allResults: BenchmarkResult[] = [];

  afterAll(() => {
    // Print summary
    const grouped = new Map<string, BenchmarkResult[]>();
    allResults.forEach((r) => {
      if (!grouped.has(r.scenarioId)) {
        grouped.set(r.scenarioId, []);
      }
      grouped.get(r.scenarioId)!.push(r);
    });

    console.log('\n=== Benchmark Summary ===\n');
    grouped.forEach((results, scenarioId) => {
      const successRate = results.filter((r) => r.success).length / results.length;
      const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
      console.log(`${results[0].scenarioName}:`);
      console.log(`  Success Rate: ${(successRate * 100).toFixed(1)}%`);
      console.log(`  Avg Duration: ${avgDuration.toFixed(2)}ms\n`);
    });
  });

  planningScenarios.slice(0, 3).forEach((scenario) => {
    it(`should benchmark: ${scenario.name}`, async () => {
      const runtime = createBenchmarkRuntime();
      const results: BenchmarkResult[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        const startTime = Date.now();
        const result: BenchmarkResult = {
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          iteration: i,
          success: false,
          duration: 0,
          completedSteps: 0,
          totalSteps: 0,
          planGenerated: false,
          planValidated: false,
        };

        try {
          const message: Memory = {
            id: asUUID(uuidv4()),
            entityId: asUUID(uuidv4()),
            roomId: asUUID(uuidv4()),
            content: scenario.messages[0].content,
            createdAt: Date.now(),
          };

          const plan: ActionPlan = {
            id: asUUID(uuidv4()),
            goal: scenario.goal,
            steps: scenario.expectedActions.map((actionName) => ({
              id: asUUID(uuidv4()),
              actionName,
              parameters: { iteration: i },
            })),
            executionModel: 'sequential',
            state: { status: 'pending' },
            metadata: { createdAt: Date.now(), constraints: [], tags: [] },
          };

          const executionResult = await (runtime as any).executePlan(plan, message);

          result.success = executionResult.success;
          result.completedSteps = executionResult.completedSteps;
          result.totalSteps = executionResult.totalSteps;
          result.planGenerated = true;
          result.planValidated = true;

          if (executionResult.errors) {
            result.errors = executionResult.errors.map((e) => e.message);
          }
        } catch (error) {
          result.errors = [error instanceof Error ? error.message : String(error)];
        }

        result.duration = Date.now() - startTime;
        results.push(result);
        allResults.push(result);
      }

      const successRate = results.filter((r) => r.success).length / results.length;
      expect(successRate).toBeGreaterThanOrEqual(0.8);
    });
  });
});
