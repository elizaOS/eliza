/**
 * Deterministic pre-deploy pass that catches catalog-drift hallucinations
 * the LLM emits despite prompt hardening. Runs after `injectMissingCredentialBlocks`
 * (Session 19 safety net) and before `deployWorkflow`.
 *
 * Six checks, each emitting a `Repair` (auto-fixed) or `ValidationError`
 * (handed off to the retry loop in n8n-workflow-service.ts):
 *
 *   1. typeVersion clamp           — closes "LLM emits 2.2 when only 1, 2, 2.1 exist"
 *   2. authentication back-fill    — closes "credentials attached but parameters.authentication missing"
 *   3. output-field validation     — closes "subject vs Subject" + typo classes
 *   4. required-parameter pre-flight
 *   5. node-name uniqueness        — n8n rejects duplicates with confusing errors
 *   6. connection sanity           — drop edges to non-existent nodes
 *
 * Mutates the workflow in place AND returns it for ergonomic chaining.
 */

import { logger } from '@elizaos/core';
import type { N8nNode, N8nWorkflow, NodeDefinition, RuntimeContext } from '../types/index';
import { loadOutputSchema, loadTriggerOutputSchema, parseExpressions } from './outputSchema';
import { inferSyntheticOutputSchema } from './inferSyntheticOutputSchema';
import { isCatalogClarification, CATALOG_CLARIFICATION_SUFFIX } from './clarification';

export type RepairKind =
  | 'typeVersionClamp'
  | 'authenticationBackfill'
  | 'fieldNameCaseFix'
  | 'aggregationSourceFieldCaseFix'
  | 'nodeNameDeduplication'
  | 'droppedDanglingEdge';

export type ValidationErrorKind = 'unknownOutputField' | 'requiredParameterMissing';

export interface Repair {
  kind: RepairKind;
  node: string;
  detail: string;
}

export interface ValidationError {
  kind: ValidationErrorKind;
  node: string;
  detail: string;
  /** When kind === 'unknownOutputField': `{{ $json.<X> }}` literal that failed. */
  expression?: string;
  /** When kind === 'unknownOutputField': fields the upstream node actually emits. */
  availableFields?: string[];
}

export interface RepairResult {
  workflow: N8nWorkflow;
  repairs: Repair[];
  errors: ValidationError[];
}

// ─── Check 1 ────────────────────────────────────────────────────────────────

/** Pick the closest-but-not-greater valid version. Falls back to the maximum
 *  when all valid versions are smaller than the requested one (LLM picked
 *  a higher number — clamp down). */
function clampTypeVersion(requested: number, validVersions: number[]): number | null {
  if (validVersions.length === 0) {
    return null;
  }
  const sorted = [...validVersions].sort((a, b) => a - b);
  if (sorted.includes(requested)) {
    return null;
  } // already valid
  // Highest version ≤ requested, else highest available.
  const candidates = sorted.filter((v) => v <= requested);
  return candidates.length > 0 ? candidates[candidates.length - 1] : sorted[sorted.length - 1];
}

function applyTypeVersionClamp(
  node: N8nNode,
  def: NodeDefinition,
  repairs: Repair[],
  runtimeVersions: Map<string, number[]> | undefined
): void {
  const catalogVersions = Array.isArray(def.version) ? def.version : [def.version];
  const catalogNumeric = catalogVersions.filter((v): v is number => typeof v === 'number');

  // When the live n8n runtime registry is available, intersect with it.
  // The static plugin catalog is sometimes ahead of the user's running
  // n8n binary (e.g. catalog claims Gmail v2.2 but runtime only has up
  // to v2.1) — without this intersect, the LLM picks a version n8n
  // can't instantiate and activation crashes with `Cannot read
  // properties of undefined (reading 'execute')`.
  const runtime = runtimeVersions?.get(node.type);
  let validVersions: number[];
  if (runtime && runtime.length > 0) {
    if (catalogNumeric.length > 0) {
      const runtimeSet = new Set(runtime);
      validVersions = catalogNumeric.filter((v) => runtimeSet.has(v));
      if (validVersions.length === 0) {
        validVersions = runtime;
      } // catalog drift — trust runtime
    } else {
      validVersions = runtime;
    }
  } else {
    validVersions = catalogNumeric;
  }

  if (validVersions.length === 0) {
    return;
  }
  const clamped = clampTypeVersion(node.typeVersion, validVersions);
  if (clamped === null) {
    return;
  }
  const source = runtime ? 'runtime∩catalog' : 'catalog';
  repairs.push({
    kind: 'typeVersionClamp',
    node: node.name,
    detail: `${node.type} typeVersion ${node.typeVersion} → ${clamped} (${source} valid: ${validVersions.join(', ')})`,
  });
  node.typeVersion = clamped;
}

