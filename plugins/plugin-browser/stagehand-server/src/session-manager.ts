import { Stagehand } from "@browserbasehq/stagehand";
import type { Logger } from "./logger.js";
import type { PlaywrightInstaller } from "./playwright-installer.js";

export interface BrowserSession {
  id: string;
  clientId: string;
  stagehand: Stagehand;
  createdAt: Date;
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

    // Cast to any to bypass strict model name typing - Stagehand accepts these models at runtime
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stagehand = new Stagehand(config as any);
    await stagehand.init();

    const session: BrowserSession = {
      id: sessionId,
      clientId,
      stagehand,
      createdAt: new Date(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.logger.info(`Destroying session ${sessionId}`);
      try {
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
