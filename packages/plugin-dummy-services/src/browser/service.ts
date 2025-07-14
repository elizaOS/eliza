import { IAgentRuntime } from '@elizaos/core';
import {
  IBrowserService,
  BrowserNavigationOptions,
  ScreenshotOptions,
  ElementSelector,
  ExtractedContent,
  ClickOptions,
  TypeOptions,
} from '@elizaos/core';

/**
 * Dummy browser service for testing purposes
 * Provides mock implementations of browser automation operations
 */
export class DummyBrowserService extends IBrowserService {
  static override readonly serviceType = IBrowserService.serviceType;

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
    this.runtime.logger.info('DummyBrowserService initialized');
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('DummyBrowserService stopped');
  }

  async navigate(url: string, options?: BrowserNavigationOptions): Promise<void> {
    this.runtime.logger.debug(`Navigating to ${url}`);

    if (options) {
      this.runtime.logger.debug('Navigation options:', options);
    }

    // Update navigation history
    this.history.push(url);
    this.historyIndex = this.history.length - 1;
    this.currentUrl = url;

    // Simulate navigation delay
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    this.runtime.logger.debug('Taking screenshot');

    if (options) {
      this.runtime.logger.debug('Screenshot options:', options);
    }

    // Mock screenshot - return a fake image buffer
    const mockImage = `Mock screenshot of ${this.currentUrl}`;
    const imageBuffer = Buffer.from(mockImage, 'utf8');

    return imageBuffer;
  }

  async extractContent(selector?: string): Promise<ExtractedContent> {
    this.runtime.logger.debug(`Extracting content${selector ? ` from ${selector}` : ''}`);

    // Mock content extraction based on current URL
    let isGitHub = false;
    let isGoogle = false;

    try {
      const url = new URL(this.currentUrl);
      isGitHub = url.hostname === 'github.com' || url.hostname.endsWith('.github.com');
      isGoogle = url.hostname === 'google.com' || url.hostname.endsWith('.google.com');
    } catch (error) {
      // If URL is invalid, default to false for both
      this.runtime.logger.debug('Invalid URL format, defaulting to generic content');
    }

    let mockContent: ExtractedContent;

    if (isGitHub) {
      mockContent = {
        text: 'Mock GitHub repository content\n\nThis is a dummy browser service extracting content from GitHub.\n\nFeatures:\n- Mock code repository\n- Sample README content\n- Dummy issue tracking',
        html: '<div class="repository-content"><h1>Mock Repository</h1><p>This is a dummy GitHub repository.</p></div>',
        links: [
          { url: 'https://github.com/mock/repo/issues', text: 'Issues' },
          { url: 'https://github.com/mock/repo/pulls', text: 'Pull Requests' },
          { url: 'https://github.com/mock/repo/wiki', text: 'Wiki' },
        ],
        images: [{ src: 'https://github.com/mock/repo/avatar.png', alt: 'Repository Avatar' }],
        title: 'Mock Repository - GitHub',
        metadata: {
          'og:title': 'Mock Repository',
          'og:description': 'A dummy repository for testing',
          'og:type': 'website',
        },
      };
    } else if (isGoogle) {
      mockContent = {
        text: 'Mock Google search results\n\nSearch results for your query:\n\n1. Mock Result 1\n2. Mock Result 2\n3. Mock Result 3',
        html: '<div class="search-results"><div class="result"><h3>Mock Result 1</h3><p>Mock description</p></div></div>',
        links: [
          { url: 'https://example.com/result1', text: 'Mock Result 1' },
          { url: 'https://example.com/result2', text: 'Mock Result 2' },
          { url: 'https://example.com/result3', text: 'Mock Result 3' },
        ],
        images: [{ src: 'https://google.com/logo.png', alt: 'Google Logo' }],
        title: 'Mock Search - Google',
        metadata: {
          description: 'Mock search results page',
        },
      };
    } else {
      mockContent = {
        text: `Mock content from ${this.currentUrl}\n\nThis is dummy content extracted by the browser service.\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit.`,
        html: '<div class="content"><h1>Mock Page</h1><p>This is mock content from the dummy browser service.</p></div>',
        links: [
          { url: `${this.currentUrl}/page1`, text: 'Page 1' },
          { url: `${this.currentUrl}/page2`, text: 'Page 2' },
        ],
        images: [{ src: `${this.currentUrl}/image.jpg`, alt: 'Mock Image' }],
        title: 'Mock Page Title',
        metadata: {
          description: 'Mock page description',
        },
      };
    }

    return mockContent;
  }

  async click(selector: string | ElementSelector, options?: ClickOptions): Promise<void> {
    const selectorStr = typeof selector === 'string' ? selector : selector.selector;
    this.runtime.logger.debug(`Clicking on ${selectorStr}`);

    if (options) {
      this.runtime.logger.debug('Click options:', options);
    }

    // Simulate click delay
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  async type(selector: string, text: string, options?: TypeOptions): Promise<void> {
    this.runtime.logger.debug(`Typing "${text}" into ${selector}`);

    if (options) {
      this.runtime.logger.debug('Type options:', options);
    }

    // Simulate typing delay
    const delay = options?.delay || 10;
    await new Promise((resolve) => setTimeout(resolve, delay * text.length));
  }

  async waitForElement(selector: string | ElementSelector): Promise<void> {
    const selectorStr = typeof selector === 'string' ? selector : selector.selector;
    this.runtime.logger.debug(`Waiting for element ${selectorStr}`);

    // Simulate element wait
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async evaluate<T = any>(script: string, ...args: any[]): Promise<T> {
    this.runtime.logger.debug(`Evaluating script: ${script}`);

    // Mock script evaluation
    if (script.includes('document.title')) {
      return 'Mock Page Title' as T;
    }

    if (script.includes('window.location.href')) {
      return this.currentUrl as T;
    }

    if (script.includes('document.body.innerHTML')) {
      return '<div>Mock page content</div>' as T;
    }

    // Default mock result
    return { result: 'mock evaluation result', args } as T;
  }

  async getCurrentUrl(): Promise<string> {
    return this.currentUrl;
  }

  async goBack(): Promise<void> {
    this.runtime.logger.debug('Going back in history');

    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.currentUrl = this.history[this.historyIndex];
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  async goForward(): Promise<void> {
    this.runtime.logger.debug('Going forward in history');

    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.currentUrl = this.history[this.historyIndex];
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  async refresh(): Promise<void> {
    this.runtime.logger.debug('Refreshing page');

    // Simulate page refresh
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
