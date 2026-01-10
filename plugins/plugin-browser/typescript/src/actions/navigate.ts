/**
 * Browser navigation action
 */

import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { ServiceType, logger } from '@elizaos/core';
import { BrowserService } from '../services/browser-service.js';
import { extractUrl } from '../utils/url.js';
import { handleBrowserError, NavigationError, NoUrlFoundError, ServiceNotAvailableError, SecurityError } from '../utils/errors.js';
import { retryWithBackoff, DEFAULT_RETRY_CONFIGS } from '../utils/retry.js';
import { validateSecureAction, defaultUrlValidator } from '../utils/security.js';

export const browserNavigateAction: Action = {
  name: 'BROWSER_NAVIGATE',
  similes: ['GO_TO_URL', 'OPEN_WEBSITE', 'VISIT_PAGE', 'NAVIGATE_TO'],
  description: 'Navigate the browser to a specified URL. Can be chained with BROWSER_EXTRACT to get content or BROWSER_SCREENSHOT to capture the page',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const browserEnabled =
      runtime.getSetting('ENABLE_BROWSER') === 'true' ||
      runtime.getSetting('BROWSER_ENABLED') === 'true';

    if (!browserEnabled) {
      logger.debug('Browser capability disabled in settings.');
      return false;
    }

    const service = runtime.getService<BrowserService>(ServiceType.BROWSER);
    if (!service) {
      logger.debug('Browser service not available.');
      return false;
    }

    const url = extractUrl(message.content.text ?? '');
    return url !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult | undefined> => {
    try {
      logger.info('Handling BROWSER_NAVIGATE action');

      const service = runtime.getService<BrowserService>(ServiceType.BROWSER);
      if (!service) {
        const error = new ServiceNotAvailableError();
        handleBrowserError(error, callback as (content: { text: string; error?: boolean }) => Promise<unknown>, 'navigate to the requested page');
        return {
          text: 'Browser service is not available',
          success: false,
          data: {
            actionName: 'BROWSER_NAVIGATE',
            error: 'service_not_available',
          },
          values: {
            success: false,
            errorType: 'service_not_available',
          },
        };
      }

      const url = extractUrl(message.content.text ?? '');
      if (!url) {
        const error = new NoUrlFoundError();
        handleBrowserError(error, callback as (content: { text: string; error?: boolean }) => Promise<unknown>, 'navigate to a page');
        return {
          text: "I couldn't find a URL in your request. Please provide a valid URL to navigate to.",
          success: false,
          data: {
            actionName: 'BROWSER_NAVIGATE',
            error: 'no_url_found',
          },
          values: {
            success: false,
            errorType: 'no_url_found',
          },
        };
      }

      try {
        validateSecureAction(url, defaultUrlValidator);
      } catch (error) {
        if (error instanceof SecurityError) {
          handleBrowserError(error, callback as (content: { text: string; error?: boolean }) => Promise<unknown>);
          return {
            text: 'Security error: Cannot navigate to restricted URL',
            success: false,
            data: {
              actionName: 'BROWSER_NAVIGATE',
              error: 'security_error',
              url,
            },
            values: {
              success: false,
              errorType: 'security_error',
            },
          };
        }
        throw error;
      }

      let session = await service.getCurrentSession();
      if (!session) {
        const sessionId = `session-${Date.now()}`;
        session = await service.createSession(sessionId);
      }

      const result = await retryWithBackoff(
        async () => {
          const client = service.getClient();
          return await client.navigate(session!.id, url);
        },
        DEFAULT_RETRY_CONFIGS.navigation,
        `navigate to ${url}`
      );

      const responseContent: Content = {
        text: `I've navigated to ${url}. The page title is: "${result.title}"`,
        actions: ['BROWSER_NAVIGATE'],
        source: message.content.source,
      };

      await callback?.(responseContent);

      return {
        text: responseContent.text ?? '',
        success: true,
        data: {
          actionName: 'BROWSER_NAVIGATE',
          url: result.url,
          title: result.title,
          sessionId: session.id,
        },
        values: {
          success: true,
          url: result.url,
          pageTitle: result.title,
        },
      };
    } catch (caughtError) {
      const errorMessage = caughtError instanceof Error ? caughtError.message : 'unknown_error';
      logger.error(`Error in BROWSER_NAVIGATE action: ${errorMessage}`);

      const browserError = caughtError instanceof Error
        ? new NavigationError(extractUrl(message.content.text ?? '') ?? 'the requested page', caughtError)
        : new NavigationError(extractUrl(message.content.text ?? '') ?? 'the requested page');

      handleBrowserError(browserError, callback as (content: { text: string; error?: boolean }) => Promise<unknown>);

      return {
        text: 'Failed to navigate to the requested page',
        success: false,
        data: {
          actionName: 'BROWSER_NAVIGATE',
          error: errorMessage,
          url: extractUrl(message.content.text ?? '') ?? 'unknown',
        },
        values: {
          success: false,
          errorType: 'navigation_error',
        },
      };
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Go to google.com',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I\'ve navigated to https://google.com. The page title is: "Google"',
          actions: ['BROWSER_NAVIGATE'],
        },
      },
    ],
  ],
};
