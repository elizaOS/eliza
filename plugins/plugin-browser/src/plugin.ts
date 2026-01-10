import type { Plugin } from '@elizaos/core';
import {
  type Action,
  type ActionResult,
  type Content,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from '@elizaos/core';
import { z } from 'zod';
import { StagehandService } from './service.js';
import {
  BrowserActionError,
  BrowserNavigationError,
  BrowserSecurityError,
  BrowserServiceNotAvailableError,
  BrowserSessionError,
  StagehandError,
  handleBrowserError,
} from './errors.js';
import { browserRetryConfigs, retryWithBackoff } from './retry.js';
import { defaultUrlValidator, validateSecureAction } from './security.js';

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
  STAGEHAND_SERVER_PORT: z.string().optional().default('3456'),
});

// Helper function to extract URL from text
function extractUrl(text: string): string | null {
  const quotedUrlMatch = text.match(/["']([^"']+)["']/);
  if (quotedUrlMatch && (quotedUrlMatch[1].startsWith('http') || quotedUrlMatch[1].includes('.'))) {
    return quotedUrlMatch[1];
  }

  const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }

  const domainMatch = text.match(
    /(?:go to|navigate to|open|visit)\s+([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,})/i
  );
  if (domainMatch) {
    return `https://${domainMatch[1]}`;
  }

  return null;
}