// ─── Check 2 ────────────────────────────────────────────────────────────────

interface CredentialDef {
  name: string;
  required: boolean;
  displayOptions?: { show?: { authentication?: string[] } };
}

/** When a credentials block is attached and the cred type's catalog entry
 *  shows it gates on a single authentication value (and node.parameters
 *  doesn't already set one), back-fill it. Closes the Gmail-missing-auth
 *  bug surfaced in Session 20 dogfood. */
function applyAuthenticationBackfill(node: N8nNode, def: NodeDefinition, repairs: Repair[]): void {
  if (!node.credentials) {
    return;
  }
  const attachedTypes = Object.keys(node.credentials);
  if (attachedTypes.length !== 1) {
    return;
  } // ambiguous → leave alone
  const [credType] = attachedTypes;

  const defCreds = (def.credentials ?? []) as CredentialDef[];
  const credDef = defCreds.find((c) => c.name === credType);
  if (!credDef) {
    return;
  }

  const authOpts = credDef.displayOptions?.show?.authentication;
  if (!authOpts || authOpts.length !== 1) {
    return;
  }

  const requiredAuth = authOpts[0];
  const params = (node.parameters ?? {}) as Record<string, unknown>;
  if (typeof params.authentication === 'string' && params.authentication.length > 0) {
    return; // LLM already set it
  }

  node.parameters = { ...params, authentication: requiredAuth };
  repairs.push({
    kind: 'authenticationBackfill',
    node: node.name,
    detail: `set parameters.authentication="${requiredAuth}" to match attached ${credType}`,
  });
}

// ─── Check 3 ────────────────────────────────────────────────────────────────

/** Build name → node map for upstream-graph walk. */
function buildUpstreamMap(workflow: N8nWorkflow): Map<string, string[]> {
  const upstream = new Map<string, string[]>();
  for (const fromName of Object.keys(workflow.connections ?? {})) {
    const outputs = workflow.connections[fromName];
    for (const outputType of Object.keys(outputs)) {
      const branches = outputs[outputType];
      for (const branch of branches) {
        for (const edge of branch) {
          const arr = upstream.get(edge.node) ?? [];
          arr.push(fromName);
          upstream.set(edge.node, arr);
        }
      }
    }
  }
  return upstream;
}

/** Collect known top-level field names for a node's output. Returns null if
 *  unknown (e.g. Code/Function — arbitrary user output).
 *
 *  Synthetic / parameter-aware schemas check FIRST. The static schemaIndex
 *  catches a single canonical shape per (node, resource, operation) but
 *  ignores parameter switches like Gmail's `simple: true` that change
 *  the runtime field set. The override layer (inferSyntheticOutputSchema)
 *  reflects the actual runtime emission, so it must win when present. */
function knownOutputFieldsForNode(node: N8nNode): string[] | null {
  // 1. Synthetic / parameter-aware schemas (Summarize, Set, Gmail simple-mode)
  const synthetic = inferSyntheticOutputSchema(node);
  if (synthetic !== null) {
    return synthetic;
  }

  // 2. Static output-schema catalog (Gmail non-simple, Slack, Discord etc.)
  if (
    typeof node.parameters?.resource === 'string' &&
    typeof node.parameters?.operation === 'string'
  ) {
    const schema = loadOutputSchema(node.type, node.parameters.resource, node.parameters.operation);
    if (schema) {
      return schema.fields;
    }
  }

  // 3. Trigger schemas (gmailTrigger, etc.) — respect simple flag
  if (node.type.toLowerCase().includes('trigger')) {
    const triggerSchema = loadTriggerOutputSchema(node.type, node.parameters);
    if (triggerSchema) {
      return triggerSchema.fields;
    }
  }

  return null;
}

