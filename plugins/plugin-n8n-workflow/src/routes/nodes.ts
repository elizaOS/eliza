import type { Route, RouteRequest, RouteResponse, IAgentRuntime } from '@elizaos/core';
import {
  searchNodes,
  getNodeDefinition,
  getAllNodes,
  filterNodesByIntegrationSupport,
} from '../utils/catalog';
import type { NodeSearchResult } from '../types/index';
import { N8N_CREDENTIAL_PROVIDER_TYPE, isCredentialProvider } from '../types/index';
import { validateLimit } from './_helpers';
import { N8N_EMBEDDED_SERVICE_TYPE, type EmbeddedN8nService } from '../services/embedded-n8n-service';

function getRegisteredEmbeddedNodes(runtime: IAgentRuntime): Set<string> | null {
  const service = runtime.getService(N8N_EMBEDDED_SERVICE_TYPE) as EmbeddedN8nService | null;
  const names = service?.getRegisteredNodeTypes?.();
  return names?.length ? new Set(names) : null;
}

function filterEmbeddedResults(
  results: NodeSearchResult[],
  runtime: IAgentRuntime
): NodeSearchResult[] {
  const registered = getRegisteredEmbeddedNodes(runtime);
  return registered ? results.filter((result) => registered.has(result.node.name)) : results;
}

/**
 * GET /nodes?q=gmail,email&limit=20
 */
async function listNodes(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const q = req.query?.q as string | undefined;
    const limit = validateLimit(req.query?.limit, 20, 100);

    if (!q) {
      res.status(400).json({
        success: false,
        error: 'q parameter is required (comma-separated keywords)',
      });
      return;
    }

    const keywords = q
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const results = filterEmbeddedResults(searchNodes(keywords, limit), runtime);

    res.json({
      success: true,
      data: results.map(formatSearchResult),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_search_nodes',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /nodes/available
 * Full catalog split by cloud integration support.
 * Returns { supported, unsupported, utility }.
 */
async function listAvailableNodes(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const registered = getRegisteredEmbeddedNodes(runtime);
    const catalog = registered
      ? getAllNodes().filter((node) => registered.has(node.name))
      : getAllNodes();
    const allResults: NodeSearchResult[] = catalog
      .filter((n) => n.name && n.displayName)
      .map((node) => ({ node, score: 0, matchReason: 'catalog' }));

    const rawProvider = runtime.getService(N8N_CREDENTIAL_PROVIDER_TYPE);
    const credProvider = isCredentialProvider(rawProvider) ? rawProvider : null;

    if (!credProvider?.checkCredentialTypes) {
      const utility = allResults.filter((r) => !r.node.credentials?.length);
      const services = allResults.filter((r) => (r.node.credentials?.length ?? 0) > 0);
      res.json({
        success: true,
        data: {
          supported: services.map(formatCatalogNode),
          unsupported: [],
          utility: utility.map(formatCatalogNode),
        },
      });
      return;
    }

    const credTypes = new Set<string>();
    for (const { node } of allResults) {
      for (const cred of node.credentials ?? []) {
        credTypes.add(cred.name);
      }
    }

    const checkResult = credProvider.checkCredentialTypes([...credTypes]);
    const supportedSet = new Set(checkResult.supported);
    const { remaining, removed } = filterNodesByIntegrationSupport(allResults, supportedSet);

    const utility = remaining.filter((r) => !r.node.credentials?.length);
    const supported = remaining.filter((r) => (r.node.credentials?.length ?? 0) > 0);

    res.json({
      success: true,
      data: {
        supported: supported.map(formatCatalogNode),
        unsupported: removed.map((r) => ({
          ...formatCatalogNode(r),
          missingCredentials: r.node.credentials?.map((c) => c.name) ?? [],
        })),
        utility: utility.map(formatCatalogNode),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_list_nodes',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /nodes/:type
 * Full node definition (properties/schema) for the visual editor.
 */
async function getNode(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const type = req.params?.type;
    if (!type) {
      res.status(400).json({ success: false, error: 'node_type_required' });
      return;
    }

    const registered = getRegisteredEmbeddedNodes(runtime);
    if (registered && !registered.has(type)) {
      res.status(404).json({ success: false, error: `node_type_not_available: ${type}` });
      return;
    }

    const definition = getNodeDefinition(type);
    if (!definition) {
      res.status(404).json({ success: false, error: `node_type_not_found: ${type}` });
      return;
    }

    res.json({ success: true, data: definition });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'failed_to_get_node',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/** For search results — includes score and matchReason. */
function formatSearchResult(r: NodeSearchResult) {
  return {
    name: r.node.name,
    displayName: r.node.displayName,
    description: r.node.description,
    icon: r.node.icon,
    iconUrl: r.node.iconUrl,
    group: r.node.group,
    credentials: r.node.credentials,
    score: r.score,
    matchReason: r.matchReason,
  };
}

/** For catalog listings — no search metadata. */
function formatCatalogNode(r: NodeSearchResult) {
  return {
    name: r.node.name,
    displayName: r.node.displayName,
    description: r.node.description,
    icon: r.node.icon,
    iconUrl: r.node.iconUrl,
    group: r.node.group,
    credentials: r.node.credentials,
  };
}

export const nodeRoutes: Route[] = [
  { type: 'GET', path: '/nodes/available', handler: listAvailableNodes },
  { type: 'GET', path: '/nodes/:type', handler: getNode },
  { type: 'GET', path: '/nodes', handler: listNodes },
];
