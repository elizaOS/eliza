/**
 * Top-level orchestrator for cloud integration.
 * Manages client, proxy, backup scheduler, and connection monitor lifecycle.
 */

import { logger } from "@elizaos/core";
import type { CloudConfig } from "../config/types.milady";
import { BackupScheduler } from "./backup";
import { normalizeCloudSiteUrl } from "./base-url";
import { ElizaCloudClient } from "./bridge-client";
import { CloudRuntimeProxy } from "./cloud-proxy";
import { ConnectionMonitor } from "./reconnect";
import { validateCloudBaseUrl } from "./validate-url";

export type CloudConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface CloudManagerCallbacks {
  onStatusChange?: (status: CloudConnectionStatus) => void;
}

export class CloudManager {
  private client: ElizaCloudClient | null = null;
  private proxy: CloudRuntimeProxy | null = null;
  private backupScheduler: BackupScheduler | null = null;
  private connectionMonitor: ConnectionMonitor | null = null;
  private status: CloudConnectionStatus = "disconnected";
  private activeAgentId: string | null = null;

  constructor(
    private cloudConfig: CloudConfig,
    private callbacks: CloudManagerCallbacks = {},
  ) {}

  async init(): Promise<void> {
    const rawUrl = normalizeCloudSiteUrl(this.cloudConfig.baseUrl);
    const apiKey = this.cloudConfig.apiKey;
    if (!apiKey)
      throw new Error(
        "Cloud API key is not configured. Run cloud login first.",
      );

    const urlError = await validateCloudBaseUrl(rawUrl);
    if (urlError) {
      throw new Error(urlError);
    }

    const siteUrl = normalizeCloudSiteUrl(rawUrl);
    this.client = new ElizaCloudClient(siteUrl, apiKey);
    logger.info(`[cloud-manager] Client initialised (baseUrl=${siteUrl})`);
  }

  async connect(agentId: string): Promise<CloudRuntimeProxy> {
    if (!this.client) await this.init();
    if (!this.client) throw new Error("Cloud client failed to initialise");

    this.setStatus("connecting");
    this.activeAgentId = agentId;

    try {
      await this.client.provision(agentId);
      const agent = await this.client.getAgent(agentId);

      this.proxy = new CloudRuntimeProxy(this.client, agentId, agent.agentName);

      this.backupScheduler = new BackupScheduler(
        this.client,
        agentId,
        this.cloudConfig.backup?.autoBackupIntervalMs ?? 60_000,
      );
      this.backupScheduler.start();

      this.connectionMonitor = new ConnectionMonitor(
        this.client,
        agentId,
        {
          onDisconnect: () => this.setStatus("reconnecting"),
          onReconnect: () => this.setStatus("connected"),
          onStatusChange: (s) => {
            if (s === "connected") this.setStatus("connected");
            else if (s === "reconnecting") this.setStatus("reconnecting");
            else this.setStatus("error");
          },
        },
        this.cloudConfig.bridge?.heartbeatIntervalMs ?? 30_000,
      );
      this.connectionMonitor.start();

      this.setStatus("connected");
      logger.info(
        `[cloud-manager] Connected to cloud agent (agentId=${agentId}, agentName=${agent.agentName})`,
      );
      return this.proxy;
    } catch (err) {
      this.setStatus("error");
      if (this.backupScheduler) {
        this.backupScheduler.stop();
        this.backupScheduler = null;
      }
      if (this.connectionMonitor) {
        this.connectionMonitor.stop();
        this.connectionMonitor = null;
      }
      this.proxy = null;
      this.activeAgentId = null;
      this.setStatus("disconnected");
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.backupScheduler) {
      await this.backupScheduler.finalSnapshot();
      this.backupScheduler.stop();
      this.backupScheduler = null;
    }
    if (this.connectionMonitor) {
      this.connectionMonitor.stop();
      this.connectionMonitor = null;
    }
    this.proxy = null;
    this.activeAgentId = null;
    this.setStatus("disconnected");
  }

  getProxy(): CloudRuntimeProxy | null {
    return this.proxy;
  }
  getClient(): ElizaCloudClient | null {
    return this.client;
  }
  getActiveAgentId(): string | null {
    return this.activeAgentId;
  }
  getStatus(): CloudConnectionStatus {
    return this.status;
  }
  isEnabled(): boolean {
    return Boolean(this.cloudConfig.enabled && this.cloudConfig.apiKey);
  }

  private setStatus(status: CloudConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }
}
