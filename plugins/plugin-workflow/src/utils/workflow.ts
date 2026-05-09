import { logger } from '@elizaos/core';
import type {
  NodeDefinition,
  NodeProperty,
  OutputRefValidation,
  RuntimeContext,
  SchemaContent,
  WorkflowDefinition,
  WorkflowValidationResult,
} from '../types/index';
import { getNodeDefinition, simplifyNodeForLLM } from './catalog';
import {
  fieldExistsInSchema,
  getAllFieldPathsTyped,
  loadOutputSchema,
  loadTriggerOutputSchema,
  parseExpressions,
} from './outputSchema';

function isTriggerNode(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes('trigger') || t.includes('webhook');
}

export function validateWorkflow(workflow: WorkflowDefinition): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check nodes array exists and is non-empty
  if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
    errors.push('Missing or invalid nodes array');
    return { valid: false, errors, warnings };
  }

  if (workflow.nodes.length === 0) {
    errors.push('Workflow must have at least one node');
    return { valid: false, errors, warnings };
  }

  // 2. Check connections structure
  if (!workflow.connections || typeof workflow.connections !== 'object') {
    errors.push('Missing or invalid connections object');
    return { valid: false, errors, warnings };
  }

  // 3. Validate each node
  const nodeNames = new Set<string>();
  const nodeMap = new Map<string, (typeof workflow.nodes)[0]>();

  for (const node of workflow.nodes) {
    // Check required fields
    if (!node.name || typeof node.name !== 'string') {
      errors.push('Node missing name');
      continue;
    }

    if (!node.type || typeof node.type !== 'string') {
      errors.push(`Node "${node.name}" missing type`);
      continue;
    }

    // Check for duplicate names
    if (nodeNames.has(node.name)) {
      errors.push(`Duplicate node name: "${node.name}"`);
    }
    nodeNames.add(node.name);
    nodeMap.set(node.name, node);

    // Check position (positionNodes() will fix this after validation)
    if (!node.position || !Array.isArray(node.position) || node.position.length !== 2) {
      warnings.push(`Node "${node.name}" has invalid position, will be auto-positioned`);
    }

    // Check parameters
    if (!node.parameters || typeof node.parameters !== 'object') {
      warnings.push(`Node "${node.name}" missing parameters object`);
    }
  }

  // 4. Validate connections reference existing nodes
  for (const [sourceName, outputs] of Object.entries(workflow.connections)) {
    if (!nodeNames.has(sourceName)) {
      errors.push(`Connection references non-existent source node: "${sourceName}"`);
      continue;
    }

    for (const [_outputType, connections] of Object.entries(outputs)) {
      if (!Array.isArray(connections)) {
        errors.push(`Invalid connection structure for node "${sourceName}"`);
        continue;
      }

      for (const connectionGroup of connections) {
        if (!Array.isArray(connectionGroup)) {
          continue;
        }

        for (const connection of connectionGroup) {
          if (!connection.node || typeof connection.node !== 'string') {
            errors.push(`Invalid connection from "${sourceName}"`);
            continue;
          }

          if (!nodeNames.has(connection.node)) {
            errors.push(
              `Connection references non-existent target node: "${connection.node}" (from "${sourceName}")`
            );
          }
        }
      }
    }
  }

  // 5. Check for at least one trigger node
  const hasTrigger = workflow.nodes.some(
    (node) => isTriggerNode(node.type) || node.name.toLowerCase().includes('start')
  );

  if (!hasTrigger) {
    warnings.push('Workflow has no trigger node - it can only be executed manually');
  }

  // 6. Check for orphan nodes (nodes with no incoming connections, except triggers)
  const nodesWithIncoming = new Set<string>();
  for (const outputs of Object.values(workflow.connections)) {
    for (const connectionGroup of Object.values(outputs)) {
      for (const connections of connectionGroup) {
        for (const conn of connections) {
          nodesWithIncoming.add(conn.node);
        }
      }
    }
  }

  for (const node of workflow.nodes) {
    if (
      !isTriggerNode(node.type) &&
      !node.name.toLowerCase().includes('start') &&
      !nodesWithIncoming.has(node.name)
    ) {
      warnings.push(`Node "${node.name}" has no incoming connections - it will never execute`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  return {
    valid: true,
    errors: [],
    warnings,
  };
}

export function validateNodeParameters(workflow: WorkflowDefinition): string[] {
  const warnings: string[] = [];

  for (const node of workflow.nodes) {
    const nodeDef = getNodeDefinition(node.type);
    if (!nodeDef) {
      continue;
    } // Unknown node type — skip

    const effectiveParams = buildEffectiveParams(nodeDef, node);
    for (const prop of nodeDef.properties) {
      if (!prop.required) {
        continue;
      }
      if (!isPropertyVisible(prop, effectiveParams)) {
        continue;
      }

      const value = node.parameters?.[prop.name];
      if (value === undefined || value === null || value === '') {
        const label = prop.displayName || prop.name;
        warnings.push(`Node "${node.name}": missing required parameter "${label}"`);
      }
    }
  }

  return warnings;
}

/**
 * Build effective parameters for visibility checks by applying property defaults in two passes.
 *
 * Pass 1: always-visible props (no displayOptions) — e.g. `resource` default "message".
 * Pass 2: props whose displayOptions are satisfied by pass-1 defaults — e.g. `operation`
 *   default "send" becomes visible once `resource` is known.
 *
 * Two passes resolve the depth-2 chains present in workflows node definitions
 * (root prop → one level of conditional). The `@version` key is injected as the
 * node's typeVersion so displayOptions conditions that reference it work correctly.
 */
function buildEffectiveParams(
  nodeDef: NodeDefinition,
  node: { typeVersion: number; parameters: Record<string, unknown> }
): Record<string, unknown> {
  const effective: Record<string, unknown> = { '@version': node.typeVersion };

  // Pass 1: always-visible properties (no displayOptions)
  for (const prop of nodeDef.properties) {
    if (!prop.displayOptions && !(prop.name in node.parameters) && prop.default !== undefined) {
      effective[prop.name] = prop.default;
    }
  }

  // Merge actual params so pass 2 sees LLM-provided values (e.g. resource set
  // explicitly while operation is omitted — operation's displayOptions depends on resource).
  Object.assign(effective, node.parameters);

  // Pass 2: properties with displayOptions that are now satisfied by pass-1 defaults + actual params
  for (const prop of nodeDef.properties) {
    if (
      prop.displayOptions &&
      !(prop.name in effective) &&
      prop.default !== undefined &&
      isPropertyVisible(prop, effective)
    ) {
      effective[prop.name] = prop.default;
    }
  }

  return effective;
}

/**
 * workflows displayOptions logic:
 * - `show`: ALL conditions must match for visible
 * - `hide`: ANY match hides the property
 */
function isPropertyVisible(prop: NodeProperty, parameters: Record<string, unknown>): boolean {
  if (!prop.displayOptions) {
    return true;
  }

  const show = prop.displayOptions as {
    show?: Record<string, unknown[]>;
    hide?: Record<string, unknown[]>;
  };

  // If "show" is defined, ALL conditions must match
  if (show.show) {
    for (const [key, allowedValues] of Object.entries(show.show)) {
      if (!Array.isArray(allowedValues)) {
        continue;
      }
      const paramValue = parameters?.[key];
      if (!allowedValues.includes(paramValue)) {
        return false;
      }
    }
  }

  // If "hide" is defined, ANY match hides the property
  if (show.hide) {
    for (const [key, hiddenValues] of Object.entries(show.hide)) {
      if (!Array.isArray(hiddenValues)) {
        continue;
      }
      const paramValue = parameters?.[key];
      if (hiddenValues.includes(paramValue)) {
        return false;
      }
    }
  }

  return true;
}

export function validateNodeInputs(workflow: WorkflowDefinition): string[] {
  const warnings: string[] = [];

  // Count incoming connections per node
  const incomingCount = new Map<string, number>();
  for (const node of workflow.nodes) {
    incomingCount.set(node.name, 0);
  }
  for (const outputs of Object.values(workflow.connections)) {
    for (const connectionGroups of Object.values(outputs)) {
      for (const connections of connectionGroups) {
        for (const conn of connections) {
          incomingCount.set(conn.node, (incomingCount.get(conn.node) || 0) + 1);
        }
      }
    }
  }

  for (const node of workflow.nodes) {
    const nodeDef = getNodeDefinition(node.type);
    if (!nodeDef) {
      continue;
    }

    if (isTriggerNode(node.type) || nodeDef.group.includes('trigger')) {
      continue;
    }

    // Dynamic inputs (workflows expression string) can't be validated statically
    if (!Array.isArray(nodeDef.inputs)) {
      continue;
    }

    const expectedInputs = nodeDef.inputs.filter((i) => i === 'main').length;
    const actualInputs = incomingCount.get(node.name) || 0;

    if (expectedInputs > 0 && actualInputs < expectedInputs) {
      warnings.push(
        `Node "${node.name}" expects ${expectedInputs} input(s) but has ${actualInputs}`
      );
    }
  }

  return warnings;
}

export function positionNodes(workflow: WorkflowDefinition): WorkflowDefinition {
  // Clone workflow
  const positioned = { ...workflow };
  positioned.nodes = [...workflow.nodes];

  // Check if all nodes already have valid positions
  const allHavePositions = positioned.nodes.every(
    (node) =>
      node.position &&
      Array.isArray(node.position) &&
      node.position.length === 2 &&
      typeof node.position[0] === 'number' &&
      typeof node.position[1] === 'number'
  );

  if (allHavePositions) {
    return positioned; // No changes needed
  }

  // Build node graph to understand flow structure
  const nodeGraph = buildNodeGraph(positioned);

  // Position nodes level by level (breadth-first from triggers)
  const positionedNodes = positionByLevels(positioned.nodes, nodeGraph);

  positioned.nodes = positionedNodes;
  return positioned;
}

/** Ensure trigger nodes use simplified output when available. */
export function normalizeTriggerSimpleParam(workflow: WorkflowDefinition): void {
  for (const node of workflow.nodes) {
    if (!isTriggerNode(node.type)) {
      continue;
    }

    const def = getNodeDefinition(node.type);
    const hasSimple = def?.properties?.some((p: { name: string }) => p.name === 'simple');
    if (hasSimple) {
      node.parameters = { ...node.parameters, simple: true };
    }
  }
}

/**
 * Validates that $json expressions reference fields that exist in upstream node output schemas.
 * Returns a list of invalid references that need correction.
 */
export function validateOutputReferences(workflow: WorkflowDefinition): OutputRefValidation[] {
  const invalidRefs: OutputRefValidation[] = [];
  const upstreamMap = buildUpstreamMap(workflow);
  const nodeMap = new Map(workflow.nodes.map((n) => [n.name, n]));

  const schemaCache = new Map<
    string,
    {
      schema: SchemaContent;
      fields: string[];
      node: WorkflowDefinition['nodes'][0];
    } | null
  >();

  function getSourceSchema(sourceName: string) {
    if (schemaCache.has(sourceName)) {
      return schemaCache.get(sourceName)!;
    }
    const sourceNode = nodeMap.get(sourceName);
    if (!sourceNode) {
      schemaCache.set(sourceName, null);
      return null;
    }
    const resource = (sourceNode.parameters?.resource as string) || '';
    const operation = (sourceNode.parameters?.operation as string) || '';
    const schemaResult = isTriggerNode(sourceNode.type)
      ? loadTriggerOutputSchema(sourceNode.type, sourceNode.parameters as Record<string, unknown>)
      : loadOutputSchema(sourceNode.type, resource, operation);
    if (!schemaResult) {
      schemaCache.set(sourceName, null);
      return null;
    }
    const entry = {
      schema: schemaResult.schema,
      fields: schemaResult.fields,
      node: sourceNode,
    };
    schemaCache.set(sourceName, entry);
    return entry;
  }

  for (const node of workflow.nodes) {
    if (!node.parameters) {
      continue;
    }

    const expressions = parseExpressions(node.parameters);
    if (expressions.length === 0) {
      continue;
    }

    const upstreamNames = upstreamMap.get(node.name) || [];
    if (upstreamNames.length === 0) {
      continue;
    }

    const defaultSourceName = upstreamNames[0];

    for (const expr of expressions) {
      const sourceName = expr.sourceNodeName || defaultSourceName;
      const cached = getSourceSchema(sourceName);
      if (!cached) {
        continue;
      }

      const exists = fieldExistsInSchema(expr.path, cached.schema);
      if (!exists) {
        const resource = (cached.node.parameters?.resource as string) || '';
        const operation = (cached.node.parameters?.operation as string) || '';
        invalidRefs.push({
          nodeName: node.name,
          expression: expr.fullExpression,
          field: expr.field,
          sourceNodeName: sourceName,
          sourceNodeType: cached.node.type,
          resource,
          operation,
          availableFields: getAllFieldPathsTyped(cached.schema).map((f) => `${f.path} (${f.type})`),
        });
      }
    }
  }

  return invalidRefs;
}

/**
 * Correct invalid option parameter values and typeVersion against catalog definitions.
 * Top-level options (resource) are fixed first so displayOptions cascading works for dependent ones (operation).
 */
export function correctOptionParameters(workflow: WorkflowDefinition): number {
  let corrections = 0;

  for (const node of workflow.nodes) {
    const nodeDef = getNodeDefinition(node.type);
    if (!nodeDef) {
      continue;
    }

    if (node.type !== nodeDef.name) {
      logger.warn(
        { src: 'plugin:workflow:correctOptions' },
        `Node "${node.name}": type "${node.type}" → "${nodeDef.name}"`
      );
      node.type = nodeDef.name;
      corrections++;
    }

    const validVersions = Array.isArray(nodeDef.version) ? nodeDef.version : [nodeDef.version];
    if (node.typeVersion && !validVersions.includes(node.typeVersion)) {
      const maxVersion = Math.max(...validVersions);
      logger.warn(
        { src: 'plugin:workflow:correctOptions' },
        `Node "${node.name}": typeVersion ${node.typeVersion} → ${maxVersion}`
      );
      node.typeVersion = maxVersion;
      corrections++;
    }

    const topLevel: NodeProperty[] = [];
    const dependent: NodeProperty[] = [];
    for (const prop of nodeDef.properties) {
      if (prop.type !== 'options' || !prop.options?.length) {
        continue;
      }
      if (prop.displayOptions) {
        dependent.push(prop);
      } else {
        topLevel.push(prop);
      }
    }

    for (const prop of topLevel) {
      corrections += fixOptionValue(node, prop);
    }

    const effectiveParamsForDeps = buildEffectiveParams(nodeDef, node);
    for (const prop of dependent) {
      if (!isPropertyVisible(prop, effectiveParamsForDeps)) {
        continue;
      }
      corrections += fixOptionValue(node, prop);
    }
  }

  return corrections;
}

function fixOptionValue(node: WorkflowDefinition['nodes'][0], prop: NodeProperty): number {
  const currentValue = node.parameters[prop.name];
  if (currentValue === undefined) {
    return 0;
  }

  const allowedValues = prop.options?.map((o) => o.value) ?? [];
  if (allowedValues.includes(currentValue as string | number | boolean)) {
    return 0;
  }

  const corrected =
    prop.default !== undefined && allowedValues.includes(prop.default as string | number | boolean)
      ? prop.default
      : allowedValues[0];

  logger.warn(
    { src: 'plugin:workflow:correctOptions' },
    `Node "${node.name}": ${prop.name} "${currentValue}" → "${corrected}"`
  );
  node.parameters[prop.name] = corrected;
  return 1;
}

function buildUpstreamMap(workflow: WorkflowDefinition): Map<string, string[]> {
  const upstream = new Map<string, string[]>();

  for (const node of workflow.nodes) {
    upstream.set(node.name, []);
  }

  for (const [sourceName, outputs] of Object.entries(workflow.connections)) {
    for (const connectionGroups of Object.values(outputs)) {
      for (const connections of connectionGroups) {
        for (const conn of connections) {
          const existing = upstream.get(conn.node) || [];
          if (!existing.includes(sourceName)) {
            existing.push(sourceName);
            upstream.set(conn.node, existing);
          }
        }
      }
    }
  }

  return upstream;
}

function buildNodeGraph(workflow: WorkflowDefinition): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  // Initialize all nodes
  for (const node of workflow.nodes) {
    graph.set(node.name, []);
  }

  // Build edges from connections
  for (const [sourceName, outputs] of Object.entries(workflow.connections)) {
    const targets: string[] = [];

    for (const connectionGroups of Object.values(outputs)) {
      for (const connections of connectionGroups) {
        for (const conn of connections) {
          if (conn.node) {
            targets.push(conn.node);
          }
        }
      }
    }

    graph.set(sourceName, targets);
  }

  return graph;
}

function positionByLevels(
  nodes: WorkflowDefinition['nodes'],
  graph: Map<string, string[]>
): WorkflowDefinition['nodes'] {
  // Find trigger/start nodes (nodes with no incoming connections)
  const incomingCount = new Map<string, number>();
  for (const node of nodes) {
    incomingCount.set(node.name, 0);
  }

  for (const targets of graph.values()) {
    for (const target of targets) {
      incomingCount.set(target, (incomingCount.get(target) || 0) + 1);
    }
  }

  const triggerNodes = nodes.filter((node) => incomingCount.get(node.name) === 0);

  // Organize into levels
  const levels: string[][] = [];
  const visited = new Set<string>();
  const queue: Array<{ name: string; level: number }> = [];

  // Start with triggers at level 0
  for (const trigger of triggerNodes) {
    queue.push({ name: trigger.name, level: 0 });
  }

  while (queue.length > 0) {
    const { name, level } = queue.shift()!;

    if (visited.has(name)) {
      continue;
    }
    visited.add(name);

    // Add to level
    if (!levels[level]) {
      levels[level] = [];
    }
    levels[level].push(name);

    // Add children to next level
    const children = graph.get(name) || [];
    for (const child of children) {
      if (!visited.has(child)) {
        queue.push({ name: child, level: level + 1 });
      }
    }
  }

  // Position nodes based on levels
  const positioned = [...nodes];
  const nodeMap = new Map(nodes.map((node) => [node.name, node]));

  const startX = 250;
  const startY = 300;
  const xSpacing = 250;
  const ySpacing = 100;

  for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
    const levelNodes = levels[levelIndex];
    const x = startX + levelIndex * xSpacing;

    // Center nodes vertically if multiple in same level
    const totalHeight = levelNodes.length * ySpacing;
    const startYForLevel = startY - totalHeight / 2;

    for (let i = 0; i < levelNodes.length; i++) {
      const nodeName = levelNodes[i];
      const node = nodeMap.get(nodeName);

      if (node) {
        const y = startYForLevel + i * ySpacing;
        const nodeIndex = positioned.findIndex((n) => n.name === nodeName);
        if (nodeIndex !== -1) {
          positioned[nodeIndex] = {
            ...positioned[nodeIndex],
            position: [x, y],
          };
        }
      }
    }
  }

  return positioned;
}

