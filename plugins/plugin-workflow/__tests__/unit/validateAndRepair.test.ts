import { describe, expect, test } from 'bun:test';
import type { NodeDefinition, RuntimeContext, WorkflowDefinition } from '../../src/types/index';
import { validateAndRepair } from '../../src/utils/validateAndRepair';

function makeNodeDef(overrides: Partial<NodeDefinition>): NodeDefinition {
  return {
    name: 'workflows-nodes-base.test',
    displayName: 'Test',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Test' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [],
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'wf',
    nodes: [],
    connections: {},
    ...overrides,
  };
}

const NO_CTX: RuntimeContext | undefined = undefined;

// ─── Check 1: typeVersion clamp ────────────────────────────────────────────

describe('validateAndRepair — typeVersion clamp', () => {
  test('clamps 2.2 to 2.1 when valid versions are [1, 2, 2.1]', () => {
    const def = makeNodeDef({
      name: 'workflows-nodes-base.gmail',
      version: [1, 2, 2.1],
    });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Gmail',
          type: 'workflows-nodes-base.gmail',
          typeVersion: 2.2,
          position: [0, 0],
          parameters: {},
        },
      ],
    });
    const r = validateAndRepair(wf, [def], NO_CTX);
    expect(wf.nodes[0].typeVersion).toBe(2.1);
    expect(r.repairs).toHaveLength(1);
    expect(r.repairs[0].kind).toBe('typeVersionClamp');
  });

  test('clamps 1.5 down to 1 (highest ≤ requested)', () => {
    const def = makeNodeDef({
      name: 'workflows-nodes-base.gmail',
      version: [1, 2, 2.1],
    });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Gmail',
          type: 'workflows-nodes-base.gmail',
          typeVersion: 1.5,
          position: [0, 0],
          parameters: {},
        },
      ],
    });
    validateAndRepair(wf, [def], NO_CTX);
    expect(wf.nodes[0].typeVersion).toBe(1);
  });

  test('no-op when typeVersion is already valid', () => {
    const def = makeNodeDef({ version: [1, 2, 2.1] });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Test',
          type: 'workflows-nodes-base.test',
          typeVersion: 2,
          position: [0, 0],
          parameters: {},
        },
      ],
    });
    const r = validateAndRepair(wf, [def], NO_CTX);
    expect(wf.nodes[0].typeVersion).toBe(2);
    expect(r.repairs.filter((rep) => rep.kind === 'typeVersionClamp')).toHaveLength(0);
  });

  test('runtime versions trump catalog when narrower (Gmail catalog [2,2.1,2.2] but runtime only [2,2.1])', () => {
    // Real-world Session 21 dogfood case: bundled defaultNodes.json claims
    // Gmail supports 2.2 but the user's actual workflows binary only ships up
    // to 2.1. The clamp must use runtime ∩ catalog, not catalog alone.
    const def = makeNodeDef({
      name: 'workflows-nodes-base.gmail',
      version: [2, 2.1, 2.2],
    });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Gmail',
          type: 'workflows-nodes-base.gmail',
          typeVersion: 2.2,
          position: [0, 0],
          parameters: {},
        },
      ],
    });
    const runtimeVersions = new Map<string, number[]>([
      ['workflows-nodes-base.gmail', [1, 2, 2.1]],
    ]);
    const r = validateAndRepair(wf, [def], NO_CTX, runtimeVersions);
    expect(wf.nodes[0].typeVersion).toBe(2.1);
    expect(r.repairs[0].kind).toBe('typeVersionClamp');
    expect(r.repairs[0].detail).toContain('runtime∩catalog');
  });

  test('falls back to runtime versions when catalog and runtime do not intersect', () => {
    const def = makeNodeDef({
      name: 'workflows-nodes-base.gmail',
      version: [3, 3.1],
    });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Gmail',
          type: 'workflows-nodes-base.gmail',
          typeVersion: 3,
          position: [0, 0],
          parameters: {},
        },
      ],
    });
    const runtimeVersions = new Map<string, number[]>([
      ['workflows-nodes-base.gmail', [1, 2, 2.1]],
    ]);
    const r = validateAndRepair(wf, [def], NO_CTX, runtimeVersions);
    // No catalog ∩ runtime overlap — trust runtime, clamp to highest ≤ 3
    expect(wf.nodes[0].typeVersion).toBe(2.1);
    expect(r.repairs[0].kind).toBe('typeVersionClamp');
  });

  test('clamps below-floor request to highest available (degenerate fallback)', () => {
    const def = makeNodeDef({ version: [2, 2.1] });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'X',
          type: 'workflows-nodes-base.test',
          typeVersion: 0.5,
          position: [0, 0],
          parameters: {},
        },
      ],
    });
    validateAndRepair(wf, [def], NO_CTX);
    expect(wf.nodes[0].typeVersion).toBe(2.1);
  });
});

