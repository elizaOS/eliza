import { z } from 'zod';
import { SessionManager } from './session-manager.js';
import { Logger } from './logger.js';
import { detectCaptchaType, injectCaptchaSolution } from './captcha-handler.js';

export interface Message {
  type: string;
  requestId: string;
  sessionId?: string;
  data?: any;
}

export interface Response {
  type: string;
  requestId: string;
  success: boolean;
  data?: any;
  error?: string;
}

export class MessageHandler {
  constructor(
    private sessionManager: SessionManager,
    private logger: Logger
  ) {}

  async handleMessage(message: Message, clientId: string): Promise<Response> {
    const { type, requestId, sessionId, data } = message;

    try {
      switch (type) {
        case 'health':
          return this.handleHealth(requestId);

        case 'createSession':
          return await this.handleCreateSession(requestId, clientId);

        case 'destroySession':
          return await this.handleDestroySession(requestId, sessionId!);

        case 'navigate':
          return await this.handleNavigate(requestId, sessionId!, data.url);

        case 'goBack':
          return await this.handleGoBack(requestId, sessionId!);

        case 'goForward':
          return await this.handleGoForward(requestId, sessionId!);

        case 'refresh':
          return await this.handleRefresh(requestId, sessionId!);

        case 'click':
          return await this.handleClick(requestId, sessionId!, data.description);

        case 'type':
          return await this.handleType(requestId, sessionId!, data.text, data.field);

        case 'select':
          return await this.handleSelect(requestId, sessionId!, data.option, data.dropdown);

        case 'extract':
          return await this.handleExtract(requestId, sessionId!, data.instruction);

        case 'screenshot':
          return await this.handleScreenshot(requestId, sessionId!);

        case 'getState':
          return await this.handleGetState(requestId, sessionId!);

        case 'solveCaptcha':
          return await this.handleSolveCaptcha(requestId, sessionId!);

        default:
          return {
            type: 'error',
            requestId,
            success: false,
            error: `Unknown message type: ${type}`,
          };
      }
    } catch (error) {
      this.logger.error(`Error handling ${type}:`, error);
      return {
        type: 'error',
        requestId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async handleCreateSession(requestId: string, clientId: string): Promise<Response> {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const session = await this.sessionManager.createSession(sessionId, clientId);

    return {
      type: 'sessionCreated',
      requestId,
      success: true,
      data: {
        sessionId: session.id,
        createdAt: session.createdAt,
      },
    };
  }

  private async handleDestroySession(requestId: string, sessionId: string): Promise<Response> {
    await this.sessionManager.destroySession(sessionId);

    return {
      type: 'sessionDestroyed',
      requestId,
      success: true,
    };
  }

  private async handleNavigate(
    requestId: string,
    sessionId: string,
    url: string
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    await session.stagehand.page.goto(url);
    await session.stagehand.page.waitForLoadState('domcontentloaded');

    const title = await session.stagehand.page.title();
    const currentUrl = session.stagehand.page.url();

    return {
      type: 'navigated',
      requestId,
      success: true,
      data: {
        url: currentUrl,
        title,
      },
    };
  }

  private async handleGoBack(requestId: string, sessionId: string): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    await session.stagehand.page.goBack();
    await session.stagehand.page.waitForLoadState('domcontentloaded');

    const title = await session.stagehand.page.title();
    const url = session.stagehand.page.url();

    return {
      type: 'wentBack',
      requestId,
      success: true,
      data: { url, title },
    };
  }

  private async handleGoForward(requestId: string, sessionId: string): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    await session.stagehand.page.goForward();
    await session.stagehand.page.waitForLoadState('domcontentloaded');

    const title = await session.stagehand.page.title();
    const url = session.stagehand.page.url();

    return {
      type: 'wentForward',
      requestId,
      success: true,
      data: { url, title },
    };
  }

  private async handleRefresh(requestId: string, sessionId: string): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    await session.stagehand.page.reload();
    await session.stagehand.page.waitForLoadState('domcontentloaded');

    const title = await session.stagehand.page.title();
    const url = session.stagehand.page.url();

    return {
      type: 'refreshed',
      requestId,
      success: true,
      data: { url, title },
    };
  }

  private async handleClick(
    requestId: string,
    sessionId: string,
    description: string
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    await session.stagehand.act({
      action: `click on ${description}`,
    });

    return {
      type: 'clicked',
      requestId,
      success: true,
      data: { description },
    };
  }

  private async handleType(
    requestId: string,
    sessionId: string,
    text: string,
    field: string
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    await session.stagehand.act({
      action: `type "${text}" into ${field}`,
    });

    return {
      type: 'typed',
      requestId,
      success: true,
      data: { text, field },
    };
  }

  private async handleSelect(
    requestId: string,
    sessionId: string,
    option: string,
    dropdown: string
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    await session.stagehand.act({
      action: `select "${option}" from ${dropdown}`,
    });

    return {
      type: 'selected',
      requestId,
      success: true,
      data: { option, dropdown },
    };
  }

  private async handleExtract(
    requestId: string,
    sessionId: string,
    instruction: string
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const extractedData = await session.stagehand.extract({
      instruction,
      schema: z.object({
        data: z.string().describe('The extracted data'),
        found: z.boolean().describe('Whether the requested data was found'),
      }) as any,
    });

    return {
      type: 'extracted',
      requestId,
      success: true,
      data: extractedData,
    };
  }

  private async handleScreenshot(requestId: string, sessionId: string): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const screenshot = await session.stagehand.page.screenshot({
      type: 'png',
      fullPage: true,
    });

    const base64Screenshot = screenshot.toString('base64');
    const url = session.stagehand.page.url();
    const title = await session.stagehand.page.title();

    return {
      type: 'screenshot',
      requestId,
      success: true,
      data: {
        screenshot: base64Screenshot,
        mimeType: 'image/png',
        url,
        title,
      },
    };
  }

  private async handleGetState(requestId: string, sessionId: string): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const url = session.stagehand.page.url();
    const title = await session.stagehand.page.title();

    return {
      type: 'state',
      requestId,
      success: true,
      data: {
        url,
        title,
        sessionId,
        createdAt: session.createdAt,
      },
    };
  }

  private async handleSolveCaptcha(requestId: string, sessionId: string): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    // This would need captcha solving implementation
    // For now, just detect if there's a captcha
    const captchaInfo = await detectCaptchaType(session.stagehand.page);

    return {
      type: 'captchaSolved',
      requestId,
      success: captchaInfo.type !== null,
      data: {
        captchaDetected: captchaInfo.type !== null,
        captchaType: captchaInfo.type,
        siteKey: captchaInfo.siteKey,
      },
    };
  }

  private sessionNotFoundResponse(requestId: string): Response {
    return {
      type: 'error',
      requestId,
      success: false,
      error: 'Session not found',
    };
  }

  private handleHealth(requestId: string): Response {
    return {
      type: 'health',
      requestId,
      success: true,
      data: {
        status: 'ok',
        message: 'Stagehand server is running',
      },
    };
  }
}
