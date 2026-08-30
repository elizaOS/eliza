/**
 * Writer/reader parity coverage for connector credential persistence: proves
 * that a credential persisted through `persistConnectorCredentialRefs` is
 * readable by `DefaultGoogleCredentialResolver` after a simulated process
 * restart, for every service name the writer can target. Deterministic
 * harness — the runtime, credential store, vault, and SECRETS services are
 * in-memory fakes shaped like their production counterparts; "restart" means
 * new runtime/service instances sharing only the durable backing maps
 * (connector account storage rows and the vault store), exactly what survives
 * a real process restart.
 */
import {
  type ConnectorAccount,
  type ConnectorAccountStorage,
  getConnectorAccountManager,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES,
  CONNECTOR_VAULT_SERVICE_TYPES,
  persistConnectorCredentialRefs,
} from "./connector-credential-refs.js";
import { DefaultGoogleCredentialResolver } from "./credential-resolver.js";

const AGENT_ID = "6f110aa9-c169-0e10-8a4f-b4cca439be25";
const ACCOUNT_ID = "3a899cd0-170f-4b3e-932e-46ec68119b35";
const TOKENS_JSON = JSON.stringify({
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  token_type: "Bearer",
  scope: "https://www.googleapis.com/auth/gmail.readonly",
  expiry_date: Date.now() + 3_600_000,
});

interface CredentialRefRow {
  credentialType: string;
  vaultRef: string;
  metadata?: Record<string, unknown>;
  expiresAt?: number;
}

/** Durable rows that survive a "restart" — stands in for the SQL adapter. */
interface DurableState {
  accounts: Map<string, ConnectorAccount>;
  credentialRefs: Map<string, CredentialRefRow>;
  vaultEntries: Map<string, string>;
}

function newDurableState(): DurableState {
  return { accounts: new Map(), credentialRefs: new Map(), vaultEntries: new Map() };
}

function connectedAccount(id: string): ConnectorAccount {
  return {
    id,
    provider: "google",
    role: "OWNER",
    purpose: ["messaging"],
    accessGate: "open",
    status: "connected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {},
  } as ConnectorAccount;
}

function createStorage(state: DurableState): ConnectorAccountStorage & {
  setConnectorAccountCredentialRef(params: CredentialRefRow & { accountId: string }): Promise<void>;
  listConnectorAccountCredentialRefs(params: { accountId: string }): Promise<CredentialRefRow[]>;
} {
  return {
    async listAccounts() {
      return [...state.accounts.values()];
    },
    async getAccount(_provider: string, accountId: string) {
      return state.accounts.get(accountId) ?? null;
    },
    async upsertAccount(account: ConnectorAccount) {
      state.accounts.set(account.id, account);
      return account;
    },
    async deleteAccount(_provider: string, accountId: string) {
      state.accounts.delete(accountId);
      return true;
    },
    async setConnectorAccountCredentialRef(params) {
      state.credentialRefs.set(`${params.accountId}:${params.credentialType}`, params);
    },
    async listConnectorAccountCredentialRefs(params) {
      return [...state.credentialRefs.entries()]
        .filter(([key]) => key.startsWith(`${params.accountId}:`))
        .map(([, row]) => row);
    },
  } as ConnectorAccountStorage & {
    setConnectorAccountCredentialRef(
      params: CredentialRefRow & { accountId: string }
    ): Promise<void>;
    listConnectorAccountCredentialRefs(params: { accountId: string }): Promise<CredentialRefRow[]>;
  };
}

/** Store-shaped durable service: the agent's ConnectorCredentialStoreService. */
function createDurableStoreService(vaultEntries: Map<string, string>) {
  return {
    async putSecret(params: { vaultRef?: string; value: string }): Promise<string> {
      if (!params.vaultRef) throw new Error("test store requires an explicit vaultRef");
      vaultEntries.set(params.vaultRef, params.value);
      return params.vaultRef;
    },
    async get(vaultRef: string): Promise<string> {
      const value = vaultEntries.get(vaultRef);
      if (value === undefined) throw new Error(`vault miss: ${vaultRef}`);
      return value;
    },
    async has(vaultRef: string): Promise<boolean> {
      return vaultEntries.has(vaultRef);
    },
    async remove(vaultRef: string): Promise<void> {
      vaultEntries.delete(vaultRef);
    },
  };
}

/** Vault-shaped durable service (`set`/`get`), as registered under vault names. */
function createDurableVaultService(vaultEntries: Map<string, string>) {
  return {
    async set(key: string, value: string): Promise<void> {
      vaultEntries.set(key, value);
    },
    async get(key: string): Promise<string> {
      const value = vaultEntries.get(key);
      if (value === undefined) throw new Error(`vault miss: ${key}`);
      return value;
    },
    async remove(key: string): Promise<void> {
      vaultEntries.delete(key);
    },
  };
}

