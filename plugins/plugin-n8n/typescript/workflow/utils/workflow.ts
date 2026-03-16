import type { N8nWorkflow, NodeProperty, WorkflowValidationResult } from "../types/index";
import { getNodeDefinition } from "./catalog";

export function validateWorkflow(workflow: N8nWorkflow): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check nodes array exists and is non-empty
  if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
    errors.push("Missing or invalid nodes array");
    return { valid: false, errors, warnings };
  }

  if (workflow.nodes.length === 0) {
    errors.push("Workflow must have at least one node");
    return { valid: false, errors, warnings };
  }

  // 2. Check connections structure
  if (!workflow.connections || typeof workflow.connections !== "object") {
    errors.push("Missing or invalid connections object");
    return { valid: false, errors, warnings };
  }

  // 3. Validate each node
  const nodeNames = new Set<string>();
  const nodeMap = new Map<string, (typeof workflow.nodes)[0]>();

  for (const node of workflow.nodes) {
    // Check required fields
    if (!node.name || typeof node.name !== "string") {
      errors.push("Node missing name");
      continue;
    }

    if (!node.type || typeof node.type !== "string") {
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
    if (!node.parameters || typeof node.parameters !== "object") {
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
          if (!connection.node || typeof connection.node !== "string") {
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
    (node) =>
      node.type.toLowerCase().includes("trigger") ||
      node.type.toLowerCase().includes("webhook") ||
      node.name.toLowerCase().includes("start")
  );

  if (!hasTrigger) {
    warnings.push("Workflow has no trigger node - it can only be executed manually");
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
    const isTrigger =
      node.type.toLowerCase().includes("trigger") ||
      node.type.toLowerCase().includes("webhook") ||
      node.name.toLowerCase().includes("start");

    if (!isTrigger && !nodesWithIncoming.has(node.name)) {
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

export function validateNodeParameters(workflow: N8nWorkflow): string[] {
  const warnings: string[] = [];

  for (const node of workflow.nodes) {
    const nodeDef = getNodeDefinition(node.type);
    if (!nodeDef) {
      continue;
    } // Unknown node type — skip

    for (const prop of nodeDef.properties) {
      if (!prop.required) {
        continue;
      }
      if (!isPropertyVisible(prop, node.parameters)) {
        continue;
      }

      const value = node.parameters?.[prop.name];
      if (value === undefined || value === null || value === "") {
        const label = prop.displayName || prop.name;
        warnings.push(`Node "${node.name}": missing required parameter "${label}"`);
      }
    }
  }

  return warnings;
}

/**
 * n8n displayOptions logic:
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

export function validateNodeInputs(workflow: N8nWorkflow): string[] {
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

    const isTrigger =
      node.type.toLowerCase().includes("trigger") ||
      node.type.toLowerCase().includes("webhook") ||
      nodeDef.group.includes("trigger");

    if (isTrigger) {
      continue;
    } // Triggers don't need incoming connections

    const expectedInputs = nodeDef.inputs.filter((i) => i === "main").length;
    const actualInputs = incomingCount.get(node.name) || 0;

    if (expectedInputs > 0 && actualInputs < expectedInputs) {
      warnings.push(
        `Node "${node.name}" expects ${expectedInputs} input(s) but has ${actualInputs}`
      );
    }
  }

  return warnings;
}

export function positionNodes(workflow: N8nWorkflow): N8nWorkflow {
  // Clone workflow
  const positioned = { ...workflow };
  positioned.nodes = [...workflow.nodes];

  // Check if all nodes already have valid positions
  const allHavePositions = positioned.nodes.every(
    (node) =>
      node.position &&
      Array.isArray(node.position) &&
      node.position.length === 2 &&
      typeof node.position[0] === "number" &&
      typeof node.position[1] === "number"
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

function buildNodeGraph(workflow: N8nWorkflow): Map<string, string[]> {
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
  nodes: N8nWorkflow["nodes"],
  graph: Map<string, string[]>
): N8nWorkflow["nodes"] {
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
