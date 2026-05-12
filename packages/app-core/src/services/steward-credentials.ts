/**
 * Steward credential persistence for non-sidecar (web/dev) mode.
 *
 * On first setup, saves steward credentials to `<state-dir>/steward-credentials.json`.
 * State dir honors ELIZA_STATE_DIR > ELIZA_STATE_DIR > ~/.eliza.
 * Environment variables always override file values.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Inlined to avoid pulling the @elizaos/core source barrel into consumers
// that only need state-dir resolution (e.g. the Electrobun bun bundle, which
// would otherwise transitively bundle plugin-sql, transformers, and onnxruntime).
// Mirrors the canonical implementation in @elizaos/core's
// src/utils/state-dir.ts: ELIZA_STATE_DIR > ELIZA_STATE_DIR > ~/.${ELIZA_NAMESPACE ?? "eliza"}.
function resolveStateDir(): string {
  const explicit =
    process.env.ELIZA_STATE_DIR?.trim() || process.env.MILADY_STATE_DIR?.trim();
  if (explicit) return explicit;
  const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
  return path.join(homedir(), `.${namespace}`);
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

function resolveCredentialsPath(): string {
  return path.join(resolveStateDir(), CREDENTIALS_FILENAME);
}

/**
 * Load persisted steward credentials from disk.
 * Returns null if file doesn't exist or is unreadable.
 */
export function loadStewardCredentials(): PersistedStewardCredentials | null {
  const credPath = resolveCredentialsPath();
  try {
    if (!fs.existsSync(credPath)) {
      return null;
    }
    const raw = fs.readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedStewardCredentials;
    if (!parsed.apiUrl || !parsed.tenantId || !parsed.agentId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save steward credentials to disk with restrictive permissions (0o600).
 */
export function saveStewardCredentials(
  credentials: PersistedStewardCredentials,
): void {
  const credPath = resolveCredentialsPath();
  const dir = path.dirname(credPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = {
    ...credentials,
    createdAt: credentials.createdAt ?? new Date().toISOString(),
  };

  fs.writeFileSync(credPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Resolve effective steward configuration by merging:
 *   env vars > persisted file > defaults
 *
 * Returns null if steward is not configured at all.
 */
export function resolveEffectiveStewardConfig(
  env: NodeJS.ProcessEnv = process.env,
): PersistedStewardCredentials | null {
  const persisted = loadStewardCredentials();

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