/**
 * Detect parameters not matching any VISIBLE catalog property.
 * e.g. `model` is only valid for `resource: "image"`, not `resource: "text"` (where `modelId` is correct).
 * Runs AFTER correctOptionParameters so resource/operation are already valid.
 */
export interface UnknownParamDetection {
  nodeName: string;
  nodeType: string;
  currentParams: Record<string, unknown>;
  unknownKeys: string[];
  /** Simplified property definitions for this node (used by the LLM to fix params). */
  propertyDefs: NodeProperty[];
}

export function detectUnknownParameters(workflow: WorkflowDefinition): UnknownParamDetection[] {
  const detections: UnknownParamDetection[] = [];

  for (const node of workflow.nodes) {
    const nodeDef = getNodeDefinition(node.type);
    if (!nodeDef || !node.parameters) {
      continue;
    }

    // Compute visible property names using effective parameters (actual + defaults).
    // Defaults are applied for always-visible props first, then for newly-visible props,
    // so that chained displayOptions (resource → operation → field) resolve correctly.
    const effectiveParams = buildEffectiveParams(nodeDef, node);
    const visibleNames = new Set<string>();
    for (const prop of nodeDef.properties) {
      if (isPropertyVisible(prop, effectiveParams)) {
        visibleNames.add(prop.name);
      }
    }

    const unknownKeys: string[] = [];
    for (const key of Object.keys(node.parameters)) {
      if (!visibleNames.has(key)) {
        unknownKeys.push(key);
      }
    }

    if (unknownKeys.length === 0) {
      continue;
    }

    // Provide simplified visible properties for the LLM correction prompt
    const simplified = simplifyNodeForLLM(nodeDef);
    const visibleSimplified = simplified.properties.filter((p) => visibleNames.has(p.name));

    detections.push({
      nodeName: node.name,
      nodeType: node.type,
      currentParams: node.parameters,
      unknownKeys,
      propertyDefs: visibleSimplified,
    });
  }

  return detections;
}

