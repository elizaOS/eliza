import { type IAgentRuntime, logger, Service, ServiceType } from "@elizaos/core";
import type { BrowserSession } from "../types.js";
import { BrowserProcessManager } from "./process-manager.js";
import { BrowserWebSocketClient } from "./websocket-client.js";

export class Session implements BrowserSession {
  constructor(
    public id: string,
    public createdAt: Date = new Date()
  ) {}
}

export class BrowserService extends Service {
  static serviceType = ServiceType.BROWSER;
  capabilityDescription = "Browser automation service";

  private sessions = new Map<string, Session>();
  private currentSessionId: string | null = null;
  private processManager: BrowserProcessManager;
  private client: BrowserWebSocketClient;
  private isInitialized = false;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      throw new Error("BrowserService requires a runtime");
    }
    this.runtime = runtime;
    const portSetting = runtime.getSetting("BROWSER_SERVER_PORT");
    const port = typeof portSetting === "string" ? parseInt(portSetting, 10) : 3456;
    this.processManager = new BrowserProcessManager(port);
    this.client = new BrowserWebSocketClient(`ws://localhost:${port}`);
  }

  static async start(runtime: IAgentRuntime): Promise<BrowserService> {
    logger.info("Starting browser automation service");
    try {
      const service = new BrowserService(runtime);

      logger.info("Starting browser server process...");
      try {
        await service.processManager.start();
        logger.info("Browser server started successfully");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to start browser server: ${errorMessage}`);
        logger.warn("Browser plugin will be available but automation will not work");
        logger.warn("To fix this, run: cd packages/plugin-browser && npm run build");
      }

      logger.info("Initializing WebSocket client...");
      await service.initialize();

      return service;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to start browser service: ${errorMessage}`);
      throw error;
    }
  }

  static async stopRuntime(runtime: IAgentRuntime): Promise<void> {
    logger.info("Stopping browser automation service");
    const service = runtime.getService<BrowserService>(BrowserService.serviceType);
    if (!service) {
      throw new Error("Browser service not found");
    }
    await service.stop();
  }

  async stop(): Promise<void> {
    logger.info("Cleaning up browser sessions");

    for (const sessionId of this.sessions.keys()) {
      await this.destroySession(sessionId);
    }

    this.client.disconnect();
    await this.processManager.stop();
    this.isInitialized = false;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      if (!this.processManager.isServerRunning()) {
        logger.warn("Browser server is not running, attempting to start...");
        await this.processManager.start();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      logger.info("Connecting to browser server...");
      await this.client.connect();

      await this.waitForReady();

      this.isInitialized = true;
      logger.info("Browser service initialized successfully");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to initialize browser service: ${errorMessage}`);
      throw error;
    }
  }

  async createSession(sessionId: string): Promise<Session> {
    if (!this.isInitialized) {
      throw new Error("Browser service not initialized");
    }

    const response = await this.client.sendMessage("createSession", {});
    const serverSessionId = (response.data as { sessionId?: string })?.sessionId;
    if (!serverSessionId) {
      throw new Error("Failed to create session on server");
    }

    const session = new Session(serverSessionId);
    this.sessions.set(sessionId, session);
    this.currentSessionId = sessionId;

    return session;
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId);
  }

  async getCurrentSession(): Promise<Session | undefined> {
    if (!this.currentSessionId) {
      return undefined;
    }
    return this.sessions.get(this.currentSessionId);
  }

  async getOrCreateSession(): Promise<Session> {
    const currentSession = await this.getCurrentSession();
    if (currentSession) {
      return currentSession;
    }

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    return this.createSession(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await this.client.sendMessage("destroySession", { sessionId: session.id });
      this.sessions.delete(sessionId);
      if (this.currentSessionId === sessionId) {
        this.currentSessionId = null;
      }
    }
  }

  getClient(): BrowserWebSocketClient {
    if (!this.isInitialized) {
      throw new Error("Browser service not initialized");
    }
    return this.client;
  }

  private async waitForReady(maxAttempts = 60, delayMs = 3000): Promise<void> {
    logger.info("Waiting for browser server to be ready...");

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const isHealthy = await this.client.health();
        if (isHealthy) {
          logger.info("Browser server is ready");
          return;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug(`Health check attempt ${attempt}/${maxAttempts} failed: ${errorMessage}`);
      }

      if (attempt < maxAttempts) {
        logger.info(
          `Server not ready yet, retrying in ${delayMs / 1000}s... (attempt ${attempt}/${maxAttempts})`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new Error(`Browser server did not become ready after ${maxAttempts} attempts`);
  }
}
