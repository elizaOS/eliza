import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type { JsonObject, MinecraftBridgeRequestType } from "../protocol.js";
import {
  type MinecraftSession,
  type MinecraftWorldState,
  minecraftWorldStateSchema,
} from "../types.js";
import { MinecraftProcessManager } from "./process-manager.js";
import { MinecraftWebSocketClient } from "./websocket-client.js";

export const MINECRAFT_SERVICE_TYPE = "minecraft" as const;

export class Session implements MinecraftSession {
  constructor(
    public botId: string,
    public createdAt: Date = new Date(),
  ) {}
}

export class MinecraftService extends Service {
  static serviceType = MINECRAFT_SERVICE_TYPE;
  capabilityDescription = "Minecraft automation service (Mineflayer bridge)";

  private session: Session | null = null;
  private processManager: MinecraftProcessManager;
  private client: MinecraftWebSocketClient;
  private isInitialized = false;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) throw new Error("MinecraftService requires a runtime");
    this.runtime = runtime;
    const portSetting = runtime.getSetting("MC_SERVER_PORT");
    const port =
      typeof portSetting === "number"
        ? portSetting
        : Number(portSetting ?? 3457);
    const serverPort = Number.isFinite(port) ? port : 3457;
    this.processManager = new MinecraftProcessManager(serverPort);
    this.client = new MinecraftWebSocketClient(
      this.processManager.getServerUrl(),
    );
  }

  static async start(runtime: IAgentRuntime): Promise<MinecraftService> {
    const service = new MinecraftService(runtime);
    try {
      await service.processManager.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to start Mineflayer server process: ${msg}`);
    }
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    await this.client.connect();
    await this.waitForReady();
    this.isInitialized = true;
  }

  async stop(): Promise<void> {
    if (this.session) {
      try {
        await this.destroyBot(this.session.botId);
      } catch {}
    }
    this.client.disconnect();
    await this.processManager.stop();
    this.isInitialized = false;
  }

  getClient(): MinecraftWebSocketClient {
    if (!this.isInitialized) {
      throw new Error("Minecraft service not initialized");
    }
    return this.client;
  }

  getCurrentSession(): Session | null {
    return this.session;
  }

  async createBot(overrides?: JsonObject): Promise<Session> {
    if (!this.isInitialized) {
      throw new Error("Minecraft service not initialized");
    }
    const resp = await this.client.sendMessage(
      "createBot",
      undefined,
      overrides ?? {},
    );
    const botId = typeof resp.data?.botId === "string" ? resp.data.botId : null;
    if (!botId) {
      throw new Error("Bridge did not return botId");
    }
    this.session = new Session(botId);
    return this.session;
  }

  async destroyBot(botId: string): Promise<void> {
    if (!this.isInitialized) return;
    await this.client.sendMessage("destroyBot", botId, {});
    if (this.session?.botId === botId) {
      this.session = null;
    }
  }

  async ensureBot(): Promise<Session> {
    if (this.session) return this.session;
    return await this.createBot();
  }

  async chat(message: string): Promise<void> {
    const session = await this.ensureBot();
    await this.client.sendMessage("chat", session.botId, { message });
  }

  async request(
    type: MinecraftBridgeRequestType,
    data: JsonObject,
  ): Promise<JsonObject> {
    const session = await this.ensureBot();
    const resp = await this.client.sendMessage(type, session.botId, data);
    return resp.data ?? {};
  }

  async getWorldState(): Promise<MinecraftWorldState> {
    if (!this.session) {
      return { connected: false };
    }
    const resp = await this.client.sendMessage(
      "getState",
      this.session.botId,
      {},
    );
    return minecraftWorldStateSchema.parse(resp.data ?? { connected: false });
  }

  private async waitForReady(
    maxAttempts: number = 20,
    delayMs: number = 500,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        if (await this.client.health()) return;
      } catch {}
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error("Mineflayer bridge server did not become ready");
  }
}
