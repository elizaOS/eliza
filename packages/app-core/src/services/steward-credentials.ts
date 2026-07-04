/**
 * Steward credential persistence for non-sidecar (web/dev) mode.
 *
 * On first setup, saves non-secret steward metadata to
 * `<state-dir>/steward-credentials.json` and saves secret values to the
 * platform secure store. State dir honors ELIZA_STATE_DIR > XDG state home.
 * Environment variables always override persisted values.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  PlatformSecureStore,
  SecureStoreSecretKind,
} from "../security/platform-secure-store";
import { createNodePlatformSecureStore } from "../security/platform-secure-store-node";

// Inlined to avoid pulling the @elizaos/core source barrel into consumers
// that only need state-dir resolution (e.g. the Electrobun bun bundle, which
// would otherwise transitively bundle plugin-sql, transformers, and onnxruntime).
// Mirrors the canonical implementation in @elizaos/core's state-dir helper.
function resolveStateDir(): string {
  const explicit = process.env.ELIZA_STATE_DIR?.trim();
  if (explicit) return explicit;
  const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  const stateHome = xdgStateHome
    ? path.isAbsolute(xdgStateHome)
      ? xdgStateHome
      : path.join(homedir(), xdgStateHome)
    : path.join(homedir(), ".local", "state");
  return path.join(stateHome, namespace);
}

export interface PersistedStewardCredentials {
  apiUrl: string;
  tenantId: string;
  agentId: string;
  apiKey: string;
  agentToken: string;
  walletAddresses?: {
    evm?: string;
    solana?: string;
  };
  agentName?: string;
  createdAt?: string;
}

const CREDENTIALS_FILENAME = "steward-credentials.json";
const STEWARD_SECRET_KINDS = {
  apiUrl: "steward.api_url",
  tenantId: "steward.tenant_id",
  agentId: "steward.agent_id",
  apiKey: "steward.api_key",
  agentToken: "steward.agent_token",
} as const satisfies Record<string, SecureStoreSecretKind>;

type StewardCredentialSecretField = keyof typeof STEWARD_SECRET_KINDS;
type StewardCredentialsMetadata = Omit<
  PersistedStewardCredentials,
  StewardCredentialSecretField
> &
  Partial<Pick<PersistedStewardCredentials, "apiUrl" | "tenantId" | "agentId">>;

interface StewardCredentialPersistenceOptions {
  secureStore?: PlatformSecureStore;
}

function resolveCredentialsPath(): string {
  return path.join(resolveStateDir(), CREDENTIALS_FILENAME);
}

function deriveStewardVaultId(): string {
  const resolved = path.resolve(resolveStateDir());
  let canonicalStateDir = resolved;
  try {
    canonicalStateDir = fs.realpathSync(resolved);
  } catch {
    // Directory may not exist before first save.
  }
  const hash = createHash("sha256").update(canonicalStateDir, "utf8").digest();
  const token = Buffer.from(hash).toString("base64url").slice(0, 16);
  return `mldy1-${token}`;
}

function createStewardSecureStore(
  options: StewardCredentialPersistenceOptions = {},
): PlatformSecureStore {
  return options.secureStore ?? createNodePlatformSecureStore();
}

function readCredentialsFile():
  | (Partial<PersistedStewardCredentials> & StewardCredentialsMetadata)
  | null {
  const credPath = resolveCredentialsPath();
  try {
    if (!fs.existsSync(credPath)) {
      return null;
    }
    return JSON.parse(
      fs.readFileSync(credPath, "utf-8"),
    ) as Partial<PersistedStewardCredentials> & StewardCredentialsMetadata;
  } catch {
    return null;
  }
}

function writeCredentialsMetadata(
  credentials: PersistedStewardCredentials | StewardCredentialsMetadata,
): void {
  const credPath = resolveCredentialsPath();
  const dir = path.dirname(credPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data: StewardCredentialsMetadata = {
    walletAddresses: credentials.walletAddresses,
    agentName: credentials.agentName,
    createdAt: credentials.createdAt ?? new Date().toISOString(),
  };
  if (credentials.apiUrl) data.apiUrl = credentials.apiUrl;
  if (credentials.tenantId) data.tenantId = credentials.tenantId;
  if (credentials.agentId) data.agentId = credentials.agentId;

  fs.writeFileSync(credPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function readStewardSecret(
  store: PlatformSecureStore,
  vaultId: string,
  field: StewardCredentialSecretField,
): Promise<string | null> {
  const got = await store.get(vaultId, STEWARD_SECRET_KINDS[field]);
  return got.ok && got.value.trim() ? got.value.trim() : null;
}

async function writeStewardSecret(
  store: PlatformSecureStore,
  vaultId: string,
  field: StewardCredentialSecretField,
  value: string,
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) return;
  const result = await store.set(vaultId, STEWARD_SECRET_KINDS[field], trimmed);
  if (!result.ok) {
    throw new Error(
      `secure store rejected ${field}: ${result.message ?? result.reason}`,
    );
  }
}

async function migrateLegacyFileSecrets(
  store: PlatformSecureStore,
  vaultId: string,
  parsed: Partial<PersistedStewardCredentials> & StewardCredentialsMetadata,
): Promise<void> {
  const migrated: Partial<PersistedStewardCredentials> = {};
  for (const field of Object.keys(
    STEWARD_SECRET_KINDS,
  ) as StewardCredentialSecretField[]) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) {
      await writeStewardSecret(store, vaultId, field, value);
      migrated[field] = value.trim();
    }
  }
  if (Object.keys(migrated).length > 0) {
    writeCredentialsMetadata({ ...parsed, ...migrated });
  }
}

/**
 * Load persisted steward credentials from metadata + platform secure store.
 * Returns null if credentials are missing or unreadable.
 */
