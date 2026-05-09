/**
 * n8n route plugin — registers `/api/n8n/*` route handlers with the
 * elizaOS runtime plugin route system.
 *
 * Migrated from packages/app-core/src/api/n8n-routes.ts. All routes use
 * `rawPath: true` to preserve the legacy `/api/n8n/*` paths without a
 * plugin-name prefix.
 *
 * The existing `n8n-workflow` plugin (`./plugin.ts`) ships actions,
 * services, providers, and schema. This file ships only the rawPath route
 * adapters used by the app-core HTTP server, so the two plugins stay
 * narrowly scoped: one for the runtime/agent surface, one for the
 * compatibility HTTP routes.
 */

import { loadElizaConfig } from '@elizaos/agent/config';
import { ensureRouteAuthorized } from '@elizaos/app-core';
import type { CompatRuntimeState } from '@elizaos/app-core';
import { sendJson } from '@elizaos/app-core';
import type { Plugin, Route } from '@elizaos/core';
import type http from 'node:http';
import { handleN8nRoutes, type N8nRouteContext } from './routes/n8n-routes';

type AnyRuntime = N8nRouteContext['runtime'];

interface N8nCompatState extends CompatRuntimeState {
  current: AnyRuntime;
}

function buildState(runtime: unknown): N8nCompatState {
  return { current: runtime as AnyRuntime } as N8nCompatState;
}

function makeN8nHandler() {
  return async (req: unknown, res: unknown, runtime: unknown): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const url = new URL(httpReq.url ?? '/', 'http://localhost');
    const method = (httpReq.method ?? 'GET').toUpperCase();
    const state = buildState(runtime);

    if (!(await ensureRouteAuthorized(httpReq, httpRes, state))) {
      return;
    }

    await handleN8nRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      config: loadElizaConfig(),
      runtime: state.current,
      json: (_res, body, status = 200) => {
        sendJson(httpRes, status, body);
      },
    });
  };
}

const n8nHandler = makeN8nHandler();

const n8nRouteList: Route[] = [
  // Status surface
  {
    type: 'GET',
    path: '/api/n8n/status',
    rawPath: true,
    handler: n8nHandler,
  },
  // Sidecar lifecycle
  {
    type: 'POST',
    path: '/api/n8n/sidecar/start',
    rawPath: true,
    handler: n8nHandler,
  },
  // Workflow CRUD
  {
    type: 'GET',
    path: '/api/n8n/workflows',
    rawPath: true,
    handler: n8nHandler,
  },
  {
    type: 'POST',
    path: '/api/n8n/workflows',
    rawPath: true,
    handler: n8nHandler,
  },
  {
    type: 'POST',
    path: '/api/n8n/workflows/generate',
    rawPath: true,
    handler: n8nHandler,
  },
  {
    type: 'PUT',
    path: '/api/n8n/workflows/:id',
    rawPath: true,
    handler: n8nHandler,
  },
  {
    type: 'POST',
    path: '/api/n8n/workflows/:id/activate',
    rawPath: true,
    handler: n8nHandler,
  },
  {
    type: 'POST',
    path: '/api/n8n/workflows/:id/deactivate',
    rawPath: true,
    handler: n8nHandler,
  },
  {
    type: 'DELETE',
    path: '/api/n8n/workflows/:id',
    rawPath: true,
    handler: n8nHandler,
  },
];

export const n8nWorkflowRoutePlugin: Plugin = {
  name: '@elizaos/plugin-n8n-workflow:routes',
  description:
    'n8n workflow routes — status, sidecar lifecycle, and workflow CRUD proxy (extracted from app-core/server.ts)',
  routes: n8nRouteList,
};

export default n8nWorkflowRoutePlugin;