// ─── Check 2: authentication back-fill ─────────────────────────────────────

describe('validateAndRepair — authentication back-fill', () => {
  test('sets parameters.authentication when Gmail+gmailOAuth2 is attached but auth missing', () => {
    const def = makeNodeDef({
      name: 'workflows-nodes-base.gmail',
      version: [2, 2.1],
      credentials: [
        {
          name: 'gmailOAuth2',
          required: true,
          displayOptions: { show: { authentication: ['oAuth2'] } },
        },
        {
          name: 'googleApi',
          required: true,
          displayOptions: { show: { authentication: ['serviceAccount'] } },
        },
      ],
    });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Gmail',
          type: 'workflows-nodes-base.gmail',
          typeVersion: 2.1,
          position: [0, 0],
          parameters: { resource: 'message', operation: 'getAll' },
          credentials: { gmailOAuth2: { id: 'x', name: 'Gmail Account' } },
        },
      ],
    });
    const r = validateAndRepair(wf, [def], NO_CTX);
    expect((wf.nodes[0].parameters as Record<string, unknown>).authentication).toBe('oAuth2');
    expect(r.repairs.find((rep) => rep.kind === 'authenticationBackfill')).toBeDefined();
  });

  test('does not overwrite authentication when LLM already set it', () => {
    const def = makeNodeDef({
      name: 'workflows-nodes-base.discord',
      credentials: [
        {
          name: 'discordBotApi',
          required: true,
          displayOptions: { show: { authentication: ['botToken'] } },
        },
      ],
    });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Discord',
          type: 'workflows-nodes-base.discord',
          typeVersion: 2,
          position: [0, 0],
          parameters: { authentication: 'botToken' },
          credentials: { discordBotApi: { id: 'x', name: 'Discord Bot' } },
        },
      ],
    });
    const r = validateAndRepair(wf, [def], NO_CTX);
    expect((wf.nodes[0].parameters as Record<string, unknown>).authentication).toBe('botToken');
    expect(r.repairs.filter((rep) => rep.kind === 'authenticationBackfill')).toHaveLength(0);
  });

  test('skips back-fill when displayOptions has multiple auth values (ambiguous)', () => {
    const def = makeNodeDef({
      name: 'workflows-nodes-base.test',
      credentials: [
        {
          name: 'multiAuth',
          required: true,
          displayOptions: { show: { authentication: ['a', 'b'] } },
        },
      ],
    });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'X',
          type: 'workflows-nodes-base.test',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
          credentials: { multiAuth: { id: 'x', name: 'X' } },
        },
      ],
    });
    const r = validateAndRepair(wf, [def], NO_CTX);
    expect((wf.nodes[0].parameters as Record<string, unknown>).authentication).toBeUndefined();
    expect(r.repairs.filter((rep) => rep.kind === 'authenticationBackfill')).toHaveLength(0);
  });
});

// ─── Check 3: output-field reference validation (synthetic Summarize) ──────

