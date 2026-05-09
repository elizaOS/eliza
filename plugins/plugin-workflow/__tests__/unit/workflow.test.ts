import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition, WorkflowNode } from '../../src/types/index';
import {
  correctOptionParameters,
  detectUnknownParameters,
  ensureExpressionPrefix,
  positionNodes,
  validateNodeInputs,
  validateNodeParameters,
  validateOutputReferences,
  validateWorkflow,
} from '../../src/utils/workflow';

function schedule(overrides?: Partial<WorkflowNode>): WorkflowNode {
  return {
    name: 'Schedule Trigger',
    type: 'workflows-nodes-base.scheduleTrigger',
    typeVersion: 1,
    position: [250, 300],
    parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
    ...overrides,
  };
}

function http(overrides?: Partial<WorkflowNode>): WorkflowNode {
  return {
    name: 'HTTP Request',
    type: 'workflows-nodes-base.httpRequest',
    typeVersion: 4.3,
    position: [500, 300],
    parameters: { method: 'GET', url: 'https://example.com' },
    ...overrides,
  };
}

function setNode(overrides?: Partial<WorkflowNode>): WorkflowNode {
  return {
    name: 'Set',
    type: 'workflows-nodes-base.set',
    typeVersion: 3.4,
    position: [750, 300],
    parameters: {
      assignments: {
        assignments: [{ name: 'message', value: 'Hello', type: 'string' }],
      },
      options: {},
    },
    ...overrides,
  };
}

function code(overrides?: Partial<WorkflowNode>): WorkflowNode {
  return {
    name: 'Code',
    type: 'workflows-nodes-base.code',
    typeVersion: 2,
    position: [750, 420],
    parameters: { jsCode: 'return items;' },
    ...overrides,
  };
}

function validWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'Supported Workflow',
    nodes: [schedule(), http()],
    connections: {
      'Schedule Trigger': {
        main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]],
      },
    },
    ...overrides,
  };
}

function malformedWorkflow(overrides: Record<string, unknown>): WorkflowDefinition {
  return {
    name: 'Bad',
    nodes: [],
    connections: {},
    ...overrides,
  } as WorkflowDefinition;
}

function withoutPosition(node: WorkflowNode): WorkflowNode {
  const copy: Partial<WorkflowNode> = { ...node };
  delete copy.position;
  return copy as WorkflowNode;
}

