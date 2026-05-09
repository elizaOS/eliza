import type { UUID } from "@elizaos/core";

export interface ConnectorPasswordManagerReference {
  readonly source: "1password" | "protonpass";
  readonly path: string;
}

export interface ConnectorCredentialVault {
  set(key: string, value: string, opts?: { sensitive?: boolean; caller?: string }): Promise<void>;
  setReference?(key: string, ref: ConnectorPasswordManagerReference): Promise<void>;
  get(key: string): Promise<string>;
  reveal?(key: string, caller?: string): Promise<string>;
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
}

export interface ConnectorCredentialStore {
  putSecret(params: {
    vaultRef?: string;
    agentId: UUID;
    provider: string;
    accountId: UUID;
    credentialType: string;
    value: string;
    caller?: string;
  }): Promise<string>;
  putReference(params: {
    vaultRef?: string;
    agentId: UUID;
    provider: string;
    accountId: UUID;
    credentialType: string;
    reference: ConnectorPasswordManagerReference;
  }): Promise<string>;
  get(vaultRef: string, options?: { reveal?: boolean; caller?: string }): Promise<string>;
  has(vaultRef: string): Promise<boolean>;
  remove(vaultRef: string): Promise<void>;
}

export function buildConnectorCredentialVaultRef(params: {
  agentId: UUID;
  provider: string;
  accountId: UUID;
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

export function createConnectorCredentialStore(
  vault: ConnectorCredentialVault
): ConnectorCredentialStore {
  return {
    async putSecret(params) {
      const vaultRef = params.vaultRef ?? buildConnectorCredentialVaultRef(params);
      await vault.set(vaultRef, params.value, { sensitive: true, caller: params.caller });
      return vaultRef;
    },
    async putReference(params) {
      if (!vault.setReference) {
        throw new Error("Connector credential vault does not support password-manager references");
      }
      const vaultRef = params.vaultRef ?? buildConnectorCredentialVaultRef(params);
      await vault.setReference(vaultRef, params.reference);
      return vaultRef;
    },
    async get(vaultRef, options) {
      if (options?.reveal && vault.reveal) {
        return vault.reveal(vaultRef, options.caller);
      }
      return vault.get(vaultRef);
    },
    async has(vaultRef) {
      return vault.has(vaultRef);
    },
    async remove(vaultRef) {
      await vault.remove(vaultRef);
    },
  };
}

function normalizeVaultSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || "unknown").slice(0, 64);
}