// Browser navigation action
const browserNavigateAction: Action = {
  name: 'BROWSER_NAVIGATE',
  similes: ['GO_TO_URL', 'OPEN_WEBSITE', 'VISIT_PAGE', 'NAVIGATE_TO'],
  description:
    'Navigate the browser to a specified URL. Can be chained with BROWSER_EXTRACT to get content or BROWSER_SCREENSHOT to capture the page',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const browserEnabled =
      runtime.getSetting('ENABLE_BROWSER') === 'true' ||
      runtime.getSetting('BROWSER_ENABLED') === 'true';

    if (!browserEnabled) {
      logger.debug('Browser capability disabled in settings.');
      return false;
    }

    const service = runtime.getService<StagehandService>(StagehandService.serviceType);
    if (!service) {
      logger.debug('Stagehand service not available.');
      return false;
    }

    const url = extractUrl(message.content.text || '');
    return url !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: any,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    try {
      logger.info('Handling BROWSER_NAVIGATE action');

      const service = runtime.getService<StagehandService>(StagehandService.serviceType);
      if (!service) {
        const error = new BrowserServiceNotAvailableError();
        handleBrowserError(error, callback, 'navigate to the requested page');
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

      const url = extractUrl(message.content.text || '');
      if (!url) {
        const error = new StagehandError(
          'No URL found in message',
          'NO_URL_FOUND',
          "I couldn't find a URL in your request. Please provide a valid URL to navigate to.",
          false
        );
        handleBrowserError(error, callback, 'navigate to a page');
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
        if (error instanceof BrowserSecurityError) {
          handleBrowserError(error, callback);
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
          return await client.navigate(session.id, url);
        },
        browserRetryConfigs.navigation,
        `navigate to ${url}`
      );

      const responseContent: Content = {
        text: `I've navigated to ${url}. The page title is: "${result.title}"`,
        actions: ['BROWSER_NAVIGATE'],
        source: message.content.source,
      };

      await callback?.(responseContent);

      // Track browser usage for progression
      await runtime.emitEvent(EventType.BROWSER_ACTION_PERFORMED, {
        action: 'navigation',
        url: result.url,
        title: result.title,
      });

      return {
        text: responseContent.text,
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
    } catch (error) {
      logger.error('Error in BROWSER_NAVIGATE action:', error);

      if (error instanceof StagehandError) {
        handleBrowserError(error, callback);
      } else {
        const browserError = new BrowserNavigationError(
          extractUrl(message.content.text || '') || 'the requested page',
          error as Error
        );
        handleBrowserError(browserError, callback);
      }
      return {
        text: 'Failed to navigate to the requested page',
        success: false,
        data: {
          actionName: 'BROWSER_NAVIGATE',
          error: error instanceof Error ? error.message : 'unknown_error',
          url: extractUrl(message.content.text || '') || 'unknown',
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

// BROWSER_CLICK action implementation
const browserClickAction: Action = {
  name: 'BROWSER_CLICK',
  similes: ['CLICK_ELEMENT', 'TAP', 'PRESS_BUTTON'],
  description: 'Click on an element on the webpage',
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'Click on the search button' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've clicked on the search button.",
          actions: ['BROWSER_CLICK'],
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const browserEnabled =
      runtime.getSetting('ENABLE_BROWSER') === 'true' ||
      runtime.getSetting('BROWSER_ENABLED') === 'true';

    if (!browserEnabled) {
      return false;
    }

    const service = runtime.getService<StagehandService>(StagehandService.serviceType);
    if (!service) {
      return false;
    }

    const text = message.content?.text?.toLowerCase() || '';
    return text.includes('click') || text.includes('tap') || text.includes('press');
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService<StagehandService>(StagehandService.serviceType);
      if (!service) {
        const error = new BrowserServiceNotAvailableError();
        handleBrowserError(error, callback, 'click on element');
        return {
          text: 'Browser service is not available',
          success: false,
          data: {
            actionName: 'BROWSER_CLICK',
            error: 'service_not_available',
          },
          values: {
            success: false,
            errorType: 'service_not_available',
          },
        };
      }

      const session = await service.getOrCreateSession();
      if (!session) {
        const error = new BrowserSessionError('No active browser session');
        handleBrowserError(error, callback, 'click on element');
        return {
          text: 'No active browser session',
          success: false,
          data: {
            actionName: 'BROWSER_CLICK',
            error: 'no_session',
          },
          values: {
            success: false,
            errorType: 'no_session',
          },
        };
      }

      const text = message.content?.text || '';
      // Extract what to click from the message
      const match = text.match(/click (?:on |the )?(.+)$/i);
      const description = match ? match[1] : 'element';

      const result = await service.getClient().click(session.id, description);
      if (!result.success) {
        throw new BrowserActionError(
          'click',
          description,
          new Error(result.error || 'Click failed')
        );
      }

      const responseContent: Content = {
        text: `I've successfully clicked on "${description}"`,
        actions: ['BROWSER_CLICK'],
        source: message.content?.source || 'action',
      };

      await callback?.(responseContent);

      // Track browser usage for progression
      await runtime.emitEvent(EventType.BROWSER_ACTION_PERFORMED, {
        action: 'click',
        element: description,
      });

      // Check if this is a form submission button
      const lowerDesc = description.toLowerCase();
      if (
        lowerDesc.includes('submit') ||
        lowerDesc.includes('send') ||
        lowerDesc.includes('post') ||
        lowerDesc.includes('save')
      ) {
        await runtime.emitEvent(EventType.FORM_SUBMITTED, {
          details: { element: description, action: 'click' },
        });
      }

      return {
        text: responseContent.text,
        success: true,
        data: {
          actionName: 'BROWSER_CLICK',
          element: description,
          sessionId: session.id,
        },
        values: {
          success: true,
          element: description,
        },
      };
    } catch (error) {
      logger.error('Error in BROWSER_CLICK action:', error);

      if (error instanceof StagehandError) {
        handleBrowserError(error, callback);
      } else {
        const browserError = new BrowserActionError('click', 'element', error as Error);
        handleBrowserError(browserError, callback);
      }
      return {
        text: 'Failed to click on the requested element',
        success: false,
        data: {
          actionName: 'BROWSER_CLICK',
          error: error instanceof Error ? error.message : 'unknown_error',
        },
        values: {
          success: false,
          errorType: 'click_error',
        },
      };
    }
  },
};

// BROWSER_TYPE action implementation
const browserTypeAction: Action = {
  name: 'BROWSER_TYPE',
  similes: ['TYPE_TEXT', 'INPUT', 'ENTER_TEXT'],
  description: 'Type text into an input field on the webpage',
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'Type "hello world" in the search box' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I\'ve typed "hello world" in the search box.',
          actions: ['BROWSER_TYPE'],
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const browserEnabled =
      runtime.getSetting('ENABLE_BROWSER') === 'true' ||
      runtime.getSetting('BROWSER_ENABLED') === 'true';

    if (!browserEnabled) {
      return false;
    }

    const service = runtime.getService<StagehandService>(StagehandService.serviceType);
    if (!service) {
      return false;
    }

    const text = message.content?.text?.toLowerCase() || '';
    return text.includes('type') || text.includes('input') || text.includes('enter');
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService<StagehandService>(StagehandService.serviceType);
      if (!service) {
        const error = new BrowserServiceNotAvailableError();
        handleBrowserError(error, callback, 'type text');
        return {
          text: 'Browser service is not available',
          success: false,
          data: {
            actionName: 'BROWSER_TYPE',
            error: 'service_not_available',
          },
          values: {
            success: false,
            errorType: 'service_not_available',
          },
        };
      }

      const session = await service.getOrCreateSession();
      if (!session) {
        const error = new BrowserSessionError('No active browser session');
        handleBrowserError(error, callback, 'type text');
        return {
          text: 'No active browser session',
          success: false,
          data: {
            actionName: 'BROWSER_TYPE',
            error: 'no_session',
          },
          values: {
            success: false,
            errorType: 'no_session',
          },
        };
      }

      const text = message.content?.text || '';
      // Extract what to type from the message (in quotes)
      const match = text.match(/["']([^"']+)["']/);
      const textToType = match ? match[1] : '';

      // Extract where to type (after "in" or "into")
      const fieldMatch = text.match(/(?:in|into) (?:the )?(.+)$/i);
      const field = fieldMatch ? fieldMatch[1] : 'input field';

      if (!textToType) {
        throw new BrowserActionError('type', field, new Error('No text specified to type'));
      }

      const result = await service.getClient().type(session.id, textToType, field);
      if (!result.success) {
        throw new BrowserActionError('type', field, new Error(result.error || 'Type failed'));
      }

      const responseContent: Content = {
        text: `I've typed "${textToType}" in the ${field}`,
        actions: ['BROWSER_TYPE'],
        source: message.content?.source || 'action',
      };

      await callback?.(responseContent);

      // Track browser usage for progression
      await runtime.emitEvent(EventType.BROWSER_ACTION_PERFORMED, {
        action: 'type',
        field,
        text: textToType,
      });

      // Check if this might be a form submission (typing in a form field)
      if (field.toLowerCase().includes('form') || field.toLowerCase().includes('submit')) {
        await runtime.emitEvent(EventType.FORM_SUBMITTED, {
          details: { field, text: textToType, action: 'type' },
        });
      }

      return {
        text: responseContent.text,
        success: true,
        data: {
          actionName: 'BROWSER_TYPE',
          textTyped: textToType,
          field,
          sessionId: session.id,
        },
        values: {
          success: true,
          textTyped: textToType,
          field,
        },
      };
    } catch (error) {
      logger.error('Error in BROWSER_TYPE action:', error);

      if (error instanceof StagehandError) {
        handleBrowserError(error, callback);
      } else {
        const browserError = new BrowserActionError('type', 'input field', error as Error);
        handleBrowserError(browserError, callback);
      }
      return {
        text: 'Failed to type text',
        success: false,
        data: {
          actionName: 'BROWSER_TYPE',
          error: error instanceof Error ? error.message : 'unknown_error',
        },
        values: {
          success: false,
          errorType: 'type_error',
        },
      };
    }
  },
};

// BROWSER_SELECT action implementation
const browserSelectAction: Action = {
  name: 'BROWSER_SELECT',
  similes: ['SELECT_OPTION', 'CHOOSE', 'PICK'],
  description: 'Select an option from a dropdown on the webpage',
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'Select "United States" from the country dropdown' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I\'ve selected "United States" from the country dropdown.',
          actions: ['BROWSER_SELECT'],
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const browserEnabled =
      runtime.getSetting('ENABLE_BROWSER') === 'true' ||
      runtime.getSetting('BROWSER_ENABLED') === 'true';

    if (!browserEnabled) {
      return false;
    }

    const service = runtime.getService<StagehandService>(StagehandService.serviceType);
    if (!service) {
      return false;
    }

    const text = message.content?.text?.toLowerCase() || '';
    return text.includes('select') || text.includes('choose') || text.includes('pick');
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService<StagehandService>(StagehandService.serviceType);
      if (!service) {
        const error = new BrowserServiceNotAvailableError();
        handleBrowserError(error, callback, 'select option');
        return {
          text: 'Browser service is not available',
          success: false,
          data: {
            actionName: 'BROWSER_SELECT',
            error: 'service_not_available',
          },
          values: {
            success: false,
            errorType: 'service_not_available',
          },
        };
      }

      const session = await service.getOrCreateSession();
      if (!session) {
        const error = new BrowserSessionError('No active browser session');
        handleBrowserError(error, callback, 'select option');
        return {
          text: 'No active browser session',
          success: false,
          data: {
            actionName: 'BROWSER_SELECT',
            error: 'no_session',
          },
          values: {
            success: false,
            errorType: 'no_session',
          },
        };
      }

      const text = message.content?.text || '';
      // Extract what to select (in quotes)
      const match = text.match(/["']([^"']+)["']/);
      const option = match ? match[1] : '';

      // Extract from where (after "from")
      const dropdownMatch = text.match(/from (?:the )?(.+)$/i);
      const dropdown = dropdownMatch ? dropdownMatch[1] : 'dropdown';

      if (!option) {
        throw new BrowserActionError(
          'select',
          dropdown,
          new Error('No option specified to select')
        );
      }

      const result = await service.getClient().select(session.id, option, dropdown);
      if (!result.success) {
        throw new BrowserActionError(
          'select',
          dropdown,
          new Error(result.error || 'Select failed')
        );
      }

      const responseContent: Content = {
        text: `I've selected "${option}" from the ${dropdown}`,
        actions: ['BROWSER_SELECT'],
        source: message.content?.source || 'action',
      };

      await callback?.(responseContent);
      return {
        text: responseContent.text,
        success: true,
        data: {
          actionName: 'BROWSER_SELECT',
          option,
          dropdown,
          sessionId: session.id,
        },
        values: {
          success: true,
          option,
          dropdown,
        },
      };
    } catch (error) {
      logger.error('Error in BROWSER_SELECT action:', error);

      if (error instanceof StagehandError) {
        handleBrowserError(error, callback);
      } else {
        const browserError = new BrowserActionError('select', 'dropdown', error as Error);
        handleBrowserError(browserError, callback);
      }
      return {
        text: 'Failed to select option',
        success: false,
        data: {
          actionName: 'BROWSER_SELECT',
          error: error instanceof Error ? error.message : 'unknown_error',
        },
        values: {
          success: false,
          errorType: 'select_error',
        },
      };
    }
  },
};

