/**
 * Canonicalizes Set/Edit Fields parameters at the model and persistence boundary.
 * The catalog has changed collection shapes across node versions, but the embedded
 * executor consumes one explicit `{ name, value }` assignment representation.
 */
import type { WorkflowDefinition, WorkflowNode } from '../types/index';

const SET_NODE_TYPES = new Set(['workflows-nodes-base.set', 'workflows-nodes-base.editFields']);

const TYPED_VALUE_KEYS = [
  'stringValue',
  'numberValue',
  'booleanValue',
  'arrayValue',
  'objectValue',
] as const;

const ASSIGNMENT_TYPE_BY_VALUE_KEY: Record<(typeof TYPED_VALUE_KEYS)[number], string> = {
  stringValue: 'string',
  numberValue: 'number',
  booleanValue: 'boolean',
  arrayValue: 'array',
  objectValue: 'object',
};

const VALUE_KEY_BY_ASSIGNMENT_TYPE: Record<string, (typeof TYPED_VALUE_KEYS)[number]> = {
  string: 'stringValue',
  stringValue: 'stringValue',
  number: 'numberValue',
  numberValue: 'numberValue',
  boolean: 'booleanValue',
  booleanValue: 'booleanValue',
  array: 'arrayValue',
  arrayValue: 'arrayValue',
  object: 'objectValue',
  objectValue: 'objectValue',
};

export type SetNodeParameterIssueKind =
  | 'assignmentEntryInvalid'
  | 'assignmentNameMissing'
  | 'assignmentValueMissing'
  | 'parameterShapeInvalid';

export interface SetNodeParameterIssue {
  kind: SetNodeParameterIssueKind;
  node: string;
  path: string;
  detail: string;
}

export interface SetNodeParameterResult {
  corrections: number;
  issues: SetNodeParameterIssue[];
}

interface AssignmentSource {
  entries: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function issue(
  node: WorkflowNode,
  kind: SetNodeParameterIssueKind,
  path: string,
  detail: string
): SetNodeParameterIssue {
  return { kind, node: node.name, path, detail };
}

function normalizeAssignment(
  node: WorkflowNode,
  rawEntry: unknown,
  index: number
): { entry: unknown; corrections: number; issues: SetNodeParameterIssue[] } {
  const path = `parameters.assignments.assignments[${index}]`;
  if (!isRecord(rawEntry)) {
    return {
      entry: rawEntry,
      corrections: 0,
      issues: [issue(node, 'assignmentEntryInvalid', path, `${path} must be an object`)],
    };
  }

  const entry = { ...rawEntry };
  const issues: SetNodeParameterIssue[] = [];
  let corrections = 0;

  if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
    issues.push(
      issue(
        node,
        'assignmentNameMissing',
        `${path}.name`,
        `${path} must include a non-empty field name`
      )
    );
  }

  const rawType = typeof entry.type === 'string' ? entry.type : undefined;
  const selectedValueKey = rawType ? VALUE_KEY_BY_ASSIGNMENT_TYPE[rawType] : undefined;
  const presentValueKeys = TYPED_VALUE_KEYS.filter(
    (key) => hasOwn(entry, key) && entry[key] !== undefined
  );
  const typedValueKey =
    selectedValueKey && hasOwn(entry, selectedValueKey) && entry[selectedValueKey] !== undefined
      ? selectedValueKey
      : presentValueKeys.length === 1
        ? presentValueKeys[0]
        : undefined;

  if ((!hasOwn(entry, 'value') || entry.value === undefined) && typedValueKey) {
    entry.value = entry[typedValueKey];
    corrections++;
  }

  if (rawType && selectedValueKey) {
    const normalizedType = ASSIGNMENT_TYPE_BY_VALUE_KEY[selectedValueKey];
    if (entry.type !== normalizedType) {
      entry.type = normalizedType;
      corrections++;
    }
  }

  for (const valueKey of TYPED_VALUE_KEYS) {
    if (hasOwn(entry, valueKey)) {
      delete entry[valueKey];
      corrections++;
    }
  }

  if (!hasOwn(entry, 'value') || entry.value === undefined) {
    const fieldLabel =
      typeof entry.name === 'string' && entry.name.trim().length > 0
        ? ` for field "${entry.name}"`
        : '';
    issues.push(
      issue(
        node,
        'assignmentValueMissing',
        `${path}.value`,
        `${path}${fieldLabel} must include an explicit value; use value: "" for an intentional empty string`
      )
    );
  }

  return { entry, corrections, issues };
}

