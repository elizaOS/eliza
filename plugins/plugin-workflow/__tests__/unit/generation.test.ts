import { describe, expect, mock, test } from 'bun:test';
import type { WorkflowDraft } from '../../src/types/index';
import {
  classifyDraftIntent,
  extractKeywords,
  generateWorkflow,
  matchWorkflow,
  modifyWorkflow,
} from '../../src/utils/generation';
import { createMockRuntime } from '../helpers/mockRuntime';

// ============================================================================
// extractKeywords
// ============================================================================

describe('extractKeywords', () => {
  test('returns keywords from valid LLM response', async () => {
    const runtime = createMockRuntime({
      useModel: mock(() => Promise.resolve({ keywords: ['gmail', 'stripe', 'send'] })),
    });

    const result = await extractKeywords(runtime, 'Send Stripe via Gmail');
    expect(result).toEqual(['gmail', 'stripe', 'send']);
  });

  test('trims and filters empty keywords', async () => {
    const runtime = createMockRuntime({
      useModel: mock(() => Promise.resolve({ keywords: [' gmail ', '', '  slack  ', ' '] })),
    });

    const result = await extractKeywords(runtime, 'Gmail and Slack');
    expect(result).toEqual(['gmail', 'slack']);
  });

  test('limits to 5 keywords', async () => {
    const runtime = createMockRuntime({
      useModel: mock(() =>
        Promise.resolve({
          keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        })
      ),
    });

    const result = await extractKeywords(runtime, 'Many keywords');
    expect(result).toHaveLength(5);
  });

  test('throws when LLM returns null', async () => {
    const runtime = createMockRuntime({
      useModel: mock(() => Promise.resolve(null)),
    });

    expect(extractKeywords(runtime, 'test')).rejects.toThrow('Invalid keyword extraction response');
  });

  test('throws when LLM returns object without keywords', async () => {
    const runtime = createMockRuntime({
      useModel: mock(() => Promise.resolve({ result: 'no keywords field' })),
    });

    expect(extractKeywords(runtime, 'test')).rejects.toThrow('Invalid keyword extraction response');
  });

  test('throws when keywords contains non-strings', async () => {
    const runtime = createMockRuntime({
      useModel: mock(() => Promise.resolve({ keywords: ['valid', 42, null] })),
    });

    expect(extractKeywords(runtime, 'test')).rejects.toThrow('non-string elements');
  });

  test('omits the bias directive when preferredProviders is undefined', async () => {
    const useModel = mock(() => Promise.resolve({ keywords: ['email'] }));
    const runtime = createMockRuntime({ useModel });

    await extractKeywords(runtime, 'Send my emails');

    const promptArg = (useModel as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as { prompt: string };
    expect(promptArg.prompt).not.toContain('Host-supported providers');
  });

  test('appends the bias directive when preferredProviders is non-empty', async () => {
    const useModel = mock(() => Promise.resolve({ keywords: ['gmail', 'discord'] }));
    const runtime = createMockRuntime({ useModel });

    await extractKeywords(runtime, 'Summarize my emails to my chat', ['gmail', 'discord']);

    const promptArg = (useModel as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as { prompt: string };
    expect(promptArg.prompt).toContain('Host-supported providers: gmail, discord');
    expect(promptArg.prompt).toContain('emit the specific provider keyword');
  });

  test('omits the bias directive when preferredProviders is empty array', async () => {
    const useModel = mock(() => Promise.resolve({ keywords: ['email'] }));
    const runtime = createMockRuntime({ useModel });

    await extractKeywords(runtime, 'Send my emails', []);

    const promptArg = (useModel as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as { prompt: string };
    expect(promptArg.prompt).not.toContain('Host-supported providers');
  });
});

// ============================================================================
// matchWorkflow
// ============================================================================

describe('matchWorkflow', () => {
  test('returns no-match for empty workflow list', async () => {
    const runtime = createMockRuntime();
    const result = await matchWorkflow(runtime, 'Activate Stripe', []);

    expect(result.matchedWorkflowId).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.matches).toHaveLength(0);
    expect(result.reason).toContain('No workflows available');
  });

  test('calls useModel with workflow list in prompt', async () => {
    const useModel = mock(() =>
      Promise.resolve({
        matchedWorkflowId: 'wf-001',
        confidence: 'high',
        matches: [{ id: 'wf-001', name: 'Stripe', score: 0.9 }],
        reason: 'matched',
      })
    );
    const runtime = createMockRuntime({ useModel });

    const workflows = [
      {
        id: 'wf-001',
        name: 'Stripe Payments',
        active: true,
        nodes: [],
        connections: {},
      },
      {
        id: 'wf-002',
        name: 'Gmail Auto',
        active: false,
        nodes: [],
        connections: {},
      },
    ];

    await matchWorkflow(runtime, 'Activate Stripe', workflows as any);

    // Verify useModel was called
    expect(useModel).toHaveBeenCalledTimes(1);
    // Verify the prompt includes workflow names
    const callArgs = useModel.mock.calls[0] as any[];
    const params = callArgs[1] as { prompt: string };
    expect(params.prompt).toContain('Stripe Payments');
    expect(params.prompt).toContain('Gmail Auto');
    expect(params.prompt).toContain('ACTIVE');
    expect(params.prompt).toContain('INACTIVE');
  });

  test('returns graceful failure when LLM throws', async () => {
    const runtime = createMockRuntime({
      useModel: mock(() => Promise.reject(new Error('LLM timeout'))),
    });

    const workflows = [
      {
        id: 'wf-001',
        name: 'Test',
        active: true,
        nodes: [],
        connections: {},
      },
    ];

    const result = await matchWorkflow(runtime, 'Activate Test', workflows as any);

    expect(result.matchedWorkflowId).toBeNull();
    expect(result.confidence).toBe('none');
    expect(result.reason).toContain('LLM timeout');
  });

  test('passes through LLM match result', async () => {
    const matchResult = {
      matchedWorkflowId: 'wf-002',
      confidence: 'medium',
      matches: [{ id: 'wf-002', name: 'Gmail', score: 0.7 }],
      reason: 'Partial match by name',
    };
    const runtime = createMockRuntime({
      useModel: mock(() => Promise.resolve(matchResult)),
    });

    const workflows = [
      {
        id: 'wf-002',
        name: 'Gmail',
        active: true,
        nodes: [],
        connections: {},
      },
    ];

    const result = await matchWorkflow(runtime, 'the Gmail one', workflows as any);

    expect(result.matchedWorkflowId).toBe('wf-002');
    expect(result.confidence).toBe('medium');
  });
});

// ============================================================================
// generateWorkflow
// ============================================================================

describe('generateWorkflow', () => {
  test('parses valid JSON response', async () => {
    const workflowJson = JSON.stringify({
      name: 'Test Workflow',
      nodes: [{ name: 'Start', type: 'workflows-nodes-base.start', position: [0, 0] }],
      connections: {},
    });

    const runtime = createMockRuntime({
      useModel: mock(() => Promise.resolve(workflowJson)),
    });

    const result = await generateWorkflow(runtime, 'test', []);
    expect(result.name).toBe('Test Workflow');
    expect(result.nodes).toHaveLength(1);
  });

  test('strips markdown code fences from response', async () => {
    const workflowJson = `\`\`\`json
{
  "name": "Fenced",
  "nodes": [{ "name": "A", "type": "t", "position": [0, 0] }],
  "connections": {}
}
\`\`\``;

    const runtime = createMockRuntime({
      useModel: mock(() => Promise.resolve(workflowJson)),
    });

    const result = await generateWorkflow(runtime, 'test', []);
    expect(result.name).toBe('Fenced');
  });

  test('throws when response is not valid JSON', async () => {
    const runtime = createMockRuntime({
      useModel: mock(() => Promise.resolve('not json at all')),
    });

    expect(generateWorkflow(runtime, 'test', [])).rejects.toThrow('Failed to parse workflow JSON');
  });

  test('throws when workflow has no nodes array', async () => {
    const runtime = createMockRuntime({
      useModel: mock(() => Promise.resolve(JSON.stringify({ name: 'Bad', connections: {} }))),
    });

    expect(generateWorkflow(runtime, 'test', [])).rejects.toThrow('missing or invalid nodes array');
  });

  test('throws when workflow has no connections object', async () => {
    const runtime = createMockRuntime({
      useModel: mock(() =>
        Promise.resolve(JSON.stringify({ name: 'Bad', nodes: [{ name: 'A' }] }))
      ),
    });

    expect(generateWorkflow(runtime, 'test', [])).rejects.toThrow(
      'missing or invalid connections object'
    );
  });

  test('includes relevant nodes in prompt', async () => {
    const useModel = mock(() =>
      Promise.resolve(
        JSON.stringify({
          name: 'WF',
          nodes: [{ name: 'A', type: 't', position: [0, 0] }],
          connections: {},
        })
      )
    );
    const runtime = createMockRuntime({ useModel });

    const nodes = [
      {
        name: 'workflows-nodes-base.httpRequest',
        displayName: 'HTTP Request',
        description: 'Make an HTTP request',
        group: ['output'],
        properties: [],
      },
    ];

    await generateWorkflow(runtime, 'call an API', nodes as any);

    const callArgs = useModel.mock.calls[0] as any[];
    const params = callArgs[1] as { prompt: string };
    expect(params.prompt).toContain('HTTP Request');
    expect(params.prompt).toContain('Make an HTTP request');
  });

  test('no output schema section when nodes have no schemas', async () => {
    const useModel = mock(() =>
      Promise.resolve(
        JSON.stringify({
          name: 'WF',
          nodes: [{ name: 'A', type: 't', position: [0, 0] }],
          connections: {},
        })
      )
    );
    const runtime = createMockRuntime({ useModel });

    // Unknown node with no schema
    const nodes = [
      {
        name: 'workflows-nodes-base.unknownNode',
        displayName: 'Unknown',
        description: 'No schema',
        group: ['transform'],
        properties: [],
      },
    ];

    await generateWorkflow(runtime, 'do something', nodes as any);

    const callArgs = useModel.mock.calls[0] as any[];
    const params = callArgs[1] as { prompt: string };
    expect(params.prompt).not.toContain('Do NOT invent field names');
  });

  test('retries once and succeeds when first response is missing nodes array', async () => {
    let callCount = 0;
    const useModel = mock(() => {
      callCount++;
      if (callCount === 1) {
        // First attempt: malformed (no nodes array — the exact failure mode
        // hit in the Automations UI).
        return Promise.resolve(JSON.stringify({ name: 'Bad', connections: {} }));
      }
      return Promise.resolve(
        JSON.stringify({
          name: 'Good',
          nodes: [{ name: 'A', type: 't', position: [0, 0] }],
          connections: {},
        })
      );
    });
    const runtime = createMockRuntime({ useModel });

    const result = await generateWorkflow(runtime, 'test', []);
    expect(result.name).toBe('Good');
    expect(callCount).toBe(2);
  });

  test('retry prompt instructs the LLM to return only valid JSON', async () => {
    let callCount = 0;
    const useModel = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve('not json at all');
      }
      return Promise.resolve(
        JSON.stringify({
          name: 'Recovered',
          nodes: [{ name: 'A', type: 't', position: [0, 0] }],
          connections: {},
        })
      );
    });
    const runtime = createMockRuntime({ useModel });

    await generateWorkflow(runtime, 'test', []);

    expect(callCount).toBe(2);
    const retryArgs = useModel.mock.calls[1] as any[];
    const retryParams = retryArgs[1] as { prompt: string };
    expect(retryParams.prompt).toContain('malformed');
    expect(retryParams.prompt).toContain('"nodes"');
    expect(retryParams.prompt).toContain('"connections"');
  });
});