// BROWSER_EXTRACT action implementation
const browserExtractAction: Action = {
  name: 'BROWSER_EXTRACT',
  similes: ['EXTRACT_DATA', 'GET_TEXT', 'SCRAPE'],
  description: 'Extract data from the webpage',
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'Extract the main heading from the page' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I extracted the main heading: "Welcome to Our Website"',
          actions: ['BROWSER_EXTRACT'],
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const browserEnabled =
      runtime.getSetting('ENABLE_BROWSER') === 'true' ||
      runtime.getSetting('BROWSER_ENABLED') === 'true';

    if (!browserEnabled) {
      return false;
    }

    const service = runtime.getService<StagehandService>(StagehandService.serviceType);
    if (!service) {
      return false;
    }

    const text = message.content?.text?.toLowerCase() || '';
    return (
      text.includes('extract') ||
      text.includes('get') ||
      text.includes('scrape') ||
      text.includes('find') ||
      text.includes('read')
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService<StagehandService>(StagehandService.serviceType);
      if (!service) {
        const error = new BrowserServiceNotAvailableError();
        handleBrowserError(error, callback, 'extract data');
        return {
          text: 'Browser service is not available',
          success: false,
          data: {
            actionName: 'BROWSER_EXTRACT',
            error: 'service_not_available',
          },
          values: {
            success: false,
            errorType: 'service_not_available',
          },
        };
      }

      const session = await service.getOrCreateSession();
      if (!session) {
        const error = new BrowserSessionError('No active browser session');
        handleBrowserError(error, callback, 'extract data');
        return {
          text: 'No active browser session',
          success: false,
          data: {
            actionName: 'BROWSER_EXTRACT',
            error: 'no_session',
          },
          values: {
            success: false,
            errorType: 'no_session',
          },
        };
      }

      const text = message.content?.text || '';
      // Extract what to extract/find
      const match = text.match(/(?:extract|get|find|scrape|read) (?:the )?(.+?)(?:\s+from|\s*$)/i);
      const instruction = match ? match[1] : text;

      const result = await service.getClient().extract(session.id, instruction);
      if (!result.success) {
        throw new BrowserActionError(
          'extract',
          'page',
          new Error(result.error || 'Extraction failed')
        );
      }

      const extractedData = result.data;
      const foundText = extractedData?.data || 'No data found';
      const found = extractedData?.found || false;

      const responseContent: Content = {
        text: found
          ? `I found the ${instruction}: "${foundText}"`
          : `I couldn't find the requested ${instruction} on the page.`,
        actions: ['BROWSER_EXTRACT'],
        source: message.content?.source || 'action',
      };

      await callback?.(responseContent);
      return {
        text: responseContent.text,
        success: true,
        data: {
          actionName: 'BROWSER_EXTRACT',
          instruction,
          found,
          data: foundText,
          sessionId: session.id,
        },
        values: {
          success: true,
          found,
          data: foundText,
        },
      };
    } catch (error) {
      logger.error('Error in BROWSER_EXTRACT action:', error);

      if (error instanceof StagehandError) {
        handleBrowserError(error, callback);
      } else {
        const browserError = new BrowserActionError('extract', 'page', error as Error);
        handleBrowserError(browserError, callback);
      }
      return {
        text: 'Failed to extract data from the page',
        success: false,
        data: {
          actionName: 'BROWSER_EXTRACT',
          error: error instanceof Error ? error.message : 'unknown_error',
        },
        values: {
          success: false,
          errorType: 'extract_error',
        },
      };
    }
  },
};

