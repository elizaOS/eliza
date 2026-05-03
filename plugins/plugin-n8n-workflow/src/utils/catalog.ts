import {
  NodeDefinition,
  NodeProperty,
  NodeSearchResult,
  IntegrationFilterResult,
} from '../types/index';
import defaultNodesData from '../data/defaultNodes.json' assert { type: 'json' };

/**
 * n8n node catalog with keyword-based search
 * @note Uses embedded catalog (457 nodes as of April 2025)
 * @todo Add dynamic refresh via GET /node-types in v2
 */

const NODE_CATALOG = defaultNodesData as NodeDefinition[];

/** Get all nodes in the catalog. Used by route handlers for unfiltered listing. */
export function getAllNodes(): NodeDefinition[] {
  return NODE_CATALOG;
}

/**
 * Look up a node definition by its type name.
 *
 * Handles full names ("n8n-nodes-base.gmail", "@n8n/n8n-nodes-langchain.openAi")
 * and bare names ("gmail", "openAi").
 */
export function getNodeDefinition(typeName: string): NodeDefinition | undefined {
  const exact = NODE_CATALOG.find((n) => n.name === typeName);
  if (exact) {
    return exact;
  }

  const bare = typeName.replace(/^(?:n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./, '');
  return NODE_CATALOG.find((n) => {
    const catalogBare = n.name.replace(/^(?:n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./, '');
    return catalogBare === bare || n.name === bare;
  });
}

/** Split a name into lowercase tokens on camelCase / dot / hyphen / underscore / @ / slash boundaries */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → words
    .split(/[\s.\-_@/]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/**
 * Scoring: exact name 10, word-boundary 7, substring 3, category 3, description 2, word 1
 */
export function searchNodes(keywords: string[], limit = 15): NodeSearchResult[] {
  if (keywords.length === 0) {
    return [];
  }

  const normalizedKeywords = keywords.map((kw) => kw.toLowerCase().trim());

  const scoredNodes: NodeSearchResult[] = NODE_CATALOG.filter(
    (node) => node.name && node.displayName
  ).map((node) => {
    let score = 0;
    const matchReasons: string[] = [];

    const nodeName = node.name.toLowerCase();
    const nodeDisplayName = node.displayName.toLowerCase();
    const nodeDescription = node.description?.toLowerCase() || '';
    const nameTokens = tokenize(node.name);
    const displayTokens = tokenize(node.displayName);

    for (const keyword of normalizedKeywords) {
      if (nodeName === keyword || nodeDisplayName === keyword) {
        score += 10;
        matchReasons.push(`exact match: "${keyword}"`);
        continue;
      }

      // Word-boundary match: keyword equals a token in the name
      const isWordMatch =
        nameTokens.some((t) => t === keyword) || displayTokens.some((t) => t === keyword);

      if (isWordMatch) {
        score += 7;
        matchReasons.push(`word match: "${keyword}"`);
      } else if (nodeName.includes(keyword) || nodeDisplayName.includes(keyword)) {
        score += 3;
        matchReasons.push(`name contains: "${keyword}"`);
      }

      if (nodeDescription.includes(keyword)) {
        score += 2;
        matchReasons.push(`description contains: "${keyword}"`);
      }

      const descriptionWords = nodeDescription.split(/\s+/);
      if (descriptionWords.some((word) => word.includes(keyword))) {
        score += 1;
      }

      if (node.group.some((group) => group.toLowerCase().includes(keyword))) {
        score += 3;
        matchReasons.push(`category: "${keyword}"`);
      }
    }

    return {
      node,
      score,
      matchReason: matchReasons.join(', ') || 'no strong match',
    };
  });

  return scoredNodes
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function filterNodesByIntegrationSupport(
  nodes: NodeSearchResult[],
  supportedCredTypes: Set<string>
): IntegrationFilterResult {
  const remaining: NodeSearchResult[] = [];
  const removed: NodeSearchResult[] = [];

  for (const result of nodes) {
    const creds = result.node.credentials;

    // No credentials → utility node → always keep
    if (!creds || creds.length === 0) {
      remaining.push(result);
      continue;
    }

    // Service node: keep if ANY credential type is supported
    const hasSupported = creds.some((c) => supportedCredTypes.has(c.name));
    if (hasSupported) {
      remaining.push(result);
    } else {
      removed.push(result);
    }
  }

  return { remaining, removed };
}

const NOISE_TYPES = new Set(['notice', 'hidden']);
const STRIP_KEYS = new Set([
  'routing',
  'displayOptions',
  'typeOptions',
  'hint',
  'isNodeSetting',
  'noDataExpression',
  'validateType',
  'ignoreValidationDuringExecution',
  'requiresDataPath',
  'disabledOptions',
  'credentialTypes',
  'modes',
]);

function simplifyProperty(prop: NodeProperty): NodeProperty | null {
  if (NOISE_TYPES.has(prop.type)) {
    return null;
  }

  const slim: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(prop)) {
    if (STRIP_KEYS.has(key)) {
      continue;
    }
    slim[key] = value;
  }

  if (prop.type === 'resourceLocator') {
    slim.type = 'string';
    slim.default = '';
    slim.description = slim.description || `${prop.displayName} ID`;
  }

  if (prop.options && Array.isArray(prop.options)) {
    slim.options = prop.options.map((opt: Record<string, unknown>) => {
      if (opt.values && Array.isArray(opt.values)) {
        return {
          name: opt.name,
          displayName: opt.displayName,
          values: (opt.values as NodeProperty[])
            .map(simplifyProperty)
            .filter((v): v is NodeProperty => v !== null),
        };
      }
      const { description: _d, ...rest } = opt;
      return rest;
    });
  }

  return slim as unknown as NodeProperty;
}

export function simplifyNodeForLLM(node: NodeDefinition): NodeDefinition {
  const cleaned = node.properties
    .map(simplifyProperty)
    .filter((p): p is NodeProperty => p !== null);

  const seen = new Set<string>();
  const deduped: NodeProperty[] = [];
  for (const prop of cleaned) {
    if (seen.has(prop.name)) {
      continue;
    }
    seen.add(prop.name);
    deduped.push(prop);
  }

  return { ...node, properties: deduped };
}
