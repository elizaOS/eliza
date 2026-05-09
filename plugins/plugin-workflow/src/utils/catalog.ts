import defaultNodesData from '../data/defaultNodes.json' with { type: 'json' };
import type {
  IntegrationFilterResult,
  NodeDefinition,
  NodeProperty,
  NodeSearchResult,
} from '../types/index';

/**
 * workflows node catalog with keyword-based search
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
 * Handles full names ("workflows-nodes-base.httpRequest") and bare names ("httpRequest").
 */
export function getNodeDefinition(typeName: string): NodeDefinition | undefined {
  const exact = NODE_CATALOG.find((n) => n.name === typeName);
  if (exact) {
    return exact;
  }

  const bare = typeName.replace(/^workflows-nodes-base\./, '');
  return NODE_CATALOG.find((n) => {
    const catalogBare = n.name.replace(/^workflows-nodes-base\./, '');
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

  return slim as NodeProperty;
}

/**
 * Derive a `{ credType: requiredAuthValue }` map from a node's catalog
 * credential entries. So Gmail's catalog produces
 * `{ gmailOAuth2: "oAuth2", googleApi: "serviceAccount" }`. The LLM uses
 * this to set `parameters.authentication` correctly when attaching a
 * credentials block (Session 21 anti-hallucination Layer 2).
 *
 * Returns undefined when no credential entries gate on `authentication`.
 */
function buildCredentialAuthMatrix(node: NodeDefinition): Record<string, string> | undefined {
  if (!node.credentials?.length) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const cred of node.credentials) {
    const authValues = (cred.displayOptions as { show?: { authentication?: string[] } } | undefined)
      ?.show?.authentication;
    if (Array.isArray(authValues) && authValues.length === 1) {
      out[cred.name] = authValues[0];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

  // Layer 2 (Session 21): always emit `version` as an array so the LLM
  // sees the EXACT set of valid values (catches typeVersion hallucinations
  // like 2.2 when only [1, 2, 2.1] exist). Pair with the prompt rule
  // "pick the highest from version[]; never invent versions".
  const versions: number[] = Array.isArray(node.version) ? [...node.version] : [node.version];

  // Layer 2 (Session 21): expose the credential→authentication mapping
  // so the LLM sets `parameters.authentication` correctly when it
  // attaches a credentials block.
  const credentialAuthMatrix = buildCredentialAuthMatrix(node);

  return {
    ...node,
    version: versions,
    properties: deduped,
    ...(credentialAuthMatrix ? { credentialAuthMatrix } : {}),
  } as NodeDefinition & { credentialAuthMatrix?: Record<string, string> };
}