function collectAssignmentSources(
  node: WorkflowNode,
  params: Record<string, unknown>,
  issues: SetNodeParameterIssue[]
): { sources: AssignmentSource[]; legacyKeys: Set<'fields' | 'values'>; corrections: number } {
  const sources: AssignmentSource[] = [];
  const legacyKeys = new Set<'fields' | 'values'>();
  let corrections = 0;

  const assignments = params.assignments;
  if (Array.isArray(assignments)) {
    sources.push({ entries: assignments });
    corrections++;
  } else if (isRecord(assignments)) {
    if (Array.isArray(assignments.assignments)) {
      sources.push({
        entries: assignments.assignments,
      });
    }
    if (Array.isArray(assignments.values)) {
      sources.push({ entries: assignments.values });
      corrections++;
    }
    if (assignments.assignments !== undefined && !Array.isArray(assignments.assignments)) {
      issues.push(
        issue(
          node,
          'parameterShapeInvalid',
          'parameters.assignments.assignments',
          'parameters.assignments.assignments must be an array'
        )
      );
    }
    if (assignments.values !== undefined && !Array.isArray(assignments.values)) {
      issues.push(
        issue(
          node,
          'parameterShapeInvalid',
          'parameters.assignments.values',
          'parameters.assignments.values must be an array'
        )
      );
    }
  } else if (assignments !== undefined) {
    issues.push(
      issue(
        node,
        'parameterShapeInvalid',
        'parameters.assignments',
        'parameters.assignments must be an object or array'
      )
    );
  }

  const fields = params.fields;
  if (isRecord(fields)) {
    if (Array.isArray(fields.values)) {
      sources.push({ entries: fields.values });
      legacyKeys.add('fields');
      corrections++;
    } else if (fields.values !== undefined) {
      issues.push(
        issue(
          node,
          'parameterShapeInvalid',
          'parameters.fields.values',
          'parameters.fields.values must be an array'
        )
      );
    } else if (Object.keys(fields).length > 0) {
      sources.push({
        entries: Object.entries(fields).map(([name, value]) => ({ name, value })),
      });
      legacyKeys.add('fields');
      corrections++;
    }
  } else if (fields !== undefined) {
    issues.push(
      issue(
        node,
        'parameterShapeInvalid',
        'parameters.fields',
        'parameters.fields must be an object'
      )
    );
  }

  const values = params.values;
  if (isRecord(values)) {
    for (const [groupName, groupEntries] of Object.entries(values)) {
      if (!Array.isArray(groupEntries)) {
        issues.push(
          issue(
            node,
            'parameterShapeInvalid',
            `parameters.values.${groupName}`,
            `parameters.values.${groupName} must be an array`
          )
        );
        continue;
      }
      const valueKey = VALUE_KEY_BY_ASSIGNMENT_TYPE[groupName];
      sources.push({
        entries: groupEntries.map((entry) =>
          valueKey && isRecord(entry) && !hasOwn(entry, 'type')
            ? { ...entry, type: valueKey }
            : entry
        ),
      });
      legacyKeys.add('values');
      corrections++;
    }
  } else if (values !== undefined) {
    issues.push(
      issue(
        node,
        'parameterShapeInvalid',
        'parameters.values',
        'parameters.values must be an object'
      )
    );
  }

  return { sources, legacyKeys, corrections };
}

/** Normalizes one Set/Edit Fields node and reports any semantics it cannot recover. */
export function normalizeSetNodeParameters(node: WorkflowNode): SetNodeParameterResult {
  if (!SET_NODE_TYPES.has(node.type) || !isRecord(node.parameters)) {
    return { corrections: 0, issues: [] };
  }

  const issues: SetNodeParameterIssue[] = [];
  const {
    sources,
    legacyKeys,
    corrections: sourceCorrections,
  } = collectAssignmentSources(node, node.parameters, issues);
  if (sources.length === 0) {
    return { corrections: sourceCorrections, issues };
  }

  const normalizedAssignments: unknown[] = [];
  let corrections = sourceCorrections;
  for (const source of sources) {
    for (const rawEntry of source.entries) {
      const normalized = normalizeAssignment(node, rawEntry, normalizedAssignments.length);
      normalizedAssignments.push(normalized.entry);
      corrections += normalized.corrections;
      issues.push(...normalized.issues);
    }
  }

  const assignmentContainer = isRecord(node.parameters.assignments)
    ? { ...node.parameters.assignments }
    : {};
  delete assignmentContainer.values;
  assignmentContainer.assignments = normalizedAssignments;
  node.parameters.assignments = assignmentContainer;
  for (const legacyKey of legacyKeys) {
    delete node.parameters[legacyKey];
  }

  return { corrections, issues };
}

/** Normalizes every Set/Edit Fields node in a workflow. */
export function normalizeSetNodeParametersInWorkflow(
  workflow: WorkflowDefinition
): SetNodeParameterResult {
  const result: SetNodeParameterResult = { corrections: 0, issues: [] };
  for (const node of workflow.nodes) {
    const nodeResult = normalizeSetNodeParameters(node);
    result.corrections += nodeResult.corrections;
    result.issues.push(...nodeResult.issues);
  }
  return result;
}