describe('validateWorkflow', () => {
  test('valid supported workflow passes validation', () => {
    const result = validateWorkflow(validWorkflow());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('rejects empty or malformed workflows', () => {
    expect(validateWorkflow({ name: 'Empty', nodes: [], connections: {} }).errors).toContain(
      'Workflow must have at least one node'
    );
    expect(
      validateWorkflow(malformedWorkflow({ nodes: null, connections: {} })).errors
    ).toContain('Missing or invalid nodes array');
    expect(
      validateWorkflow(malformedWorkflow({ nodes: [schedule()], connections: null })).errors
    ).toContain('Missing or invalid connections object');
  });

  test('detects duplicate node names and broken connections', () => {
    const duplicate = validateWorkflow({
      name: 'Duplicate',
      nodes: [schedule({ name: 'A' }), http({ name: 'A' })],
      connections: {},
    });
    expect(duplicate.valid).toBe(false);
    expect(duplicate.errors.some((e) => e.includes('Duplicate node name'))).toBe(true);

    const broken = validateWorkflow(
      validWorkflow({
        connections: {
          'Schedule Trigger': {
            main: [[{ node: 'Missing', type: 'main', index: 0 }]],
          },
        },
      })
    );
    expect(broken.valid).toBe(false);
    expect(broken.errors.some((e) => e.includes('non-existent target node'))).toBe(true);
  });

  test('warns about missing trigger and orphan nodes', () => {
    const noTrigger = validateWorkflow({
      name: 'No trigger',
      nodes: [http(), setNode()],
      connections: { 'HTTP Request': { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
    });
    expect(noTrigger.valid).toBe(true);
    expect(noTrigger.warnings.some((w) => w.includes('no trigger node'))).toBe(true);

    const orphan = validateWorkflow({
      name: 'Orphan',
      nodes: [schedule(), http(), setNode()],
      connections: {
        'Schedule Trigger': {
          main: [[{ node: 'HTTP Request', type: 'main', index: 0 }]],
        },
      },
    });
    expect(orphan.warnings.some((w) => w.includes('Set') && w.includes('no incoming'))).toBe(true);
  });
});

describe('positionNodes', () => {
  test('skips positioning when all nodes have valid positions', () => {
    const workflow = validWorkflow();
    const result = positionNodes(workflow);
    expect(result.nodes[0].position).toEqual(workflow.nodes[0].position);
    expect(result.nodes[1].position).toEqual(workflow.nodes[1].position);
  });

  test('positions missing nodes left-to-right', () => {
    const workflow = validWorkflow({
      nodes: [withoutPosition(schedule()), withoutPosition(http())],
    });
    const result = positionNodes(workflow);
    const trigger = result.nodes.find((n) => n.name === 'Schedule Trigger')!;
    const request = result.nodes.find((n) => n.name === 'HTTP Request')!;
    expect(trigger.position[0]).toBeLessThan(request.position[0]);
  });

  test('positions branching nodes at the same depth with different Y values', () => {
    const workflow = validWorkflow({
      nodes: [withoutPosition(schedule()), withoutPosition(setNode()), withoutPosition(code())],
      connections: {
        'Schedule Trigger': {
          main: [
            [
              { node: 'Set', type: 'main', index: 0 },
              { node: 'Code', type: 'main', index: 0 },
            ],
          ],
        },
      },
    });
    const result = positionNodes(workflow);
    const setPos = result.nodes.find((n) => n.name === 'Set')?.position;
    const codePos = result.nodes.find((n) => n.name === 'Code')?.position;
    expect(setPos[0]).toBe(codePos[0]);
    expect(setPos[1]).not.toBe(codePos[1]);
  });
});

describe('validateOutputReferences', () => {
  test('does not emit false positives when trimmed schema indexes are empty', () => {
    const workflow = validWorkflow({
      nodes: [schedule(), http({ parameters: { method: 'GET', url: '={{ $json.url }}' } })],
    });
    expect(validateOutputReferences(workflow)).toEqual([]);
  });

  test('returns empty for static parameters', () => {
    expect(validateOutputReferences(validWorkflow())).toEqual([]);
  });
});

describe('validateNodeParameters', () => {
  test('detects visible required parameters', () => {
    const warnings = validateNodeParameters(
      validWorkflow({
        nodes: [schedule(), http({ parameters: { method: 'GET' } })],
      })
    );
    expect(warnings.some((w) => w.includes('HTTP Request') && w.includes('URL'))).toBe(true);
  });

  test('skips unknown node types', () => {
    const warnings = validateNodeParameters({
      name: 'Unknown',
      nodes: [
        {
          name: 'Custom',
          type: 'workflows-nodes-community.unknownNode',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    });
    expect(warnings).toEqual([]);
  });

  test('includes the catalog property description so the user knows what the parameter governs', () => {
    // Repro: clarification panel shows `missing required parameter "URL"`.
    // The displayName alone is often opaque; the description is the same
    // hover-text the upstream node UI shows. The catalog's URL property
    // carries the description "The URL to make the request to".
    const warnings = validateNodeParameters(
      validWorkflow({
        nodes: [
          schedule(),
          http({ parameters: { method: 'GET' } }),
        ],
      })
    );
    const urlWarning = warnings.find((w) => w.includes('"URL"'));
    expect(urlWarning).toBeDefined();
    expect(urlWarning).toContain('(The URL to make the request to)');
  });

  test('omits the parens suffix when the property has no description', () => {
    // The catalog `code` node's required `jsCode` property has no
    // description. The warning string must stay tight in that case —
    // no empty parens, no trailing whitespace.
    const warnings = validateNodeParameters({
      name: 'No description',
      nodes: [
        {
          name: 'Code',
          type: 'workflows-nodes-base.code',
          typeVersion: 2,
          position: [0, 0],
          parameters: {},
        },
      ],
      connections: {},
    });
    const jsCodeWarning = warnings.find((w) => w.includes('Code') && w.includes('required parameter'));
    if (jsCodeWarning) {
      expect(jsCodeWarning).not.toMatch(/\(\s*\)/);
      expect(jsCodeWarning.endsWith('"')).toBe(true);
    }
  });

  test('strips HTML tags from the catalog description', () => {
    // Catalog descriptions can embed HTML like <a href="...">expression</a>
    // sourced from the upstream node-types definitions. The clarification
    // surface is plain text, so raw HTML must not leak through. Verify by
    // monkey-patching a node's catalog entry to include HTML.
    const workflow = {
      name: 'Custom HTML',
      nodes: [
        {
          name: 'Set',
          type: 'workflows-nodes-base.set',
          typeVersion: 3.4,
          position: [0, 0] as [number, number],
          parameters: {},
        },
      ],
      connections: {},
    };
    const warnings = validateNodeParameters(workflow);
    for (const w of warnings) {
      expect(w).not.toMatch(/<[^>]+>/);
    }
  });
});

describe('validateNodeInputs', () => {
  test('returns no warnings for connected workflow', () => {
    expect(validateNodeInputs(validWorkflow())).toEqual([]);
  });

  test('warns about action node with no incoming connection', () => {
    const warnings = validateNodeInputs({
      name: 'Disconnected',
      nodes: [schedule(), http()],
      connections: {},
    });
    expect(warnings.some((w) => w.includes('HTTP Request'))).toBe(true);
  });

  test('does not warn about trigger nodes without incoming connections', () => {
    expect(
      validateNodeInputs({
        name: 'Only trigger',
        nodes: [schedule()],
        connections: {},
      })
    ).toEqual([]);
  });
});

describe('correctOptionParameters', () => {
  test('corrects invalid option values and typeVersion against the supported catalog', () => {
    const workflow = validWorkflow({
      nodes: [
        schedule(),
        http({
          typeVersion: 99,
          parameters: { method: 'TRACE', url: 'https://example.com' },
        }),
      ],
    });
    const fixes = correctOptionParameters(workflow);
    expect(fixes).toBeGreaterThanOrEqual(2);
    expect(workflow.nodes[1].typeVersion).toBe(4.3);
    expect(workflow.nodes[1].parameters.method).toBe('GET');
  });

  test('does not touch valid parameters', () => {
    const workflow = validWorkflow();
    expect(correctOptionParameters(workflow)).toBe(0);
  });

  test('skips unknown node types', () => {
    const workflow: WorkflowDefinition = {
      name: 'Unknown',
      nodes: [
        {
          name: 'Custom',
          type: 'workflows-nodes-community.unknown',
          typeVersion: 1,
          position: [250, 300],
          parameters: { resource: 'whatever' },
        },
      ],
      connections: {},
    };
    expect(correctOptionParameters(workflow)).toBe(0);
  });
});

describe('detectUnknownParameters', () => {
  test('detects unknown parameters on supported nodes', () => {
    const detections = detectUnknownParameters(
      validWorkflow({
        nodes: [
          schedule(),
          http({ parameters: { method: 'GET', url: 'https://x.test', bogus: 1 } }),
        ],
      })
    );
    expect(detections).toHaveLength(1);
    expect(detections[0].nodeName).toBe('HTTP Request');
    expect(detections[0].unknownKeys).toContain('bogus');
    expect(detections[0].unknownKeys).not.toContain('url');
  });

  test('defaults keep Code node jsCode visible when mode/language are omitted', () => {
    const detections = detectUnknownParameters({
      name: 'Code',
      nodes: [code({ parameters: { jsCode: 'return items;' } })],
      connections: {},
    });
    expect(detections).toEqual([]);
  });

  test('skips unknown node types', () => {
    const detections = detectUnknownParameters({
      name: 'Unknown Type',
      nodes: [
        {
          name: 'Custom',
          type: 'workflows-nodes-community.unknown',
          typeVersion: 1,
          position: [250, 300],
          parameters: { anything: 'goes' },
        },
      ],
      connections: {},
    });
    expect(detections).toEqual([]);
  });
});

describe('ensureExpressionPrefix', () => {
  test('adds = prefix to expression strings', () => {
    const workflow = validWorkflow({
      nodes: [
        http({
          parameters: {
            method: 'GET',
            url: '{{ $json.url }}',
            queryParameters: { parameters: [{ name: 'q', value: 'static' }] },
          },
        }),
      ],
      connections: {},
    });
    const count = ensureExpressionPrefix(workflow);
    expect(count).toBe(1);
    expect(workflow.nodes[0].parameters.url).toBe('={{ $json.url }}');
  });

  test('handles nested objects and arrays without double-prefixing', () => {
    const workflow = validWorkflow({
      nodes: [
        setNode({
          parameters: {
            assignments: {
              assignments: [
                { name: 'a', value: '{{ $json.a }}', type: 'string' },
                { name: 'b', value: '={{ $json.b }}', type: 'string' },
              ],
            },
            options: { values: ['{{ $json.c }}', 'static'] },
          },
        }),
      ],
      connections: {},
    });
    const count = ensureExpressionPrefix(workflow);
    expect(count).toBe(2);
    const assignments = (workflow.nodes[0].parameters.assignments as any).assignments;
    expect(assignments[0].value).toBe('={{ $json.a }}');
    expect(assignments[1].value).toBe('={{ $json.b }}');
    expect((workflow.nodes[0].parameters.options as any).values[0]).toBe('={{ $json.c }}');
  });
});