/**
 * Prefix all string parameter values containing {{ }} with = so workflows evaluates them as expressions.
 * Without =, workflows treats {{ }} as literal text.
 * Returns the number of values prefixed.
 */
/**
 * Deterministically attach a `credentials` block to every node that requires
 * one. Runs after LLM generation as a safety net: even with a hardened
 * `MANDATORY INVARIANT` rule in the system prompt, the LLM occasionally omits
 * the block — and resolveCredentials only fires when a block is present, so
 * an omission means the credential never gets minted server-side and the user
 * has to wire it in workflows's UI.
 *
 * Selection rule:
 *  1. Skip nodes that already have at least one credentials entry.
 *  2. Look up the node's catalog definition. If `def.credentials` is empty,
 *     the node doesn't need credentials — skip.
 *  3. Pick the first credential type from `def.credentials` that:
 *     - is listed in `runtimeContext.supportedCredentials.nodeTypes` for
 *       this node's type, AND
 *     - matches the node's `parameters.authentication` (when the credential's
 *       displayOptions.show.authentication is set; otherwise unconditional).
 *  4. Inject `node.credentials = { [credType]: { id: "{{CREDENTIAL_ID}}", name } }`.
 *     The plugin's `resolveCredentials` later replaces `{{CREDENTIAL_ID}}` with
 *     the real workflows credential id.
 *
 * Returns the number of nodes that received an injected block (for logging).
 */