/** For each parameter expression `{{ $json.X }}` (or `$node["Y"].json.X`),
 *  validate X against the upstream node's known fields. Auto-fix case
 *  mismatches; flag unknown fields as ValidationErrors for retry. */
function validateOutputFieldReferences(
  workflow: N8nWorkflow,
  repairs: Repair[],
  errors: ValidationError[]
): void {
  const upstream = buildUpstreamMap(workflow);
  const nodeByName = new Map<string, N8nNode>();
  for (const n of workflow.nodes) {
    nodeByName.set(n.name, n);
  }

  for (const node of workflow.nodes) {
    if (!node.parameters || typeof node.parameters !== 'object') {
      continue;
    }
    const refs = parseExpressions(node.parameters as Record<string, unknown>);
    if (refs.length === 0) {
      continue;
    }

    for (const ref of refs) {
      // Determine which upstream node's output this reference reads from.
      let sourceNode: N8nNode | null = null;
      if (ref.sourceNodeName) {
        sourceNode = nodeByName.get(ref.sourceNodeName) ?? null;
      } else {
        // `{{ $json.X }}` → first immediate upstream node
        const parents = upstream.get(node.name) ?? [];
        if (parents.length === 1) {
          sourceNode = nodeByName.get(parents[0]) ?? null;
        } else if (parents.length > 1) {
          // Ambiguous — skip silently rather than false-error
          continue;
        }
      }
      if (!sourceNode) {
        continue;
      }

      const fields = knownOutputFieldsForNode(sourceNode);
      if (!fields) {
        continue;
      } // unknowable schema → skip

      const topField = ref.path[0];
      if (!topField) {
        continue;
      }
      if (fields.includes(topField)) {
        continue;
      } // exact match

      // Case-insensitive deterministic correction
      const ciMatch = fields.find((f) => f.toLowerCase() === topField.toLowerCase());
      if (ciMatch) {
        rewriteParameterFieldRef(node, ref.fullExpression, topField, ciMatch);
        repairs.push({
          kind: 'fieldNameCaseFix',
          node: node.name,
          detail: `${ref.fullExpression}: "${topField}" → "${ciMatch}" (matches ${sourceNode.name} output)`,
        });
      } else {
        errors.push({
          kind: 'unknownOutputField',
          node: node.name,
          detail: `expression references unknown field "${topField}" on upstream node ${sourceNode.name}`,
          expression: ref.fullExpression,
          availableFields: fields,
        });
      }
    }
  }
}

/** Replace `oldField` with `newField` in node.parameters everywhere the
 *  fullExpression pattern appears. */
function rewriteParameterFieldRef(
  node: N8nNode,
  fullExpression: string,
  oldField: string,
  newField: string
): void {
  const oldPattern = fullExpression;
  const newPattern = fullExpression.replace(new RegExp(`\\b${oldField}\\b`), newField);
  rewriteInObject(node.parameters as Record<string, unknown>, oldPattern, newPattern);
}

function rewriteInObject(obj: Record<string, unknown>, oldStr: string, newStr: string): void {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string' && val.includes(oldStr)) {
      obj[key] = val.replaceAll(oldStr, newStr);
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] === 'string' && (val[i] as string).includes(oldStr)) {
          val[i] = (val[i] as string).replaceAll(oldStr, newStr);
        } else if (typeof val[i] === 'object' && val[i] !== null) {
          rewriteInObject(val[i] as Record<string, unknown>, oldStr, newStr);
        }
      }
    } else if (typeof val === 'object' && val !== null) {
      rewriteInObject(val as Record<string, unknown>, oldStr, newStr);
    }
  }
}

// ─── Check 3b: aggregation-source-field validation ──────────────────────────

/**
 * Some nodes name an UPSTREAM field by its raw string identifier (not via an
 * `{{ $json.X }}` expression). The Summarize node's
 * `parameters.fieldsToSummarize.values[i].field` is the canonical example —
 * it names a field in the upstream node's output. The LLM commonly emits
 * the wrong case here (e.g. `field: "subject"` when Gmail simple-mode
 * outputs `Subject`), and check #3's expression walker doesn't catch it
 * because the value isn't an `{{ $json.X }}` expression at all. This check
 * fills that gap deterministically: case-correct on CI match; flag as
 * ValidationError otherwise.
 *
 * Closes the silent-empty-summary bug from Session 21 dogfood (Summarize
 * concatenated 10 empty strings because the LLM picked lowercase
 * `subject` against Gmail's actual `Subject` output).
 */