// BROWSER_SCREENSHOT action implementation
const browserScreenshotAction: Action = {
  name: 'BROWSER_SCREENSHOT',
  similes: ['TAKE_SCREENSHOT', 'CAPTURE_PAGE', 'SCREENSHOT'],
  description: 'Take a screenshot of the current page',
  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'Take a screenshot of the page' },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I've taken a screenshot of the page.",
          actions: ['BROWSER_SCREENSHOT'],
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const browserEnabled =
      runtime.getSetting('ENABLE_BROWSER') === 'true' ||
      runtime.getSetting('BROWSER_ENABLED') === 'true';

    if (!browserEnabled) {
      return false;
    }

    const service = runtime.getService<StagehandService>(StagehandService.serviceType);
    if (!service) {
      return false;
    }

    const text = message.content?.text?.toLowerCase() || '';
    return text.includes('screenshot') || text.includes('capture') || text.includes('snap');
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const service = runtime.getService<StagehandService>(StagehandService.serviceType);
      if (!service) {
        const error = new BrowserServiceNotAvailableError();
        handleBrowserError(error, callback, 'take screenshot');
        return {
          text: 'Browser service is not available',
          success: false,
          data: {
            actionName: 'BROWSER_SCREENSHOT',
            error: 'service_not_available',
          },
          values: {
            success: false,
            errorType: 'service_not_available',
          },
        };
      }

      const session = await service.getOrCreateSession();
      if (!session) {
        const error = new BrowserSessionError('No active browser session');
        handleBrowserError(error, callback, 'take screenshot');
        return {
          text: 'No active browser session',
          success: false,
          data: {
            actionName: 'BROWSER_SCREENSHOT',
            error: 'no_session',
          },
          values: {
            success: false,
            errorType: 'no_session',
          },
        };
      }

      const result = await service.getClient().screenshot(session.id);
      if (!result.success) {
        throw new BrowserActionError(
          'screenshot',
          'page',
          new Error(result.error || 'Screenshot failed')
        );
      }

      const screenshotData = result.data;
      const url = screenshotData?.url || 'unknown';
      const title = screenshotData?.title || 'Untitled';

      const responseContent: Content = {
        text: `I've taken a screenshot of the page "${title}" at ${url}`,
        actions: ['BROWSER_SCREENSHOT'],
        source: message.content?.source || 'action',
        data: {
          screenshot: screenshotData?.screenshot,
          mimeType: screenshotData?.mimeType || 'image/png',
          url,
          title,
        },
      };

      await callback?.(responseContent);
      return {
        text: responseContent.text,
        success: true,
        data: {
          actionName: 'BROWSER_SCREENSHOT',
          url,
          title,
          sessionId: session.id,
          screenshot: screenshotData?.screenshot,
        },
        values: {
          success: true,
          url,
          title,
        },
      };
    } catch (error) {
      logger.error('Error in BROWSER_SCREENSHOT action:', error);

      if (error instanceof StagehandError) {
        handleBrowserError(error, callback);
      } else {
        const browserError = new BrowserActionError('screenshot', 'page', error as Error);
        handleBrowserError(browserError, callback);
      }
      return {
        text: 'Failed to take screenshot',
        success: false,
        data: {
          actionName: 'BROWSER_SCREENSHOT',
          error: error instanceof Error ? error.message : 'unknown_error',
        },
        values: {
          success: false,
          errorType: 'screenshot_error',
        },
      };
    }
  },
};