export function injectMissingCredentialBlocks(
  workflow: WorkflowDefinition,
  relevantNodes: NodeDefinition[],
  runtimeContext: RuntimeContext | undefined
): number {
  if (!runtimeContext?.supportedCredentials?.length) {
    return 0;
  }
  // Build supportedCredType-by-nodeType lookup. Each supportedCredential entry
  // applies to one or more node types; flip that map so we can ask
  // "for this node type, which cred types does the host support?".
  const supportedByNodeType = new Map<string, Map<string, string>>();
  for (const sc of runtimeContext.supportedCredentials) {
    for (const nodeType of sc.nodeTypes) {
      if (!supportedByNodeType.has(nodeType)) {
        supportedByNodeType.set(nodeType, new Map());
      }
      supportedByNodeType.get(nodeType)?.set(sc.credType, sc.friendlyName);
    }
  }
  if (supportedByNodeType.size === 0) {
    return 0;
  }
  const defByType = new Map(relevantNodes.map((n) => [n.name, n]));
  let injected = 0;
  for (const node of workflow.nodes) {
    if (node.credentials && Object.keys(node.credentials).length > 0) {
      continue;
    }
    const def = defByType.get(node.type);
    if (!def?.credentials?.length) {
      continue;
    }
    const supportedForType = supportedByNodeType.get(node.type);
    if (!supportedForType?.size) {
      continue;
    }
    // Resolve which credential type matches this node's authentication choice.
    // workflows nodes typically gate credentials by `displayOptions.show.authentication`
    // (e.g. discord's discordBotApi shows when authentication=botToken).
    const auth =
      typeof node.parameters?.authentication === 'string'
        ? (node.parameters.authentication as string)
        : null;
    const candidate = def.credentials.find((c) => {
      if (!supportedForType.has(c.name)) {
        return false;
      }
      const showOpts = (c.displayOptions as { show?: { authentication?: string[] } } | undefined)
        ?.show;
      if (showOpts?.authentication && showOpts.authentication.length > 0) {
        return auth ? showOpts.authentication.includes(auth) : false;
      }
      // Unconditional credential or no show-rule: take it.
      return true;
    });
    if (!candidate) {
      continue;
    }
    const friendlyName = supportedForType.get(candidate.name) ?? candidate.name;
    node.credentials = {
      [candidate.name]: {
        id: '{{CREDENTIAL_ID}}',
        name: friendlyName,
      },
    };
    logger.debug(
      {
        src: 'plugin:workflow:utils:workflow',
        node: node.name,
        nodeType: node.type,
        credType: candidate.name,
      },
      'Injected missing credentials block on node (LLM omitted it)'
    );
    injected++;
  }
  return injected;
}

export function ensureExpressionPrefix(workflow: WorkflowDefinition): number {
  let count = 0;
  for (const node of workflow.nodes) {
    if (!node.parameters) {
      continue;
    }
    count += prefixExpressions(node.parameters);
  }
  return count;
}

function prefixExpressions(obj: Record<string, unknown>): number {
  let count = 0;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'string' && value.includes('{{') && !value.startsWith('=')) {
      obj[key] = `=${value}`;
      count++;
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'string' && value[i].includes('{{') && !value[i].startsWith('=')) {
          value[i] = `=${value[i]}`;
          count++;
        } else if (typeof value[i] === 'object' && value[i] !== null) {
          count += prefixExpressions(value[i] as Record<string, unknown>);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      count += prefixExpressions(value as Record<string, unknown>);
    }
  }
  return count;
}