describe('validateAndRepair — output-field reference', () => {
  test('case-corrects {{ $json.subject }} to {{ $json.Subject }} downstream of Gmail simple', () => {
    // Use a Summarize node we control via synthetic schema instead of relying
    // on schemaIndex.json having Gmail (which the real test infrastructure
    // can't load in some sandboxed runs).
    const summarizeDef = makeNodeDef({ name: 'workflows-nodes-base.summarize' });
    const setDef = makeNodeDef({ name: 'workflows-nodes-base.set' });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Summarize',
          type: 'workflows-nodes-base.summarize',
          typeVersion: 1,
          position: [0, 0],
          parameters: {
            fieldsToSummarize: {
              values: [{ aggregation: 'concatenate', field: 'Subject' }],
            },
          },
        },
        {
          name: 'Send',
          type: 'workflows-nodes-base.set',
          typeVersion: 1,
          position: [200, 0],
          parameters: {
            assignments: {
              assignments: [
                {
                  name: 'msg',
                  // Lowercase 'concatenated_subject' is wrong — Summarize emits 'concatenated_Subject'
                  value: '={{ $json.concatenated_subject }}',
                },
              ],
            },
          },
        },
      ],
      connections: {
        Summarize: { main: [[{ node: 'Send', type: 'main', index: 0 }]] },
      },
    });
    const r = validateAndRepair(wf, [summarizeDef, setDef], NO_CTX);
    const fixed = r.repairs.find((rep) => rep.kind === 'fieldNameCaseFix');
    expect(fixed).toBeDefined();
    const sendValue = (
      (wf.nodes[1].parameters as Record<string, unknown>).assignments as {
        assignments: Array<{ value: string }>;
      }
    ).assignments[0].value;
    expect(sendValue).toContain('concatenated_Subject');
    expect(sendValue).not.toContain('concatenated_subject');
  });

  test('catches bracket-notation expression {{ $json["X"] }} (not just dot notation)', () => {
    const summarizeDef = makeNodeDef({ name: 'workflows-nodes-base.summarize' });
    const setDef = makeNodeDef({ name: 'workflows-nodes-base.set' });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Summarize',
          type: 'workflows-nodes-base.summarize',
          typeVersion: 1,
          position: [0, 0],
          parameters: {
            fieldsToSummarize: {
              values: [{ aggregation: 'concatenate', field: 'Subject' }],
            },
          },
        },
        {
          name: 'Send',
          type: 'workflows-nodes-base.set',
          typeVersion: 1,
          position: [200, 0],
          parameters: {
            assignments: {
              assignments: [
                {
                  name: 'msg',
                  // Bracket notation (regression target — old regex missed this)
                  value: '={{ $json["concatenated_subject"] }}',
                },
              ],
            },
          },
        },
      ],
      connections: {
        Summarize: { main: [[{ node: 'Send', type: 'main', index: 0 }]] },
      },
    });
    const r = validateAndRepair(wf, [summarizeDef, setDef], NO_CTX);
    const fixed = r.repairs.find((rep) => rep.kind === 'fieldNameCaseFix');
    expect(fixed).toBeDefined();
    const sendValue = (
      (wf.nodes[1].parameters as Record<string, unknown>).assignments as {
        assignments: Array<{ value: string }>;
      }
    ).assignments[0].value;
    expect(sendValue).toContain('concatenated_Subject');
  });

  test('Summarize.field "subject" case-corrects to "Subject" against Gmail simple-mode upstream', () => {
    // Real S21 dogfood case: LLM picked field: "subject" lowercase but
    // Gmail simple-mode runtime emits "Subject" capital. The static
    // schemaIndex says lowercase "subject"; the simple-mode override
    // layer must win so Layer 1 catches the case mismatch.
    const gmailDef = makeNodeDef({ name: 'workflows-nodes-base.gmail' });
    const summarizeDef = makeNodeDef({ name: 'workflows-nodes-base.summarize' });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Gmail',
          type: 'workflows-nodes-base.gmail',
          typeVersion: 2.1,
          position: [0, 0],
          parameters: {
            resource: 'message',
            operation: 'getAll',
            simple: true,
          },
        },
        {
          name: 'Summarize',
          type: 'workflows-nodes-base.summarize',
          typeVersion: 1,
          position: [200, 0],
          parameters: {
            fieldsToSummarize: {
              values: [{ aggregation: 'concatenate', field: 'subject' }],
            },
          },
        },
      ],
      connections: {
        Gmail: { main: [[{ node: 'Summarize', type: 'main', index: 0 }]] },
      },
    });
    const r = validateAndRepair(wf, [gmailDef, summarizeDef], NO_CTX);
    const fixed = r.repairs.find((rep) => rep.kind === 'aggregationSourceFieldCaseFix');
    expect(fixed).toBeDefined();
    const fieldVal = (
      (wf.nodes[1].parameters as Record<string, unknown>).fieldsToSummarize as {
        values: Array<{ field: string }>;
      }
    ).values[0].field;
    expect(fieldVal).toBe('Subject');
  });

  test('Summarize.fieldsToSummarize.values[].field case-corrects against upstream', () => {
    // Synthetic schema for upstream "Source" Set node: emits "Subject" capital
    const sourceDef = makeNodeDef({ name: 'workflows-nodes-base.set' });
    const summarizeDef = makeNodeDef({ name: 'workflows-nodes-base.summarize' });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Source',
          type: 'workflows-nodes-base.set',
          typeVersion: 1,
          position: [0, 0],
          parameters: {
            assignments: {
              assignments: [{ name: 'Subject', value: 'foo' }],
            },
          },
        },
        {
          name: 'Summarize',
          type: 'workflows-nodes-base.summarize',
          typeVersion: 1,
          position: [200, 0],
          parameters: {
            // Wrong case — should auto-correct to 'Subject'
            fieldsToSummarize: {
              values: [{ aggregation: 'concatenate', field: 'subject' }],
            },
          },
        },
      ],
      connections: {
        Source: { main: [[{ node: 'Summarize', type: 'main', index: 0 }]] },
      },
    });
    const r = validateAndRepair(wf, [sourceDef, summarizeDef], NO_CTX);
    const fixed = r.repairs.find((rep) => rep.kind === 'aggregationSourceFieldCaseFix');
    expect(fixed).toBeDefined();
    const fieldVal = (
      (wf.nodes[1].parameters as Record<string, unknown>).fieldsToSummarize as {
        values: Array<{ field: string }>;
      }
    ).values[0].field;
    expect(fieldVal).toBe('Subject');
  });

  test('flags unknown field as ValidationError (not auto-fixed)', () => {
    const summarizeDef = makeNodeDef({ name: 'workflows-nodes-base.summarize' });
    const setDef = makeNodeDef({ name: 'workflows-nodes-base.set' });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Summarize',
          type: 'workflows-nodes-base.summarize',
          typeVersion: 1,
          position: [0, 0],
          parameters: {
            fieldsToSummarize: {
              values: [{ aggregation: 'concatenate', field: 'Subject' }],
            },
          },
        },
        {
          name: 'Send',
          type: 'workflows-nodes-base.set',
          typeVersion: 1,
          position: [200, 0],
          parameters: {
            assignments: {
              assignments: [{ name: 'msg', value: '={{ $json.totally_bogus }}' }],
            },
          },
        },
      ],
      connections: {
        Summarize: { main: [[{ node: 'Send', type: 'main', index: 0 }]] },
      },
    });
    const r = validateAndRepair(wf, [summarizeDef, setDef], NO_CTX);
    const err = r.errors.find((e) => e.kind === 'unknownOutputField');
    expect(err).toBeDefined();
    expect(err?.expression).toContain('totally_bogus');
  });
});

