/** Exercises Set/Edit Fields shape normalization and fail-closed value validation without a model or persistence backend. */
import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition, WorkflowNode } from '../../src/types/index';
import { normalizeSetNodeParametersInWorkflow } from '../../src/utils/setNodeParameters';
import { validateWorkflow } from '../../src/utils/workflow';

function workflow(parameters: Record<string, unknown>, type = 'workflows-nodes-base.set') {
  const node: WorkflowNode = {
    name: 'Set Result',
    type,
    typeVersion: 3.4,
    position: [200, 0],
    parameters,
  };
  return {
    name: 'Set parameter proof',
    nodes: [node],
    connections: {},
  } satisfies WorkflowDefinition;
}

function assignments(definition: WorkflowDefinition): Array<Record<string, unknown>> {
  return (
    definition.nodes[0].parameters.assignments as {
      assignments: Array<Record<string, unknown>>;
    }
  ).assignments;
}

describe('Set/Edit Fields parameter normalization', () => {
  test('recovers the typed value from the exact generated assignment shape', () => {
    const definition = workflow({
      assignments: {
        assignments: [
          {
            name: 'message',
            type: 'stringValue',
            stringValue: 'smithers-final-20260717',
          },
        ],
      },
    });

    const result = normalizeSetNodeParametersInWorkflow(definition);

    expect(result.issues).toEqual([]);
    expect(assignments(definition)).toEqual([
      { name: 'message', type: 'string', value: 'smithers-final-20260717' },
    ]);
  });

  test('preserves explicit empty string, false, and zero values', () => {
    const definition = workflow({
      fields: {
        values: [
          { name: 'empty', type: 'stringValue', stringValue: '' },
          { name: 'enabled', type: 'booleanValue', booleanValue: false },
          { name: 'count', type: 'numberValue', numberValue: 0 },
        ],
      },
    });

    const result = normalizeSetNodeParametersInWorkflow(definition);

    expect(result.issues).toEqual([]);
    expect(assignments(definition)).toEqual([
      { name: 'empty', type: 'string', value: '' },
      { name: 'enabled', type: 'boolean', value: false },
      { name: 'count', type: 'number', value: 0 },
    ]);
    expect(definition.nodes[0]?.parameters.fields).toBeUndefined();
  });

  test('normalizes Edit Fields grouped legacy values into executable assignments', () => {
    const definition = workflow(
      {
        values: {
          string: [{ name: 'source', value: 'legacy' }],
          boolean: [{ name: 'verified', value: true }],
        },
      },
      'workflows-nodes-base.editFields'
    );

    const result = normalizeSetNodeParametersInWorkflow(definition);

    expect(result.issues).toEqual([]);
    expect(assignments(definition)).toEqual([
      { name: 'source', value: 'legacy', type: 'string' },
      { name: 'verified', value: true, type: 'boolean' },
    ]);
    expect(definition.nodes[0]?.parameters.values).toBeUndefined();
  });

  test('rejects a generated assignment whose type is present but value is absent', () => {
    const definition = workflow({
      assignments: {
        assignments: [{ name: 'message', type: 'stringValue' }],
      },
    });

    const normalized = normalizeSetNodeParametersInWorkflow(definition);
    const validated = validateWorkflow(definition);

    expect(normalized.issues).toEqual([
      expect.objectContaining({
        kind: 'assignmentValueMissing',
        node: 'Set Result',
        path: 'parameters.assignments.assignments[0].value',
      }),
    ]);
    expect(validated.valid).toBe(false);
    expect(validated.errors).toContain(
      'Node "Set Result": parameters.assignments.assignments[0] for field "message" must include an explicit value; use value: "" for an intentional empty string'
    );
  });
});
