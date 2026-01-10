/**
 * Browser Automation Plugin for elizaOS
 * Provides browser automation capabilities using Stagehand
 */

import type { Plugin, IAgentRuntime, Provider, Memory, State, ProviderResult } from '@elizaos/core';
import { ServiceType, logger } from '@elizaos/core';
import { z } from 'zod';

import { BrowserService, Session } from './services/browser-service.js';
import { BrowserWebSocketClient } from './services/websocket-client.js';
import { BrowserProcessManager } from './services/process-manager.js';

// Import actions
import { browserNavigateAction } from './actions/navigate.js';
import { browserClickAction } from './actions/click.js';
import { browserTypeAction } from './actions/type.js';
import { browserSelectAction } from './actions/select.js';
import { browserExtractAction } from './actions/extract.js';
import { browserScreenshotAction } from './actions/screenshot.js';

// Export types
export * from './types.js';

// Export utilities
export * from './utils/index.js';

// Export services
export { BrowserService, Session, BrowserWebSocketClient, BrowserProcessManager };

// Export actions
export {
  browserNavigateAction,
  browserClickAction,
  browserTypeAction,
  browserSelectAction,
  browserExtractAction,
  browserScreenshotAction,
};

// Configuration schema
const configSchema = z.object({
  BROWSERBASE_API_KEY: z.string().optional(),
  BROWSERBASE_PROJECT_ID: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),
  OLLAMA_MODEL: z.string().optional(),
  BROWSER_HEADLESS: z
    .string()
    .transform((val) => val === 'true')
    .optional()
    .default('true'),
  CAPSOLVER_API_KEY: z.string().optional(),
  BROWSER_SERVER_PORT: z.string().optional().default('3456'),
});

// Browser state provider
const browserStateProvider: Provider = {
  name: 'BROWSER_STATE',
  description: 'Provides current browser state information including active session status, current page URL, and page title',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const service = runtime.getService<BrowserService>(ServiceType.BROWSER);
    const session = await service?.getCurrentSession();

    if (!session || !service) {
      return {
        text: 'No active browser session',
        values: {
          hasSession: false,
        },
        data: {},
      };
    }

    try {
      const client = service.getClient();
      const state = await client.getState(session.id);

      return {
        text: `Current browser page: "${state.title}" at ${state.url}`,
        values: {
          hasSession: true,
          url: state.url,
          title: state.title,
        },
        data: {
          sessionId: session.id,
          createdAt: session.createdAt.toISOString(),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error getting browser state: ${errorMessage}`);
      return {
        text: 'Error getting browser state',
        values: {
          hasSession: true,
          error: true,
        },
        data: {},
      };
    }
  },
};

// Main plugin definition
export const browserPlugin: Plugin = {
  name: 'plugin-browser',
  description: 'Browser automation plugin using Stagehand for web interactions',
  config: {
    BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY ?? null,
    BROWSERBASE_PROJECT_ID: process.env.BROWSERBASE_PROJECT_ID ?? null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? null,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL ?? null,
    BROWSER_HEADLESS: process.env.BROWSER_HEADLESS ?? 'true',
    CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY ?? null,
    BROWSER_SERVER_PORT: process.env.BROWSER_SERVER_PORT ?? '3456',
  },
  async init(config: Record<string, string | null>, _runtime: IAgentRuntime) {
    logger.info('Initializing browser automation plugin');
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value !== undefined && value !== null) {
          process.env[key] = String(value);
        }
      }

      logger.info('Browser plugin initialized successfully');
    } catch (caughtError: unknown) {
      const zodErrorCheck = caughtError as { issues?: Array<{ message: string }> };
      if (zodErrorCheck.issues && Array.isArray(zodErrorCheck.issues)) {
        const errorMessages = zodErrorCheck.issues.map((e) => e.message).join(', ');
        throw new Error(`Invalid plugin configuration: ${errorMessages}`);
      }
      throw caughtError;
    }
  },
  services: [BrowserService],
  actions: [
    browserNavigateAction,
    browserClickAction,
    browserTypeAction,
    browserSelectAction,
    browserExtractAction,
    browserScreenshotAction,
  ],
  providers: [browserStateProvider],
};

// Default export
export default browserPlugin;
