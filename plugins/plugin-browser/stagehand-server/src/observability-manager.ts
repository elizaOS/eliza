import type { Page, ConsoleMessage as PlaywrightConsoleMessage, Request, Response } from "playwright";

export interface ConsoleMessage {
  type: string;
  text: string;
  timestamp: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

export interface PageError {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
}

export interface NetworkRequest {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
  responseHeaders?: Record<string, string>;
  timing?: {
    startTime: number;
    endTime?: number;
    duration?: number;
  };
}

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;

/**
 * Manages observability data (console logs, errors, network requests) for a browser session.
 * Attaches to Playwright page events and buffers the data for retrieval.
 */
export class ObservabilityManager {
  private consoleLogs: ConsoleMessage[] = [];
  private pageErrors: PageError[] = [];
  private networkRequests: NetworkRequest[] = [];
  private requestIds: WeakMap<Request, string> = new WeakMap();
  private nextRequestId = 0;
  private attachedPages: WeakSet<Page> = new WeakSet();

  /**
   * Attach event listeners to a Playwright page to capture console, errors, and network.
   */
  attachToPage(page: Page): void {
    if (this.attachedPages.has(page)) {
      return;
    }
    this.attachedPages.add(page);

    // Console messages
    page.on("console", (msg: PlaywrightConsoleMessage) => {
      const entry: ConsoleMessage = {
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        location: msg.location(),
      };
      this.consoleLogs.push(entry);
      if (this.consoleLogs.length > MAX_CONSOLE_MESSAGES) {
        this.consoleLogs.shift();
      }
    });

    // Page errors (uncaught exceptions)
    page.on("pageerror", (err: Error) => {
      this.pageErrors.push({
        message: err?.message ? String(err.message) : String(err),
        name: err?.name ? String(err.name) : undefined,
        stack: err?.stack ? String(err.stack) : undefined,
        timestamp: new Date().toISOString(),
      });
      if (this.pageErrors.length > MAX_PAGE_ERRORS) {
        this.pageErrors.shift();
      }
    });

    // Network requests
    page.on("request", (req: Request) => {
      this.nextRequestId += 1;
      const id = `r${this.nextRequestId}`;
      this.requestIds.set(req, id);
      this.networkRequests.push({
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        timing: {
          startTime: Date.now(),
        },
      });
      if (this.networkRequests.length > MAX_NETWORK_REQUESTS) {
        this.networkRequests.shift();
      }
    });

    // Network responses
    page.on("response", (resp: Response) => {
      const req = resp.request();
      const id = this.requestIds.get(req);
      if (!id) return;

      const record = this.findRequestById(id);
      if (record) {
        record.status = resp.status();
        record.ok = resp.ok();
        record.responseHeaders = resp.headers();
        if (record.timing) {
          record.timing.endTime = Date.now();
          record.timing.duration = record.timing.endTime - record.timing.startTime;
        }
      }
    });

    // Request failures
    page.on("requestfailed", (req: Request) => {
      const id = this.requestIds.get(req);
      if (!id) return;

      const record = this.findRequestById(id);
      if (record) {
        record.failureText = req.failure()?.errorText;
        record.ok = false;
        if (record.timing) {
          record.timing.endTime = Date.now();
          record.timing.duration = record.timing.endTime - record.timing.startTime;
        }
      }
    });

    // Clean up on page close
    page.on("close", () => {
      this.attachedPages.delete(page);
    });
  }

  private findRequestById(id: string): NetworkRequest | undefined {
    for (let i = this.networkRequests.length - 1; i >= 0; i--) {
      if (this.networkRequests[i]?.id === id) {
        return this.networkRequests[i];
      }
    }
    return undefined;
  }

  /**
   * Get console messages, optionally filtered by minimum level.
   */
  getConsoleMessages(level?: string): ConsoleMessage[] {
    if (!level) {
      return [...this.consoleLogs];
    }

    const minPriority = this.consolePriority(level);
    return this.consoleLogs.filter(
      (msg) => this.consolePriority(msg.type) >= minPriority
    );
  }

  private consolePriority(level: string): number {
    switch (level.toLowerCase()) {
      case "error":
        return 3;
      case "warning":
      case "warn":
        return 2;
      case "info":
      case "log":
        return 1;
      case "debug":
        return 0;
      default:
        return 1;
    }
  }

  /**
   * Get page errors, optionally clearing the buffer.
   */
  getPageErrors(clear = false): PageError[] {
    const errors = [...this.pageErrors];
    if (clear) {
      this.pageErrors = [];
    }
    return errors;
  }

  /**
   * Get network requests, optionally filtered by URL pattern and/or cleared.
   */
  getNetworkRequests(filter?: string, clear = false): NetworkRequest[] {
    let requests = [...this.networkRequests];
    
    if (filter) {
      const filterLower = filter.toLowerCase();
      requests = requests.filter((r) =>
        r.url.toLowerCase().includes(filterLower)
      );
    }

    if (clear) {
      this.networkRequests = [];
      this.requestIds = new WeakMap();
    }

    return requests;
  }

  /**
   * Clear all captured data.
   */
  clearAll(): void {
    this.consoleLogs = [];
    this.pageErrors = [];
    this.networkRequests = [];
    this.requestIds = new WeakMap();
    this.nextRequestId = 0;
  }

  /**
   * Get summary stats about captured data.
   */
  getStats(): {
    consoleCount: number;
    errorCount: number;
    networkCount: number;
  } {
    return {
      consoleCount: this.consoleLogs.length,
      errorCount: this.pageErrors.length,
      networkCount: this.networkRequests.length,
    };
  }
}