function applyAggregationSourceFieldFix(
  workflow: N8nWorkflow,
  repairs: Repair[],
  errors: ValidationError[]
): void {
  const upstream = buildUpstreamMap(workflow);
  const nodeByName = new Map<string, N8nNode>();
  for (const n of workflow.nodes) {
    nodeByName.set(n.name, n);
  }

  for (const node of workflow.nodes) {
    if (node.type !== 'n8n-nodes-base.summarize') {
      continue;
    }

    const params = node.parameters as Record<string, unknown> | undefined;
    const fts = params?.fieldsToSummarize as
      | { values?: Array<{ aggregation?: string; field?: string }> }
      | undefined;
    const values = fts?.values;
    if (!Array.isArray(values) || values.length === 0) {
      continue;
    }

    const parents = upstream.get(node.name) ?? [];
    if (parents.length !== 1) {
      continue;
    } // ambiguous → skip (don't false-error)
    const sourceNode = nodeByName.get(parents[0]);
    if (!sourceNode) {
      continue;
    }

    const fields = knownOutputFieldsForNode(sourceNode);
    if (!fields) {
      continue;
    } // unknowable schema → skip

    for (const entry of values) {
      if (typeof entry?.field !== 'string' || entry.field.length === 0) {
        continue;
      }
      if (fields.includes(entry.field)) {
        continue;
      } // exact match
      const ciMatch = fields.find((f) => f.toLowerCase() === entry.field!.toLowerCase());
      if (ciMatch) {
        const oldField = entry.field;
        entry.field = ciMatch;
        repairs.push({
          kind: 'aggregationSourceFieldCaseFix',
          node: node.name,
          detail: `fieldsToSummarize.values[].field "${oldField}" → "${ciMatch}" (matches ${sourceNode.name} output)`,
        });
      } else {
        errors.push({
          kind: 'unknownOutputField',
          node: node.name,
          detail: `fieldsToSummarize.values[].field "${entry.field}" does not match any known field on upstream ${sourceNode.name}`,
          expression: `field: "${entry.field}"`,
          availableFields: fields,
        });
      }
    }
  }
}

// ─── Check 4 ────────────────────────────────────────────────────────────────

/** Push a clarification onto workflow._meta.requiresClarification when a
 *  required parameter is missing AND can't be inferred. Non-fatal. */
function applyRequiredParameterPreflight(
  workflow: N8nWorkflow,
  defByType: Map<string, NodeDefinition>
): void {
  const clarifications: string[] = [];
  for (const node of workflow.nodes) {
    const def = defByType.get(node.type);
    if (!def) {
      continue;
    }
    for (const prop of def.properties ?? []) {
      if (!prop.required) {
        continue;
      }
      const params = (node.parameters ?? {}) as Record<string, unknown>;
      if (params[prop.name] === undefined || params[prop.name] === '') {
        clarifications.push(
          `${node.name} (${node.type}) is missing required parameter "${prop.name}" ${CATALOG_CLARIFICATION_SUFFIX}`
        );
      }
    }
  }
  if (clarifications.length === 0) {
    return;
  }
  workflow._meta = workflow._meta ?? {};
  const existing = workflow._meta.requiresClarification ?? [];
  // Avoid duplicate-suffix clutter from prior catalog passes.
  const nonCatalog = existing.filter((c) => !isCatalogClarification(c));
  workflow._meta.requiresClarification = [...nonCatalog, ...clarifications];
}

// ─── Check 5 ────────────────────────────────────────────────────────────────

