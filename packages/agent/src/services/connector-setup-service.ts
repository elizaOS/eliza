/**
 * ConnectorSetupService — a runtime service that exposes shared
 * connector setup utilities to plugins.
 *
 * Plugins access this during route handlers via:
 *   `runtime.getService("connector-setup")`
 *
 * Provides config persistence, escalation channel registration,
 * owner contact management, workspace dir, and WebSocket broadcasting
 * so connector plugins don't need to import agent internals.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  type OwnerContactUpdate,
  setOwnerContact,
} from "../api/owner-contact-helpers.ts";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import { registerEscalationChannel } from "./escalation.ts";

export type { OwnerContactUpdate };

export interface ConnectorSetupServiceInstance extends Service {
  /** Load the current Eliza config from disk. */
  getConfig(): Record<string, unknown>;
  /** Save the Eliza config to disk. */
  persistConfig(config: Record<string, unknown>): void;
  /** Load + return; caller mutates; then persistConfig(). Convenience wrapper. */
  updateConfig(updater: (config: Record<string, unknown>) => void): void;
  /** Register a channel name for escalation delivery (e.g. "telegram"). */
  registerEscalationChannel(channelName: string): boolean;
  /** Set/update an owner contact entry in the config. */
  setOwnerContact(update: OwnerContactUpdate): boolean;
  /** Resolve the default agent workspace directory. */
  getWorkspaceDir(): string;
  /** Broadcast a WebSocket message to all connected clients. */
  broadcastWs(data: object): void;
  /** Set the WebSocket broadcast function (called by the server during startup). */
  setBroadcastWs(fn: ((data: object) => void) | null): void;
}

export class ConnectorSetupService extends Service {
  static serviceType = "connector-setup";
  capabilityDescription = "Shared connector setup utilities for plugins";

  private broadcastWsFn: ((data: object) => void) | null = null;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const instance = new ConnectorSetupService(runtime);
    logger.debug("[connector-setup] Service started");
    return instance;
  }

  async stop(): Promise<void> {
    this.broadcastWsFn = null;
  }

  getConfig(): Record<string, unknown> {
    return loadElizaConfig() as Record<string, unknown>;
  }

  persistConfig(config: Record<string, unknown>): void {
    saveElizaConfig(config as Parameters<typeof saveElizaConfig>[0]);
  }

  updateConfig(updater: (config: Record<string, unknown>) => void): void {
    const config = this.getConfig();
    updater(config);
    this.persistConfig(config);
  }

  registerEscalationChannel(channelName: string): boolean {
    return registerEscalationChannel(channelName);
  }

  setOwnerContact(update: OwnerContactUpdate): boolean {
    const config = this.getConfig();
    const modified = setOwnerContact(
      config as Parameters<typeof setOwnerContact>[0],
      update,
    );
    if (modified) {
      this.persistConfig(config);
    }
    return modified;
  }

  getWorkspaceDir(): string {
    return resolveDefaultAgentWorkspaceDir();
  }

  broadcastWs(data: object): void {
    this.broadcastWsFn?.(data);
  }

  setBroadcastWs(fn: ((data: object) => void) | null): void {
    this.broadcastWsFn = fn;
  }
}
