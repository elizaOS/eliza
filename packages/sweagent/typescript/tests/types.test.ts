/**
 * Tests for core types
 * Converted from Python tests
 */

import { StepOutputImpl, TrajectoryStep, HistoryItem, AgentInfo } from '../src/types';

describe('StepOutput', () => {
  it('should create with default values', () => {
    const step = new StepOutputImpl();

    expect(step.query).toEqual([{}]);
    expect(step.thought).toBe('');
    expect(step.action).toBe('');
    expect(step.output).toBe('');
    expect(step.observation).toBe('');
    expect(step.executionTime).toBe(0);
    expect(step.done).toBe(false);
    expect(step.exitStatus).toBeNull();
    expect(step.submission).toBeNull();
    expect(step.state).toEqual({});
    expect(step.extraInfo).toEqual({});
  });

  it('should convert to template format dict', () => {
    const step = new StepOutputImpl();
    step.thought = 'Test thought';
    step.action = 'Test action';
    step.observation = 'Test observation';
    step.exitStatus = 0;
    step.submission = 'Test submission';
    step.done = true;
    step.executionTime = 1.5;

    const dict = step.toTemplateFormatDict();

    expect(dict).toEqual({
      thought: 'Test thought',
      action: 'Test action',
      output: '',
      observation: 'Test observation',
      exitStatus: 0,
      submission: 'Test submission',
      done: true,
      executionTime: 1.5,
    });
  });
});

describe('TrajectoryStep', () => {
  it('should have correct structure', () => {
    const step: TrajectoryStep = {
      action: 'test action',
      observation: 'test observation',
      response: 'test response',
      state: { key: 'value' },
      thought: 'test thought',
      executionTime: 2.5,
      query: [{ test: 'query' }],
      extraInfo: { extra: 'info' },
    };

    expect(step.action).toBe('test action');
    expect(step.state).toHaveProperty('key', 'value');
    expect(step.executionTime).toBe(2.5);
  });
});

describe('HistoryItem', () => {
  it('should handle optional fields', () => {
    const item: HistoryItem = {
      role: 'user',
      content: 'Test content',
      messageType: 'thought',
    };

    expect(item.role).toBe('user');
    expect(item.content).toBe('Test content');
    expect(item.messageType).toBe('thought');
    expect(item.agent).toBeUndefined();
    expect(item.isDemo).toBeUndefined();
  });

  it('should handle all fields', () => {
    const item: HistoryItem = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      messageType: 'action',
      agent: 'test-agent',
      isDemo: true,
      thought: 'Thinking...',
      action: 'Do something',
      toolCalls: [{ id: 'id1', type: 'function', function: { name: 'tool1', arguments: '{}' } }],
      toolCallIds: ['id1'],
      tags: ['test', 'demo'],
      cacheControl: { type: 'ephemeral' },
      thinkingBlocks: [{ type: 'thinking', content: 'thinking' }],
    };

    expect(item.agent).toBe('test-agent');
    expect(item.isDemo).toBe(true);
    expect(item.tags).toContain('test');
    expect(item.toolCallIds).toHaveLength(1);
  });
});

describe('AgentInfo', () => {
  it('should handle optional fields', () => {
    const info: AgentInfo = {};

    expect(info.modelStats).toBeUndefined();
    expect(info.exitStatus).toBeUndefined();
    expect(info.submission).toBeUndefined();
  });

  it('should handle all fields', () => {
    const info: AgentInfo = {
      modelStats: { cost: 0.5, tokens: 100 },
      exitStatus: 'success',
      submission: 'Solution submitted',
      review: { score: 0.8 },
      editedFiles30: 'file1.py',
      editedFiles50: 'file1.py, file2.py',
      editedFiles70: 'file1.py, file2.py, file3.py',
      summarizer: { summary: 'Test summary' },
      sweAgentHash: 'abc123',
      sweAgentVersion: '1.0.0',
      sweRexVersion: '0.1.0',
      sweRexHash: 'def456',
    };

    expect(info.modelStats).toHaveProperty('cost', 0.5);
    expect(info.exitStatus).toBe('success');
    expect(info.review).toHaveProperty('score', 0.8);
  });
});
