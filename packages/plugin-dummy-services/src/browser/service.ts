import { IAgentRuntime, Service, ServiceType, logger } from '@elizaos/core';

// Define browser-specific types locally since they're not in core
export interface BrowserNavigationOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  quality?: number;
  type?: 'png' | 'jpeg';
}

export interface ElementSelector {
  selector: string;
  type?: 'css' | 'xpath';
}

export interface ExtractedContent {
  text?: string;
  html?: string;
  attributes?: Record<string, string>;
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
}

export interface TypeOptions {
  delay?: number;
  clearFirst?: boolean;
}

/**
 * Dummy browser service for testing purposes
 * Provides mock implementations of browser automation operations
 */
export class DummyBrowserService extends Service {
  static readonly serviceType = ServiceType.BROWSER;

  capabilityDescription = 'Dummy browser service for testing';

  private currentUrl: string = 'about:blank';
  private history: string[] = [];
  private historyIndex: number = -1;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyBrowserService> {
    const service = new DummyBrowserService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    logger.info('DummyBrowserService initialized');
  }

  async stop(): Promise<void> {
    logger.info('DummyBrowserService stopped');
  }

  async navigate(url: string, options?: BrowserNavigationOptions): Promise<void> {
    logger.debug(`Navigating to ${url}`);

    if (options) {
      logger.debug('Navigation options:', JSON.stringify(options));
    }

    // Update navigation history
    this.history.push(url);
    this.historyIndex = this.history.length - 1;
    this.currentUrl = url;

    // Simulate navigation delay
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    logger.debug('Taking screenshot', JSON.stringify(options));

    // Return dummy image buffer
    const dummyImage = Buffer.from('dummy-screenshot-data');

    logger.debug(`Screenshot taken: ${dummyImage.length} bytes`);

    return dummyImage;
  }

  async extractContent(selectors?: ElementSelector[]): Promise<ExtractedContent[]> {
    logger.debug('Extracting content', JSON.stringify(selectors));

    // Return dummy content
    const dummyContent: ExtractedContent[] = [
      {
        text: 'Dummy extracted text',
        html: '<div>Dummy HTML content</div>',
        attributes: {
          class: 'dummy-class',
          id: 'dummy-id',
        },
      },
    ];

    if (selectors && selectors.length > 0) {
      return selectors.map((selector) => ({
        text: `Dummy text for ${selector.selector}`,
        html: `<div>${selector.selector}</div>`,
        attributes: { selector: selector.selector },
      }));
    }

    return dummyContent;
  }

  async waitForSelector(selector: ElementSelector, timeout?: number): Promise<boolean> {
    logger.debug(`Waiting for selector: ${selector.selector}`);

    // Simulate wait delay
    const waitTime = Math.min(timeout || 1000, 100);
    await new Promise((resolve) => setTimeout(resolve, waitTime));

    // Always return true for dummy implementation
    logger.debug(`Selector found: ${selector.selector}`);
    return true;
  }

  async click(selector: ElementSelector, options?: ClickOptions): Promise<void> {
    logger.debug(`Clicking on: ${selector.selector}`, JSON.stringify(options));

    // Simulate click delay
    const delay = options?.delay || 50;
    await new Promise((resolve) => setTimeout(resolve, delay));

    logger.debug(`Clicked on: ${selector.selector}`);
  }

  async type(selector: ElementSelector, text: string, options?: TypeOptions): Promise<void> {
    logger.debug(`Typing into: ${selector.selector}`, JSON.stringify(options));

    // Simulate typing delay
    const delay = options?.delay || 50;
    await new Promise((resolve) => setTimeout(resolve, text.length * delay));

    logger.debug(`Typed "${text}" into: ${selector.selector}`);
  }

  async evaluateScript<T = any>(script: string): Promise<T> {
    logger.debug('Evaluating script:', script.substring(0, 100) + '...');

    // Return dummy result
    return { success: true, data: 'dummy-script-result' } as any;
  }

  async goBack(): Promise<void> {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.currentUrl = this.history[this.historyIndex];
      logger.debug(`Navigated back to: ${this.currentUrl}`);
    }
  }

  async goForward(): Promise<void> {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.currentUrl = this.history[this.historyIndex];
      logger.debug(`Navigated forward to: ${this.currentUrl}`);
    }
  }

  async refresh(): Promise<void> {
    logger.debug(`Refreshing page: ${this.currentUrl}`);
    // Simulate refresh delay
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async getUrl(): Promise<string> {
    logger.debug(`Current URL: ${this.currentUrl}`);
    return this.currentUrl;
  }

  async getTitle(): Promise<string> {
    logger.debug('Getting page title');
    return `Dummy Title - ${this.currentUrl}`;
  }

  async setCookies(cookies: any[]): Promise<void> {
    logger.debug(`Setting ${cookies.length} cookies`);
  }

  async getCookies(): Promise<any[]> {
    logger.debug('Getting cookies');
    return [];
  }

  async clearCookies(): Promise<void> {
    logger.debug('Clearing cookies');
  }

  getDexName(): string {
    return 'dummy-browser';
  }
}
