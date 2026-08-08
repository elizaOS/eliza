/**
 * ConnectorCredentialStoreService — the durable secret store behind connector
 * OAuth credential refs. Connector plugins (google-workspace, github, slack,
 * x, microsoft calendar) persist token material through the first runtime
 * service they find under `connector_credential_store` and read it back
 * through the same lookup after a restart; until this service existed nothing
 * registered under that name, so those writes fell through to the core
 * SECRETS service, whose global storage is process-memory only — every
 * connector credential silently died with the process while its vaultRef
 * pointer stayed behind in connector account storage.
 *
 * Backed by the host vault (`AgentHostBridge.sharedVault()`), which encrypts
 * at rest and survives restarts. The boot funnel registers this service only
 * when `hasDurableHostVault()` is true: wrapping the no-op default vault
 * would swallow writes and lose credentials immediately, which is strictly
 * worse than the SECRETS fallback it replaces.
 *
 * The read/write surface mirrors the `ConnectorCredentialStore` contract in
 * `@elizaos/plugin-sql` (`putSecret`/`get`/`has`/`remove`) plus `reveal`,
 * which credential resolvers probe first when reading refs.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type { Vault } from "@elizaos/vault";
import { getAgentHostBridge } from "../runtime/host-bridge.ts";

export const CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPE =
  "connector_credential_store";

const CALLER_FALLBACK = "connector-credential-store";

export interface ConnectorCredentialPutSecretParams {
  vaultRef?: string;
  agentId: string;
  provider: string;
  accountId: string;
  credentialType: string;
  value: string;
  caller?: string;
}

export class ConnectorCredentialStoreService extends Service {
  static serviceType = CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPE;
  capabilityDescription =
    "Durable, encrypted-at-rest storage for connector OAuth credentials referenced by vaultRef";

  private readonly vault: Vault;

  constructor(runtime?: IAgentRuntime, vault?: Vault) {
    super(runtime);
    this.vault = vault ?? getAgentHostBridge().sharedVault();
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const instance = new ConnectorCredentialStoreService(runtime);
    logger.debug("[connector-credential-store] Service started");
    return instance;
  }

  async stop(): Promise<void> {}

  /** Write a credential value under its vaultRef; returns the ref used. */
  async putSecret(params: ConnectorCredentialPutSecretParams): Promise<string> {
    const vaultRef =
      params.vaultRef ?? buildConnectorCredentialVaultRef(params);
    await this.vault.set(vaultRef, params.value, {
      sensitive: true,
      caller: params.caller ?? CALLER_FALLBACK,
    });
    return vaultRef;
  }

  /** Read a credential value by vaultRef; throws on a vault miss. */
  async get(
    vaultRef: string,
    options?: { reveal?: boolean; caller?: string },
  ): Promise<string> {
    if (options?.reveal && this.vault.reveal) {
      return this.vault.reveal(vaultRef, options.caller ?? CALLER_FALLBACK);
    }
    return this.vault.get(vaultRef);
  }

  /** Reveal a sensitive credential value by vaultRef (audit-logged). */
  async reveal(vaultRef: string, caller?: string): Promise<string> {
    if (this.vault.reveal) {
      return this.vault.reveal(vaultRef, caller ?? CALLER_FALLBACK);
    }
    return this.vault.get(vaultRef);
  }

  async has(vaultRef: string): Promise<boolean> {
    return this.vault.has(vaultRef);
  }

  async remove(vaultRef: string): Promise<void> {
    await this.vault.remove(vaultRef);
  }
}

/**
 * Deterministic vault key for a connector credential:
 * `connector.<agentId>.<provider>.<accountId>.<credentialType>`. Mirrors
 * `buildConnectorCredentialVaultRef` in `@elizaos/plugin-sql` so refs written
 * by either side resolve identically.
 */
export function buildConnectorCredentialVaultRef(params: {
  agentId: string;
  provider: string;
  accountId: string;
  credentialType: string;
}): string {
  return [
    "connector",
    normalizeVaultSegment(params.agentId),
    normalizeVaultSegment(params.provider),
    normalizeVaultSegment(params.accountId),
    normalizeVaultSegment(params.credentialType),
  ].join(".");
}

function normalizeVaultSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || "unknown").slice(0, 64);
}