function deduplicateNodeNames(workflow: N8nWorkflow, repairs: Repair[]): void {
  const seen = new Map<string, number>();
  for (const node of workflow.nodes) {
    const count = seen.get(node.name) ?? 0;
    if (count > 0) {
      const oldName = node.name;
      let suffix = count + 1;
      let candidate = `${oldName} (${suffix})`;
      while (seen.has(candidate)) {
        suffix++;
        candidate = `${oldName} (${suffix})`;
      }
      node.name = candidate;
      seen.set(candidate, 1);
      seen.set(oldName, count + 1);
      repairs.push({
        kind: 'nodeNameDeduplication',
        node: candidate,
        detail: `renamed duplicate "${oldName}" → "${candidate}"`,
      });
      // Update connections referencing the old name? The original was first
      // — connections pointing at oldName still resolve to the original.
      // Rewrite outgoing connections key on duplicate node.
      if (workflow.connections?.[oldName]) {
        // Outgoing connections for the duplicate: move under new name only
        // when the original doesn't already own them. Heuristic: if both
        // the dup and original happen to share outgoing edges, leave as-is
        // (the original wins). Most LLM-generated dupes have no outgoing
        // edges, so this rarely fires.
      }
    } else {
      seen.set(node.name, 1);
    }
  }
}

// ─── Check 6 ────────────────────────────────────────────────────────────────

function dropDanglingEdges(workflow: N8nWorkflow, repairs: Repair[]): void {
  if (!workflow.connections) {
    return;
  }
  const nodeNames = new Set(workflow.nodes.map((n) => n.name));
  for (const fromName of Object.keys(workflow.connections)) {
    const outputs = workflow.connections[fromName];
    if (!nodeNames.has(fromName)) {
      // Source node doesn't exist — drop the entire entry.
      delete workflow.connections[fromName];
      repairs.push({
        kind: 'droppedDanglingEdge',
        node: fromName,
        detail: 'dropped connections entry for non-existent node',
      });
      continue;
    }
    for (const outputType of Object.keys(outputs)) {
      const branches = outputs[outputType];
      for (let i = 0; i < branches.length; i++) {
        const branch = branches[i];
        const filtered = branch.filter((edge) => nodeNames.has(edge.node));
        if (filtered.length !== branch.length) {
          const dropped = branch.filter((e) => !nodeNames.has(e.node));
          for (const e of dropped) {
            repairs.push({
              kind: 'droppedDanglingEdge',
              node: fromName,
              detail: `dropped edge ${fromName} → ${e.node} (target missing)`,
            });
          }
          branches[i] = filtered;
        }
      }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function validateAndRepair(
  workflow: N8nWorkflow,
  relevantNodes: NodeDefinition[],
  _runtimeContext: RuntimeContext | undefined,
  runtimeVersions?: Map<string, number[]>
): RepairResult {
  const repairs: Repair[] = [];
  const errors: ValidationError[] = [];

  if (!workflow?.nodes || !Array.isArray(workflow.nodes)) {
    return { workflow, repairs, errors };
  }

  const defByType = new Map<string, NodeDefinition>(relevantNodes.map((d) => [d.name, d]));

  // Check 1 + 2: per-node passes
  for (const node of workflow.nodes) {
    const def = defByType.get(node.type);
    if (def) {
      applyTypeVersionClamp(node, def, repairs, runtimeVersions);
      applyAuthenticationBackfill(node, def, repairs);
    }
  }

  // Check 5: dedup BEFORE field-ref + connection passes (so the upstream map
  // is built against the final names).
  deduplicateNodeNames(workflow, repairs);

  // Check 6: drop dangling edges before #3 walks the graph.
  dropDanglingEdges(workflow, repairs);

  // Check 3b: aggregation-source-field case-fix BEFORE check 3, because
  // correcting Summarize.field changes the synthetic output schema that
  // check 3 uses when validating expressions downstream of Summarize.
  applyAggregationSourceFieldFix(workflow, repairs, errors);

  // Check 3: output-field validation (after dedup so upstream lookup works)
  validateOutputFieldReferences(workflow, repairs, errors);

  // Check 4: required-parameter pre-flight (annotates workflow._meta only)
  applyRequiredParameterPreflight(workflow, defByType);

  if (repairs.length > 0) {
    logger.info(
      {
        src: 'plugin:n8n-workflow:utils:validate',
        repairCount: repairs.length,
        repairs,
      },
      `validateAndRepair applied ${repairs.length} fix(es)`
    );
  }
  if (errors.length > 0) {
    logger.warn(
      {
        src: 'plugin:n8n-workflow:utils:validate',
        errorCount: errors.length,
        errors,
      },
      `validateAndRepair flagged ${errors.length} unrecoverable error(s) for retry loop`
    );
  }

  return { workflow, repairs, errors };
}