// Browser state provider
const browserStateProvider: Provider = {
  name: 'BROWSER_STATE',
  description:
    'Provides current browser state information including active session status, current page URL, and page title',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    const service = runtime.getService<StagehandService>(StagehandService.serviceType);
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
          createdAt: session.createdAt,
        },
      };
    } catch (error) {
      logger.error('Error getting browser state:', error);
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

// NOTE: For brevity, I'm only implementing two actions here.
// In the full implementation, all actions from the original plugin would be converted
// to use the WebSocket client instead of direct Stagehand calls.

// Test function to verify Stagehand works
async function testStagehandConnection(runtime: IAgentRuntime): Promise<void> {
  try {
    logger.info('[Stagehand] Running Google.com test to verify browser automation...');

    // Retry getting the service with exponential backoff
    let service: StagehandService | null = null;
    let retries = 0;
    const maxRetries = 5;

    while (!service && retries < maxRetries) {
      service = runtime.getService<StagehandService>(StagehandService.serviceType);
      if (!service) {
        if (retries === maxRetries - 1) {
          logger.warn(
            '[Stagehand] Service not available after retries. The plugin may not be fully initialized.'
          );
          return;
        }
        const waitTime = Math.pow(2, retries) * 1000; // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        logger.debug(`[Stagehand] Service not available yet, retrying in ${waitTime}ms...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        retries++;
      }
    }

    if (!service) {
      logger.warn('[Stagehand] Service not available for test');
      return;
    }

    // Wait a bit for service to be fully initialized
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Create a test session
    const sessionId = `test-google-${Date.now()}`;
    const session = await service.createSession(sessionId);

    // Navigate to Google
    const client = service.getClient();
    const result = await client.navigate(session.id, 'https://www.google.com');

    logger.info('[Stagehand] Successfully navigated to Google.com:', {
      url: result.url,
      title: result.title,
    });

    // Clean up test session
    await service.destroySession(sessionId);

    logger.info(
      '[Stagehand] Google.com test completed successfully! Browser automation is working.'
    );
  } catch (error) {
    logger.error('[Stagehand] Google.com test failed:', error);
  }
}

// Export actions for testing
export {
  browserNavigateAction,
  browserClickAction,
  browserTypeAction,
  browserSelectAction,
  browserExtractAction,
  browserScreenshotAction,
};

export const stagehandPlugin: Plugin = {
  name: 'plugin-stagehand',
  description:
    'Browser automation plugin using Stagehand - stagehand is goated for web interactions',
  config: {
    BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY,
    BROWSERBASE_PROJECT_ID: process.env.BROWSERBASE_PROJECT_ID,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    BROWSER_HEADLESS: process.env.BROWSER_HEADLESS,
    CAPSOLVER_API_KEY: process.env.CAPSOLVER_API_KEY,
    STAGEHAND_SERVER_PORT: process.env.STAGEHAND_SERVER_PORT,
  },
  async init(config: Record<string, string>, runtime: IAgentRuntime) {
    logger.info('Initializing Stagehand browser automation plugin');
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value !== undefined) {
          process.env[key] = String(value);
        }
      }

      // Schedule the Google test with a more robust approach
      // Check periodically if the runtime is ready before running the test
      let testScheduled = false;
      const scheduleTest = async () => {
        if (testScheduled) return;

        // Check if runtime has the service available
        const service = runtime.getService<StagehandService>(StagehandService.serviceType);
        if (service) {
          testScheduled = true;
          // Run the test after a short delay to ensure everything is ready
          setTimeout(() => {
            testStagehandConnection(runtime).catch((error) => {
              logger.error('[Stagehand] Init test error:', error);
            });
          }, 2000);
        } else {
          // If service not available yet, check again in 1 second
          setTimeout(scheduleTest, 1000);
        }
      };

      // Start checking for service availability after 3 seconds
      setTimeout(scheduleTest, 3000);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid plugin configuration: ${error.errors.map((e) => e.message).join(', ')}`
        );
      }
      throw error;
    }
  },
  services: [StagehandService],
  actions: [
    browserNavigateAction,
    browserClickAction,
    browserTypeAction,
    browserSelectAction,
    browserExtractAction,
    browserScreenshotAction,
    // TODO: Add back, forward, refresh actions
  ],
  providers: [browserStateProvider],
};