/**
 * Volatile SECRETS fake shaped like core SecretsService global storage: writes
 * land in an instance-private map that a restart (new instance) wipes.
 */
function createVolatileSecretsService() {
  const entries = new Map<string, string>();
  return {
    entries,
    async setGlobal(key: string, value: string): Promise<boolean> {
      entries.set(key, value);
      return true;
    },
    async get(key: string): Promise<string | null> {
      return entries.get(key) ?? null;
    },
  };
}

function createRuntime(
  storage: ReturnType<typeof createStorage>,
  services: Record<string, unknown>
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getService: (name: string) => services[name] ?? null,
    getSetting: (key: string) =>
      key === "GOOGLE_CLIENT_ID"
        ? "client-id"
        : key === "GOOGLE_CLIENT_SECRET"
          ? "client-secret"
          : undefined,
    adapter: storage,
  } as unknown as IAgentRuntime;
}

async function persistTokens(runtime: IAgentRuntime): Promise<string> {
  const result = await persistConnectorCredentialRefs({
    runtime,
    provider: "google",
    accountIdForRef: ACCOUNT_ID,
    storageAccountId: ACCOUNT_ID,
    caller: "test",
    credentials: [{ credentialType: "oauth.tokens", value: TOKENS_JSON }],
  });
  expect(result.refs).toHaveLength(1);
  return result.refs[0].vaultRef;
}

async function resolveAfterRestart(
  state: DurableState,
  services: Record<string, unknown>
): Promise<{ accessToken?: string | null; refreshToken?: string | null }> {
  const restartedStorage = createStorage(state);
  const restartedRuntime = createRuntime(restartedStorage, services);
  const resolver = new DefaultGoogleCredentialResolver({
    runtime: restartedRuntime,
    storage: restartedStorage,
  });
  const client = await resolver.getAuthClient({
    provider: "google",
    accountId: ACCOUNT_ID,
    scopes: [],
    capabilities: [],
    reason: "round-trip test",
  });
  const credentials = (
    client as { credentials?: { access_token?: string; refresh_token?: string } }
  ).credentials;
  return { accessToken: credentials?.access_token, refreshToken: credentials?.refresh_token };
}

describe("connector credential persist → restart → resolve round-trip", () => {
  it("persists through the durable connector_credential_store ahead of SECRETS and survives a restart", async () => {
    const state = newDurableState();
    state.accounts.set(ACCOUNT_ID, connectedAccount(ACCOUNT_ID));
    const storage = createStorage(state);
    const secrets = createVolatileSecretsService();
    const services: Record<string, unknown> = {
      connector_credential_store: createDurableStoreService(state.vaultEntries),
      SECRETS: secrets,
    };

    const vaultRef = await persistTokens(createRuntime(storage, services));
    expect(vaultRef).toBe(`connector.${AGENT_ID}.google.${ACCOUNT_ID}.oauth_tokens`);
    // Precedence: the durable store wins; nothing lands in volatile SECRETS.
    expect(state.vaultEntries.get(vaultRef)).toBe(TOKENS_JSON);
    expect(secrets.entries.size).toBe(0);

    // Restart: fresh SECRETS instance (memory wiped), same durable state.
    const restarted = await resolveAfterRestart(state, {
      connector_credential_store: createDurableStoreService(state.vaultEntries),
      SECRETS: createVolatileSecretsService(),
    });
    expect(restarted.accessToken).toBe("test-access-token");
    expect(restarted.refreshToken).toBe("test-refresh-token");
  });

  it("reads back a credential written under every writable store and vault service name", async () => {
    for (const serviceType of [
      ...CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES,
      ...CONNECTOR_VAULT_SERVICE_TYPES,
    ]) {
      const state = newDurableState();
      state.accounts.set(ACCOUNT_ID, connectedAccount(ACCOUNT_ID));
      const storage = createStorage(state);
      const durable = (CONNECTOR_VAULT_SERVICE_TYPES as readonly string[]).includes(serviceType)
        ? createDurableVaultService(state.vaultEntries)
        : createDurableStoreService(state.vaultEntries);
      const services: Record<string, unknown> = { [serviceType]: durable };

      await persistTokens(createRuntime(storage, services));
      expect(state.vaultEntries.size).toBe(1);

      const restarted = await resolveAfterRestart(state, {
        [serviceType]: (CONNECTOR_VAULT_SERVICE_TYPES as readonly string[]).includes(serviceType)
          ? createDurableVaultService(state.vaultEntries)
          : createDurableStoreService(state.vaultEntries),
      });
      expect(restarted.accessToken, `service name ${serviceType}`).toBe("test-access-token");
    }
  });

  it("fails closed when only the in-memory SECRETS service exists: no writer, nothing persisted", async () => {
    const state = newDurableState();
    state.accounts.set(ACCOUNT_ID, connectedAccount(ACCOUNT_ID));
    const storage = createStorage(state);
    const secrets = createVolatileSecretsService();

    await expect(persistTokens(createRuntime(storage, { SECRETS: secrets }))).rejects.toThrow(
      /No durable connector credential store or vault writer/
    );
    // SECRETS is not a writer: no token material lands there, no ref is recorded.
    expect(secrets.entries.size).toBe(0);
    expect(state.credentialRefs.size).toBe(0);
  });
});

