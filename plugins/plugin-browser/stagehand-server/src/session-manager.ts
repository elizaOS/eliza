import { Stagehand } from "@browserbasehq/stagehand";
import type { Logger } from "./logger.js";
import type { PlaywrightInstaller } from "./playwright-installer.js";
import { ObservabilityManager } from "./observability-manager.js";

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  isActive: boolean;
}

// Stagehand v3 uses its own CDP-based types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StagehandPage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StagehandContext = any;

export interface BrowserSession {
  id: string;
  clientId: string;
  stagehand: Stagehand;
  observability: ObservabilityManager;
  createdAt: Date;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pendingDialogs: any[];
  pendingDownloads: Array<{ path: string; suggestedFilename: string; url: string }>;
}

export class SessionManager {
  private sessions: Map<string, BrowserSession> = new Map();
  private maxSessionsPerClient = 3;

  constructor(
    private logger: Logger,
    private playwrightInstaller: PlaywrightInstaller,
  ) {}

  async createSession(
    sessionId: string,
    clientId: string,
  ): Promise<BrowserSession> {
    if (!this.playwrightInstaller.isReady()) {
      try {
        await this.playwrightInstaller.ensurePlaywrightInstalled();
      } catch (error) {
        this.logger.error("Failed to install Playwright:", error);
        throw new Error(
          "Playwright is not installed and installation failed. Please install Playwright manually.",
        );
      }
    }

    const clientSessions = this.getClientSessions(clientId);
    if (clientSessions.length >= this.maxSessionsPerClient) {
      // Remove oldest session
      const oldestSession = clientSessions.sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
      if (oldestSession) {
        await this.destroySession(oldestSession.id);
      }
    }

    this.logger.info(`Creating session ${sessionId} for client ${clientId}`);

    const env = process.env.BROWSERBASE_API_KEY ? "BROWSERBASE" : "LOCAL";

    interface StagehandConfig {
      env: "BROWSERBASE" | "LOCAL";
      headless: boolean;
      apiKey?: string;
      projectId?: string;
      browserbaseSessionCreateParams?: {
        projectId: string;
        browserSettings: {
          blockAds: boolean;
          viewport: { width: number; height: number };
        };
      };
      modelName?: string;
      modelBaseUrl?: string;
      openaiApiKey?: string;
      anthropicApiKey?: string;
    }

    const config: StagehandConfig = {
      env,
      headless: process.env.BROWSER_HEADLESS !== "false",
    };

    if (process.env.BROWSERBASE_API_KEY) {
      config.apiKey = process.env.BROWSERBASE_API_KEY;
      config.projectId = process.env.BROWSERBASE_PROJECT_ID;
      config.browserbaseSessionCreateParams = {
        projectId: process.env.BROWSERBASE_PROJECT_ID!,
        browserSettings: {
          blockAds: true,
          viewport: {
            width: 1280,
            height: 720,
          },
        },
      };
    }

    if (process.env.OLLAMA_BASE_URL) {
      config.modelName = process.env.OLLAMA_MODEL || "llama3.2-vision";
      config.modelBaseUrl = process.env.OLLAMA_BASE_URL;
    } else if (process.env.OPENAI_API_KEY) {
      config.modelName = "gpt-5";
      config.openaiApiKey = process.env.OPENAI_API_KEY;
    } else if (process.env.ANTHROPIC_API_KEY) {
      config.modelName = "claude-3-5-sonnet-latest";
      config.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    }

    // Stagehand v3 - exposes context.activePage() and context.pages()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stagehand = new Stagehand(config as any);
    await stagehand.init();

    // Create observability manager
    const observability = new ObservabilityManager();

    const session: BrowserSession = {
      id: sessionId,
      clientId,
      stagehand,
      observability,
      createdAt: new Date(),
      pendingDialogs: [],
      pendingDownloads: [],
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get the active page from session, with optional tab index for multi-tab support.
   * Stagehand v3 exposes context.pages() for multi-tab and context.activePage() for current.
   */
  getPage(session: BrowserSession, tabIndex?: number): StagehandPage {
    const context = session.stagehand.context;
    if (tabIndex !== undefined) {
      const pages = context.pages();
      if (tabIndex >= 0 && tabIndex < pages.length) {
        return pages[tabIndex];
      }
    }
    return context.activePage();
  }

  /**
   * Get browser context from session (Stagehand v3 V3Context).
   */
  getContext(session: BrowserSession): StagehandContext {
    return session.stagehand.context;
  }

  /**
   * List all open tabs in the session.
   */
  async listTabs(session: BrowserSession): Promise<TabInfo[]> {
    const context = session.stagehand.context;
    const pages = context.pages();
    const activePage = context.activePage();

    const tabs: TabInfo[] = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      // V3 Page has evaluate() for getting title
      let title = "Untitled";
      let url = "about:blank";
      try {
        title = await page.evaluate(() => document.title);
        url = await page.evaluate(() => window.location.href);
      } catch {
        // Page might not be ready
      }
      tabs.push({
        id: i,
        url,
        title,
        isActive: page === activePage,
      });
    }
    return tabs;
  }

  /**
   * Create a new tab and optionally navigate to URL.
   */
  async createTab(session: BrowserSession, url?: string): Promise<{ tabId: number; page: StagehandPage }> {
    const context = session.stagehand.context;
    const newPage = await context.newPage(url);

    const pages = context.pages();
    const tabId = pages.indexOf(newPage);

    return { tabId, page: newPage };
  }

  /**
   * Switch to a specific tab by index.
   */
  async switchTab(session: BrowserSession, tabIndex: number): Promise<StagehandPage> {
    const context = session.stagehand.context;
    const pages = context.pages();

    if (tabIndex < 0 || tabIndex >= pages.length) {
      throw new Error(`Tab index ${tabIndex} out of range (0-${pages.length - 1})`);
    }

    const page = pages[tabIndex];
    context.setActivePage(page);

    return page;
  }

  /**
   * Close a specific tab.
   */
  async closeTab(session: BrowserSession, tabIndex: number): Promise<void> {
    const context = session.stagehand.context;
    const pages = context.pages();

    if (tabIndex < 0 || tabIndex >= pages.length) {
      throw new Error(`Tab index ${tabIndex} out of range`);
    }

    // V3 Page doesn't have close() directly, need to use CDP or context
    // For now, we can use evaluate to close
    const page = pages[tabIndex];
    try {
      await page.evaluate(() => window.close());
    } catch {
      // Page might already be closed
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.logger.info(`Destroying session ${sessionId}`);
      try {
        // Clear observability
        session.observability.clearAll();

        // Dismiss any pending dialogs
        for (const dialog of session.pendingDialogs) {
          try {
            await dialog.dismiss();
          } catch {
            // Dialog may already be handled
          }
        }

        await session.stagehand.close();
      } catch (error) {
        this.logger.error(`Error closing session ${sessionId}:`, error);
      }
      this.sessions.delete(sessionId);
    }
  }

  getClientSessions(clientId: string): BrowserSession[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.clientId === clientId,
    );
  }

  async cleanupClientSessions(clientId: string): Promise<void> {
    const sessions = this.getClientSessions(clientId);
    for (const session of sessions) {
      await this.destroySession(session.id);
    }
  }

  async cleanup(): Promise<void> {
    this.logger.info("Cleaning up all sessions...");
    for (const sessionId of this.sessions.keys()) {
      await this.destroySession(sessionId);
    }
  }
}