export async function loadStewardCredentials(
  options: StewardCredentialPersistenceOptions = {},
): Promise<PersistedStewardCredentials | null> {
  const parsed = readCredentialsFile();
  if (!parsed) return null;

  const store = createStewardSecureStore(options);
  const hasLegacySecrets = (
    Object.keys(STEWARD_SECRET_KINDS) as StewardCredentialSecretField[]
  ).some((field) => {
    const value = parsed[field];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (await store.isAvailable()) {
    const vaultId = deriveStewardVaultId();
    await migrateLegacyFileSecrets(store, vaultId, parsed);

    const secureValues: Partial<
      Pick<PersistedStewardCredentials, StewardCredentialSecretField>
    > = {};
    for (const field of Object.keys(
      STEWARD_SECRET_KINDS,
    ) as StewardCredentialSecretField[]) {
      const value = await readStewardSecret(store, vaultId, field);
      if (value) {
        secureValues[field] = value;
      }
    }

    const apiUrl = secureValues.apiUrl || parsed.apiUrl || null;
    const tenantId = secureValues.tenantId || parsed.tenantId || null;
    const agentId = secureValues.agentId || parsed.agentId || null;
    if (!apiUrl || !tenantId || !agentId) {
      return null;
    }

    return {
      apiUrl,
      tenantId,
      agentId,
      apiKey: secureValues.apiKey || "",
      agentToken: secureValues.agentToken || "",
      walletAddresses: parsed.walletAddresses,
      agentName: parsed.agentName,
      createdAt: parsed.createdAt,
    };
  }

  if (hasLegacySecrets) {
    writeCredentialsMetadata(parsed);
  }

  const apiUrl = parsed.apiUrl || null;
  const tenantId = parsed.tenantId || null;
  const agentId = parsed.agentId || null;
  if (!apiUrl || !tenantId || !agentId) return null;
  return {
    apiUrl,
    tenantId,
    agentId,
    apiKey: "",
    agentToken: "",
    walletAddresses: parsed.walletAddresses,
    agentName: parsed.agentName,
    createdAt: parsed.createdAt,
  };
}

/**
 * Save steward credentials to the platform secure store and metadata to disk.
 */
export async function saveStewardCredentials(
  credentials: PersistedStewardCredentials,
  options: StewardCredentialPersistenceOptions = {},
): Promise<void> {
  const store = createStewardSecureStore(options);
  if (await store.isAvailable()) {
    const vaultId = deriveStewardVaultId();
    await Promise.all(
      (Object.keys(STEWARD_SECRET_KINDS) as StewardCredentialSecretField[]).map(
        (field) =>
          writeStewardSecret(store, vaultId, field, credentials[field]),
      ),
    );
  }

  writeCredentialsMetadata(credentials);
}

/**
 * Resolve effective steward configuration by merging:
 *   env vars > persisted file > defaults
 *
 * Returns null if steward is not configured at all.
 */
export async function resolveEffectiveStewardConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: StewardCredentialPersistenceOptions = {},
): Promise<PersistedStewardCredentials | null> {
  const persisted = await loadStewardCredentials(options);

  const apiUrl = env.STEWARD_API_URL?.trim() || persisted?.apiUrl || null;
  if (!apiUrl) {
    return null;
  }

  const tenantId = env.STEWARD_TENANT_ID?.trim() || persisted?.tenantId || null;
  const agentId =
    env.STEWARD_AGENT_ID?.trim() ||
    env.ELIZA_STEWARD_AGENT_ID?.trim() ||
    persisted?.agentId ||
    null;
  const apiKey = env.STEWARD_API_KEY?.trim() || persisted?.apiKey || "";
  const agentToken =
    env.STEWARD_AGENT_TOKEN?.trim() || persisted?.agentToken || "";

  return {
    apiUrl,
    tenantId: tenantId || "",
    agentId: agentId || "",
    apiKey,
    agentToken,
    walletAddresses: persisted?.walletAddresses,
    agentName: persisted?.agentName,
    createdAt: persisted?.createdAt,
  };
}
