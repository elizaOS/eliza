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
import {
  formatVaultRef,
  isVaultRef,
  parseVaultRef,
} from "../runtime/operations/vault-bridge.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import {
  CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPE,
  type ConnectorCredentialPutSecretParams,
  type ConnectorCredentialStoreService,
} from "./connector-credential-store.ts";
import { registerEscalationChannel } from "./escalation.ts";

export type { OwnerContactUpdate };

export interface ConnectorSetupServiceInstance extends Service {
  /** Load the current Eliza config from disk. */
  getConfig(): Record<string, unknown>;
  /** Save the Eliza config to disk. */
  persistConfig(config: Record<string, unknown>): void;
  /** Load + return; caller mutates; then persistConfig(). Convenience wrapper. */
  updateConfig(updater: (config: Record<string, unknown>) => void): void;
  /**
   * Persist connector credential material outside eliza.json when a durable
   * encrypted store is available. Returns a `vault://` config sentinel, or
   * null on platforms that still require the mode-0600 config fallback.
   */
  persistConnectorCredential(
    input: Omit<ConnectorCredentialPutSecretParams, "agentId">,
  ): Promise<string | null>;
  /** Remove a previously persisted `vault://` connector credential. */
  removeConnectorCredentialReference(reference: string): Promise<boolean>;
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

  async persistConnectorCredential(
    input: Omit<ConnectorCredentialPutSecretParams, "agentId">,
  ): Promise<string | null> {
    const store = this.runtime.getService<ConnectorCredentialStoreService>(
      CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPE,
    );
    if (!store || typeof store.putSecret !== "function") {
      logger.warn(
        `[connector-setup] encrypted credential store unavailable for ${input.provider}/${input.credentialType}; retaining the mode-0600 config fallback`,
      );
      return null;
    }
    try {
      const vaultRef = await store.putSecret({
        ...input,
        agentId: this.runtime.agentId,
      });
      return formatVaultRef(vaultRef);
    } catch {
      // Never stringify the storage error here: native/keychain failures can
      // contain local paths. The fallback is access-controlled but remains
      // visible in the Vault security inventory as a migration limitation.
      logger.warn(
        `[connector-setup] encrypted credential write failed for ${input.provider}/${input.credentialType}; retaining the mode-0600 config fallback`,
      );
      return null;
    }
  }

  async removeConnectorCredentialReference(
    reference: string,
  ): Promise<boolean> {
    if (!isVaultRef(reference)) return false;
    const vaultRef = parseVaultRef(reference);
    if (!vaultRef) return false;
    const store = this.runtime.getService<ConnectorCredentialStoreService>(
      CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPE,
    );
    if (!store || typeof store.remove !== "function") return false;
    try {
      await store.remove(vaultRef);
      return true;
    } catch {
      logger.warn(
        "[connector-setup] encrypted credential removal failed; the orphaned key remains manageable in Vault",
      );
      return false;
    }
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
