import defaultNodesData from "../data/defaultNodes.json" with { type: "json" };
import type { IntegrationFilterResult, NodeDefinition, NodeSearchResult } from "../types/index";

/**
 * n8n node catalog with keyword-based search
 * @note Uses embedded catalog (457 nodes as of April 2025)
 * @todo Add dynamic refresh via GET /node-types in v2
 */

const NODE_CATALOG = defaultNodesData as NodeDefinition[];

/**
 * Look up a node definition by its type name
 *
 * Handles both full names ("n8n-nodes-base.gmail") and bare names ("gmail").
 */
export function getNodeDefinition(typeName: string): NodeDefinition | undefined {
  // Try exact match first
  const exact = NODE_CATALOG.find((n) => n.name === typeName);
  if (exact) {
    return exact;
  }

  // Try without prefix (e.g., "gmail" matches "n8n-nodes-base.gmail")
  const bare = typeName.replace(/^n8n-nodes-base\./, "");
  return NODE_CATALOG.find((n) => {
    const catalogBare = n.name.replace(/^n8n-nodes-base\./, "");
    return catalogBare === bare || n.name === bare;
  });
}

/**
 * Scoring: exact name 10, partial name 5, category 3, description 2, word 1
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
    const nodeDescription = node.description?.toLowerCase() || "";

    for (const keyword of normalizedKeywords) {
      if (nodeName === keyword || nodeDisplayName === keyword) {
        score += 10;
        matchReasons.push(`exact match: "${keyword}"`);
        continue;
      }

      if (nodeName.includes(keyword) || nodeDisplayName.includes(keyword)) {
        score += 5;
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
      matchReason: matchReasons.join(", ") || "no strong match",
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