// ============================================================================
// modifyWorkflow
// ============================================================================

describe('modifyWorkflow', () => {
  const baseWorkflow = {
    id: 'wf-1',
    name: 'Existing',
    nodes: [{ name: 'A', type: 't', position: [0, 0] as [number, number] }],
    connections: {},
  };

  test('retries once and succeeds when first response is missing nodes array', async () => {
    let callCount = 0;
    const useModel = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(JSON.stringify({ name: 'Bad', connections: {} }));
      }
      return Promise.resolve(
        JSON.stringify({
          name: 'Modified',
          nodes: [{ name: 'A', type: 't', position: [0, 0] }],
          connections: {},
        })
      );
    });
    const runtime = createMockRuntime({ useModel });

    const result = await modifyWorkflow(runtime, baseWorkflow as any, 'tweak', []);
    expect(result.name).toBe('Modified');
    expect(result.id).toBe('wf-1');
    expect(callCount).toBe(2);
  });
});

// ============================================================================
// classifyDraftIntent
// ============================================================================

describe('classifyDraftIntent', () => {
  const sampleDraft: WorkflowDraft = {
    workflow: {
      name: 'Stripe Gmail Summary',
      nodes: [
        {
          name: 'Schedule Trigger',
          type: 'workflows-nodes-base.scheduleTrigger',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          name: 'Gmail',
          type: 'workflows-nodes-base.gmail',
          typeVersion: 2,
          position: [200, 0],
          parameters: { operation: 'send' },
        },
      ],
      connections: {
        'Schedule Trigger': {
          main: [[{ node: 'Gmail', type: 'main', index: 0 }]],
        },
      },
    },
    prompt: 'Send Stripe summaries via Gmail',
    userId: 'user-001',
    createdAt: Date.now(),
  };

  test('returns confirm intent from LLM', async () => {
    const useModel = mock(() =>
      Promise.resolve({
        intent: 'confirm',
        reason: 'User said yes',
      })
    );
    const runtime = createMockRuntime({ useModel });

    const result = await classifyDraftIntent(runtime, 'Yes, deploy it', sampleDraft);

    expect(result.intent).toBe('confirm');
    expect(result.reason).toBe('User said yes');
  });

  test('returns modify intent with modification request', async () => {
    const useModel = mock(() =>
      Promise.resolve({
        intent: 'modify',
        modificationRequest: 'Use Outlook instead',
        reason: 'User wants different email',
      })
    );
    const runtime = createMockRuntime({ useModel });

    const result = await classifyDraftIntent(runtime, 'Use Outlook instead', sampleDraft);

    expect(result.intent).toBe('modify');
    expect(result.modificationRequest).toBe('Use Outlook instead');
  });

  test('includes draft summary in prompt sent to LLM', async () => {
    const useModel = mock(() =>
      Promise.resolve({
        intent: 'confirm',
        reason: 'test',
      })
    );
    const runtime = createMockRuntime({ useModel });

    await classifyDraftIntent(runtime, 'yes', sampleDraft);

    const callArgs = useModel.mock.calls[0] as any[];
    const params = callArgs[1] as { prompt: string };
    expect(params.prompt).toContain('Stripe Gmail Summary');
    expect(params.prompt).toContain('Schedule Trigger');
    expect(params.prompt).toContain('Send Stripe summaries via Gmail');
  });

  test('returns cancel intent', async () => {
    const useModel = mock(() =>
      Promise.resolve({
        intent: 'cancel',
        reason: 'User rejected',
      })
    );
    const runtime = createMockRuntime({ useModel });

    const result = await classifyDraftIntent(runtime, 'No, forget it', sampleDraft);

    expect(result.intent).toBe('cancel');
  });

  test('returns new intent for unrelated request', async () => {
    const useModel = mock(() =>
      Promise.resolve({
        intent: 'new',
        reason: 'Completely different request',
      })
    );
    const runtime = createMockRuntime({ useModel });

    const result = await classifyDraftIntent(
      runtime,
      'Create a Slack to Jira integration',
      sampleDraft
    );

    expect(result.intent).toBe('new');
  });
});