// ─── Check 5: node-name uniqueness ─────────────────────────────────────────

describe('validateAndRepair — node-name uniqueness', () => {
  test('renames duplicate node names with (2) suffix', () => {
    const def = makeNodeDef({ name: 'workflows-nodes-base.test' });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'Step',
          type: 'workflows-nodes-base.test',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          name: 'Step',
          type: 'workflows-nodes-base.test',
          typeVersion: 1,
          position: [200, 0],
          parameters: {},
        },
      ],
    });
    const r = validateAndRepair(wf, [def], NO_CTX);
    expect(wf.nodes[0].name).toBe('Step');
    expect(wf.nodes[1].name).toBe('Step (2)');
    expect(r.repairs.find((rep) => rep.kind === 'nodeNameDeduplication')).toBeDefined();
  });
});

// ─── Check 6: connection sanity ────────────────────────────────────────────

describe('validateAndRepair — connection sanity', () => {
  test('drops edges to non-existent nodes', () => {
    const def = makeNodeDef({ name: 'workflows-nodes-base.test' });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'A',
          type: 'workflows-nodes-base.test',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
        {
          name: 'B',
          type: 'workflows-nodes-base.test',
          typeVersion: 1,
          position: [200, 0],
          parameters: {},
        },
      ],
      connections: {
        A: {
          main: [
            [
              { node: 'B', type: 'main', index: 0 },
              { node: 'Ghost', type: 'main', index: 0 },
            ],
          ],
        },
      },
    });
    const r = validateAndRepair(wf, [def], NO_CTX);
    expect(wf.connections.A.main[0]).toHaveLength(1);
    expect(wf.connections.A.main[0][0].node).toBe('B');
    expect(r.repairs.find((rep) => rep.kind === 'droppedDanglingEdge')).toBeDefined();
  });
});

// ─── End-to-end no-op ──────────────────────────────────────────────────────

describe('validateAndRepair — no-op on clean workflow', () => {
  test('clean workflow → empty repairs and errors', () => {
    const def = makeNodeDef({ name: 'workflows-nodes-base.test', version: [1, 2] });
    const wf = makeWorkflow({
      nodes: [
        {
          name: 'X',
          type: 'workflows-nodes-base.test',
          typeVersion: 2,
          position: [0, 0],
          parameters: {},
        },
      ],
    });
    const r = validateAndRepair(wf, [def], NO_CTX);
    expect(r.repairs).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});
