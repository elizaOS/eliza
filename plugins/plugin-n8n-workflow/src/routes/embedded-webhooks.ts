import type { Route, RouteRequest, RouteResponse, IAgentRuntime } from '@elizaos/core';
import {
  EmbeddedN8nService,
  N8N_EMBEDDED_SERVICE_TYPE,
} from '../services/embedded-n8n-service';
import { N8nApiError } from '../types/index';

function getEmbeddedService(runtime: IAgentRuntime): EmbeddedN8nService {
  const service = runtime.getService(N8N_EMBEDDED_SERVICE_TYPE) as EmbeddedN8nService | null;
  if (!service) {
    throw new Error('EmbeddedN8nService not available in runtime');
  }
  return service;
}

function coerceBody(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : { body };
}

async function executeWebhook(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  try {
    const path = req.params?.path;
    if (!path) {
      res.status(400).json({ success: false, error: 'webhook_path_required' });
      return;
    }

    const service = getEmbeddedService(runtime);
    const method = (req.method ?? 'POST').toUpperCase();
    const execution = await service.executeWebhook(
      path,
      {
        body: req.body ?? {},
        query: req.query ?? {},
        params: req.params ?? {},
        ...coerceBody(req.body),
      },
      method
    );
    res.json({ success: true, data: execution });
  } catch (error) {
    res.status(error instanceof N8nApiError ? error.statusCode : 500).json({
      success: false,
      error: 'failed_to_execute_webhook',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export const embeddedWebhookRoutes: Route[] = [
  { type: 'GET', path: '/webhooks/:path', handler: executeWebhook },
  { type: 'POST', path: '/webhooks/:path', handler: executeWebhook },
  { type: 'PUT', path: '/webhooks/:path', handler: executeWebhook },
  { type: 'PATCH', path: '/webhooks/:path', handler: executeWebhook },
  { type: 'DELETE', path: '/webhooks/:path', handler: executeWebhook },
];
