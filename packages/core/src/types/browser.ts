import { Service, ServiceType } from './service';

export interface BrowserNavigationOptions {
  timeout?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  viewport?: {
    width: number;
    height: number;
  };
  userAgent?: string;
  headers?: Record<string, string>;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  omitBackground?: boolean;
}

export interface ElementSelector {
  selector: string;
  text?: string;
  timeout?: number;
}

export interface ExtractedContent {
  text: string;
  html: string;
  links: Array<{
    url: string;
    text: string;
  }>;
  images: Array<{
    src: string;
    alt?: string;
  }>;
  title?: string;
  metadata?: Record<string, string>;
}

export interface ClickOptions {
  timeout?: number;
  force?: boolean;
  waitForNavigation?: boolean;
}

export interface TypeOptions {
  delay?: number;
  timeout?: number;
  clear?: boolean;
}

/**
 * Interface for browser automation services
 */
export abstract class IBrowserService extends Service {
  static override readonly serviceType = ServiceType.BROWSER;

  public readonly capabilityDescription = 'Web browser automation and scraping capabilities';

  /**
   * Navigate to a URL
   * @param url - URL to navigate to
   * @param options - Navigation options
   * @returns Promise resolving when navigation completes
   */
  abstract navigate(url: string, options?: BrowserNavigationOptions): Promise<void>;

  /**
   * Take a screenshot of the current page
   * @param options - Screenshot options
   * @returns Promise resolving to screenshot buffer
   */
  abstract screenshot(options?: ScreenshotOptions): Promise<Buffer>;

  /**
   * Extract text and content from the current page
   * @param selector - Optional CSS selector to extract from specific element
   * @returns Promise resolving to extracted content
   */
  abstract extractContent(selector?: string): Promise<ExtractedContent>;

  /**
   * Click on an element
   * @param selector - CSS selector or element selector
   * @param options - Click options
   * @returns Promise resolving when click completes
   */
  abstract click(selector: string | ElementSelector, options?: ClickOptions): Promise<void>;

  /**
   * Type text into an input field
   * @param selector - CSS selector for input field
   * @param text - Text to type
   * @param options - Typing options
   * @returns Promise resolving when typing completes
   */
  abstract type(selector: string, text: string, options?: TypeOptions): Promise<void>;

  /**
   * Wait for an element to appear
   * @param selector - CSS selector or element selector
   * @returns Promise resolving when element is found
   */
  abstract waitForElement(selector: string | ElementSelector): Promise<void>;

  /**
   * Evaluate JavaScript in the browser context
   * @param script - JavaScript code to evaluate
   * @param args - Arguments to pass to the script
   * @returns Promise resolving to evaluation result
   */
  abstract evaluate<T = any>(script: string, ...args: any[]): Promise<T>;

  /**
   * Get the current page URL
   * @returns Promise resolving to current URL
   */
  abstract getCurrentUrl(): Promise<string>;

  /**
   * Go back in browser history
   * @returns Promise resolving when navigation completes
   */
  abstract goBack(): Promise<void>;

  /**
   * Go forward in browser history
   * @returns Promise resolving when navigation completes
   */
  abstract goForward(): Promise<void>;

  /**
   * Refresh the current page
   * @returns Promise resolving when refresh completes
   */
  abstract refresh(): Promise<void>;
}