describe("accountId 'default' resolution", () => {
  function refsRow(): CredentialRefRow & { accountId: string } {
    return {
      accountId: ACCOUNT_ID,
      credentialType: "oauth.tokens",
      vaultRef: `connector.${AGENT_ID}.google.${ACCOUNT_ID}.oauth_tokens`,
    };
  }

  async function resolveDefault(state: DurableState, services: Record<string, unknown>) {
    const storage = createStorage(state);
    const resolver = new DefaultGoogleCredentialResolver({
      runtime: createRuntime(storage, services),
      storage,
    });
    return resolver.getAuthClient({
      provider: "google",
      accountId: "default",
      scopes: [],
      capabilities: [],
      reason: "default-resolution test",
    });
  }

  it("resolves to the sole connected account", async () => {
    const state = newDurableState();
    state.accounts.set(ACCOUNT_ID, connectedAccount(ACCOUNT_ID));
    state.credentialRefs.set(`${ACCOUNT_ID}:oauth.tokens`, refsRow());
    state.vaultEntries.set(refsRow().vaultRef, TOKENS_JSON);

    const client = await resolveDefault(state, {
      connector_credential_store: createDurableStoreService(state.vaultEntries),
    });
    const credentials = (client as { credentials?: { access_token?: string } }).credentials;
    expect(credentials?.access_token).toBe("test-access-token");
  });

  it("stays not-found with zero connected accounts", async () => {
    const state = newDurableState();
    await expect(resolveDefault(state, {})).rejects.toThrow(/default was not found/);
  });

  it("stays not-found with multiple connected accounts", async () => {
    const state = newDurableState();
    state.accounts.set(ACCOUNT_ID, connectedAccount(ACCOUNT_ID));
    state.accounts.set("second-account", connectedAccount("second-account"));
    await expect(resolveDefault(state, {})).rejects.toThrow(/default was not found/);
  });
});

describe("manager-path durability across restart (real core manager + adapter)", () => {
  function createManagerRuntime(
    services: Record<string, unknown>,
    adapter?: InMemoryDatabaseAdapter
  ): IAgentRuntime {
    return {
      agentId: AGENT_ID,
      adapter,
      getService: (name: string) => services[name] ?? null,
      getSetting: (key: string) =>
        key === "GOOGLE_CLIENT_ID"
          ? "client-id"
          : key === "GOOGLE_CLIENT_SECRET"
            ? "client-secret"
            : undefined,
      getMessageConnectors: () => [],
      getPostConnectors: () => [],
      registerMessageConnector: () => undefined,
      registerPostConnector: () => undefined,
    } as unknown as IAgentRuntime;
  }

  it("resolves 'default' to the sole connected account after a restart when the account was written before the adapter registered on the boot runtime", async () => {
    const vaultEntries = new Map<string, string>();
    const vaultRef = `connector.${AGENT_ID}.google.${ACCOUNT_ID}.oauth_tokens`;
    vaultEntries.set(vaultRef, TOKENS_JSON);

    // Boot: the manager is constructed during plugin registration, before
    // plugin-sql attaches the adapter (the exact race that dropped accounts).
    const bootServices = {
      connector_credential_store: createDurableStoreService(vaultEntries),
    };
    const bootRuntime = createManagerRuntime(bootServices);
    const bootManager = getConnectorAccountManager(bootRuntime);

    const adapter = new InMemoryDatabaseAdapter();
    await adapter.initialize();
    (bootRuntime as unknown as { adapter?: InMemoryDatabaseAdapter }).adapter = adapter;

    // OAuth completion writes the connected account with its credential refs.
    await bootManager.upsertAccount("google", {
      ...connectedAccount(ACCOUNT_ID),
      metadata: { credentialRefs: [{ credentialType: "oauth.tokens", vaultRef }] },
    });

    // Restart: fresh runtime + manager over the same durable adapter/vault.
    const restartedRuntime = createManagerRuntime(
      { connector_credential_store: createDurableStoreService(vaultEntries) },
      adapter
    );
    const resolver = new DefaultGoogleCredentialResolver({ runtime: restartedRuntime });
    const client = await resolver.getAuthClient({
      provider: "google",
      accountId: "default",
      scopes: [],
      capabilities: [],
      reason: "post-restart default resolution",
    });
    const credentials = (
      client as { credentials?: { access_token?: string; refresh_token?: string } }
    ).credentials;
    expect(credentials?.access_token).toBe("test-access-token");
    expect(credentials?.refresh_token).toBe("test-refresh-token");
  });
});
