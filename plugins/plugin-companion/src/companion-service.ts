/**
 * COMPANION_SERVICE — long-lived WebSocket client to an ESP32 companion device.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { CompanionClient, CompanionClientError, type CompanionSnapshot } from "./companion-client";
import { COMPANION_SERVICE_TYPE, type CompanionMood, normalizeMood } from "./protocol";

declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    COMPANION_SERVICE: "COMPANION_SERVICE";
  }
}

export class CompanionService extends Service {
  static serviceType = COMPANION_SERVICE_TYPE;

  readonly client: CompanionClient;

  constructor(runtime?: IAgentRuntime, client: CompanionClient = new CompanionClient()) {
    super(runtime);
    this.client = client;
  }

  static async start(runtime: IAgentRuntime): Promise<CompanionService> {
    const service = new CompanionService(runtime);
    const url = readSetting(runtime, "COMPANION_WS_URL");
    const token = readSetting(runtime, "COMPANION_PAIRING_TOKEN");
    if (url && token) {
      await service.connect(url, token);
    } else {
      logger.info(
        "[plugin-companion] COMPANION_SERVICE started (idle — set COMPANION_WS_URL and COMPANION_PAIRING_TOKEN to connect)"
      );
    }
    return service;
  }

  get capabilityDescription(): string {
    return "ESP32 companion device bridge (mood, status, touch events).";
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }

  async connect(url: string, token: string): Promise<CompanionSnapshot> {
    const snapshot = await this.client.connect(url, token);
    logger.info(
      `[plugin-companion] connected deviceId=${snapshot.deviceId} firmware=${snapshot.firmware ?? "unknown"}`
    );
    return snapshot;
  }

  getSnapshot(): CompanionSnapshot {
    return this.client.getSnapshot();
  }

  async setMood(rawMood: string): Promise<CompanionMood> {
    const mood = normalizeMood(rawMood);
    if (!mood) {
      throw new CompanionClientError(`invalid mood: ${rawMood}`, "invalid-mood");
    }
    return this.client.setMood(mood);
  }

  async getStatus(): Promise<CompanionSnapshot> {
    if (!this.client.isConnected()) {
      throw new CompanionClientError("Companion is not connected", "not-connected");
    }
    return this.client.getStatus();
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }
}

function readSetting(runtime: IAgentRuntime, key: string): string | null {
  const value = runtime.getSetting?.(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
