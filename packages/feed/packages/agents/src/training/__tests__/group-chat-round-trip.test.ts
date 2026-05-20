/**
 * Group Chat Round-Trip Tests
 *
 * Validates that group chat, working memory, and token budget fields
 * survive the full trajectory recording pipeline in simulation mode.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Mock ONLY external dependencies - not the code under test
mock.module('@feed/db', () => ({
  db: {
    insert: mock(() => ({
      values: mock(() => ({
        onConflictDoUpdate: mock(() => Promise.resolve()),
      })),
    })),
  },
  trajectories: {},
  llmCallLogs: {},
  rewardJudgments: { trajectoryId: 'trajectoryId' },
  isSimulationMode: () => true,
  getJsonStoragePath: () => null,
}));

// Import the REAL class after mocking db
import { TrajectoryRecorder } from '../TrajectoryRecorder';
import type { Action, EnvironmentState } from '../types';

const TEST_OUTPUT_DIR = './training-data-output/trajectories';

describe('Group Chat Round-Trip', () => {
  let recorder: TrajectoryRecorder;
  let trajectoryId: string;
  let outputFilePath: string;
  let outputContent: Record<string, unknown>;

  beforeAll(async () => {
    recorder = new TrajectoryRecorder();

    // Start trajectory with information-trader archetype
    trajectoryId = await recorder.startTrajectory({
      agentId: 'test-agent-group-chat',
      archetype: 'information-trader',
    });

    // Record 3 steps with all new fields
    for (let i = 0; i < 3; i++) {
      const envState: EnvironmentState = {
        agentBalance: 10000 + i * 200,
        agentPnL: i * 200,
        openPositions: i + 1,
        groupChatsActive: 2,
        groupChatFacts: ['BTC bullish in alpha chat', 'ETH merger discussion'],
        groupChatIntelTokenEstimate: 450,
        promptTokenEstimate: 4200,
        contextBreakdown: {
          system: 800,
          markets: 1200,
          positions: 400,
          groupChat: 450,
          pending: 0,
          actionSchemas: 1350,
        },
        workingMemoryFactCount: 5,
        workingMemoryActiveThesis: 'BTC uptrend continuation',
      };

      recorder.startStep(trajectoryId, envState);

      recorder.logLLMCall(trajectoryId, {
        model: 'gpt-oss-120b',
        systemPrompt: 'You are a trading agent with group chat intel',
        userPrompt: `Step ${i}: evaluate positions`,
        response: `Buy BTCAI based on group chat sentiment`,
        temperature: 0.7,
        maxTokens: 2000,
        purpose: 'action',
        latencyMs: 200 + i * 10,
      });

      const action: Action = {
        actionType: 'BUY_YES',
        parameters: { ticker: 'BTCAI', amount: 100 + i * 50 },
        success: true,
      };

      recorder.completeStep(trajectoryId, action, 0.8);
    }

    // End trajectory
    await recorder.endTrajectory(trajectoryId, {
      finalBalance: 10600,
      finalPnL: 600,
    });

    // Read the output JSON
    outputFilePath = path.join(TEST_OUTPUT_DIR, `${trajectoryId}.json`);
    outputContent = JSON.parse(fs.readFileSync(outputFilePath, 'utf-8'));
  });

  afterAll(() => {
    // Cleanup
    if (outputFilePath && fs.existsSync(outputFilePath)) {
      fs.unlinkSync(outputFilePath);
    }
  });

  test('output file exists and has correct archetype', () => {
    expect(fs.existsSync(outputFilePath)).toBe(true);
    expect(outputContent.trajectory.archetype).toBe('information-trader');
    expect(outputContent.trajectory.episodeLength).toBe(3);
  });

  test('steps contain groupChatsActive in environment state', () => {
    const steps = JSON.parse(outputContent.trajectory.stepsJson);
    for (const step of steps) {
      expect(step.environmentState.groupChatsActive).toBe(2);
    }
  });

  test('steps contain groupChatFacts in environment state', () => {
    const steps = JSON.parse(outputContent.trajectory.stepsJson);
    for (const step of steps) {
      expect(step.environmentState.groupChatFacts).toEqual([
        'BTC bullish in alpha chat',
        'ETH merger discussion',
      ]);
    }
  });

  test('steps contain contextBreakdown in environment state', () => {
    const steps = JSON.parse(outputContent.trajectory.stepsJson);
    for (const step of steps) {
      expect(step.environmentState.contextBreakdown).toEqual({
        system: 800,
        markets: 1200,
        positions: 400,
        groupChat: 450,
        pending: 0,
        actionSchemas: 1350,
      });
    }
  });

  test('steps contain token and working memory fields', () => {
    const steps = JSON.parse(outputContent.trajectory.stepsJson);
    for (const step of steps) {
      expect(step.environmentState.groupChatIntelTokenEstimate).toBe(450);
      expect(step.environmentState.promptTokenEstimate).toBe(4200);
      expect(step.environmentState.workingMemoryFactCount).toBe(5);
      expect(step.environmentState.workingMemoryActiveThesis).toBe(
        'BTC uptrend continuation'
      );
    }
  });

  test('metricsJson contains group chat and token aggregates', () => {
    const metrics = JSON.parse(outputContent.trajectory.metricsJson);
    expect(metrics.groupChatStepsWithIntel).toBeDefined();
    expect(metrics.groupChatStepsWithIntel).toBe(3);
    expect(metrics.uniqueGroupChatFacts).toBeDefined();
    expect(metrics.uniqueGroupChatFacts).toBe(2);
    expect(metrics.avgPromptTokens).toBeDefined();
    expect(metrics.avgPromptTokens).toBe(4200);
    expect(metrics.hadActiveThesis).toBeDefined();
    expect(metrics.hadActiveThesis).toBe(true);
  });
});
