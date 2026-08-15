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
 * Backed by a vault that encrypts at rest and survives restarts: the host
 * vault (`AgentHostBridge.sharedVault()`) when an embedding host installed a
 * durable bridge, otherwise a state-dir PGlite vault (`createVault()`, rooted
 * at `ELIZA_STATE_DIR`) the service opens itself. The standalone/Cloud image
 * boots with no host bridge (#18080), so without the fallback nothing durable
 * exists there and every connector credential dies with the process. The boot
 * funnel registers this service unconditionally.
 *
 * The state-dir vault is lazy — PGlite opens on the first credential
 * operation, not at boot — and encrypts with the master key from the OS
 * keychain or `ELIZA_VAULT_PASSPHRASE`; a headless host without either fails
 * the write with `MasterKeyUnavailableError` (fail closed, actionable) rather
 * than silently storing tokens that vanish on restart.
 *
 * The read/write surface mirrors the `ConnectorCredentialStore` contract in
 * `@elizaos/plugin-sql` (`putSecret`/`get`/`has`/`remove`) plus `reveal`,
 * which credential resolvers probe first when reading refs.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { createVault, type Vault } from "@elizaos/vault";
import {
  getAgentHostBridge,
  hasDurableHostVault,
} from "../runtime/host-bridge.ts";

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

// One state-dir vault per process: PGlite is single-writer, and multi-agent
// boots construct one service instance per runtime over the same data dir.
let stateDirVault: Vault | null = null;

function durableVault(): Vault {
  if (hasDurableHostVault()) return getAgentHostBridge().sharedVault();
  stateDirVault ??= createVault();
  return stateDirVault;
}

export class ConnectorCredentialStoreService extends Service {
  static serviceType = CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPE;
  capabilityDescription =
    "Durable, encrypted-at-rest storage for connector OAuth credentials referenced by vaultRef";

  private readonly vault: Vault;

  constructor(runtime?: IAgentRuntime, vault?: Vault) {
    super(runtime);
    this.vault = vault ?? durableVault();
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
