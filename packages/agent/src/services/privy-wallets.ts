import { logger } from "@elizaos/core";

export type PrivyWalletChain = "ethereum" | "solana";

export interface PrivyWalletAddresses {
  evmAddress: string | null;
  solanaAddress: string | null;
}

export interface PrivyWalletSummary {
  id: string;
  chain: PrivyWalletChain;
  address: string;
}

export interface PrivyEnsureWalletsResult extends PrivyWalletAddresses {
  userId: string;
  createdUser: boolean;
  wallets: PrivyWalletSummary[];
}

interface PrivyConfig {
  appId: string;
  appSecret: string;
  apiBaseUrl: string;
}

interface PrivyUser {
  id: string;
}

interface PrivyWallet {
  id?: unknown;
  address?: unknown;
  chain_type?: unknown;
}

const PRIVY_DEFAULT_API_BASE_URL = "https://auth.privy.io/api/v1";
const PRIVY_TIMEOUT_MS = 12_000;

function normalizeEnvValue(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePrivyConfig(
  env: NodeJS.ProcessEnv = process.env,
): PrivyConfig | null {
  const appId =
    normalizeEnvValue(env.PRIVY_APP_ID) ??
    normalizeEnvValue(env.BABYLON_PRIVY_APP_ID);
  const appSecret =
    normalizeEnvValue(env.PRIVY_APP_SECRET) ??
    normalizeEnvValue(env.BABYLON_PRIVY_APP_SECRET);
  if (!appId || !appSecret) return null;

  const apiBaseUrl =
    normalizeEnvValue(env.PRIVY_API_BASE_URL) ?? PRIVY_DEFAULT_API_BASE_URL;

  // Validate that the Privy API base URL uses HTTPS to prevent SSRF
  // attacks that could leak credentials to arbitrary endpoints.
  try {
    const parsed = new URL(apiBaseUrl);
    if (parsed.protocol !== "https:") {
      logger.warn(
        `[privy] PRIVY_API_BASE_URL must use https:, got ${parsed.protocol} — falling back to default.`,
      );
      return {
        appId,
        appSecret,
        apiBaseUrl: PRIVY_DEFAULT_API_BASE_URL,
      };
    }
  } catch {
    logger.warn(
      "[privy] PRIVY_API_BASE_URL is not a valid URL — falling back to default.",
    );
    return {
      appId,
      appSecret,
      apiBaseUrl: PRIVY_DEFAULT_API_BASE_URL,
    };
  }

  return {
    appId,
    appSecret,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
  };
}

export function isPrivyWalletProvisioningEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolvePrivyConfig(env) !== null;
}

function assertPrivyConfig(env: NodeJS.ProcessEnv = process.env): PrivyConfig {
  const config = resolvePrivyConfig(env);
  if (!config) {
    throw new Error(
      "Privy wallet provisioning is not configured (missing PRIVY_APP_ID / PRIVY_APP_SECRET).",
    );
  }
  return config;
}

function authHeaders(config: PrivyConfig): Record<string, string> {
  const basic = Buffer.from(`${config.appId}:${config.appSecret}`).toString(
    "base64",
  );
  return {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/json",
    "privy-app-id": config.appId,
  };
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

async function privyRequest<T>(
  config: PrivyConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...authHeaders(config),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(PRIVY_TIMEOUT_MS),
  });

  if (!response.ok) {
    const details = (await readResponseText(response)).slice(0, 240);
    const suffix = details ? `: ${details}` : "";
    throw new Error(
      `Privy request failed (${response.status}) for ${path}${suffix}`,
    );
  }

  return (await response.json()) as T;
}

async function getUserByCustomAuthId(
  config: PrivyConfig,
  customUserId: string,
): Promise<PrivyUser | null> {
  const response = await fetch(`${config.apiBaseUrl}/users/custom_auth/id`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ custom_user_id: customUserId }),
    signal: AbortSignal.timeout(PRIVY_TIMEOUT_MS),
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const details = (await readResponseText(response)).slice(0, 240);
    throw new Error(
      `Privy user lookup failed (${response.status})${details ? `: ${details}` : ""}`,
    );
  }

  const payload = (await response.json()) as { id?: unknown };
  if (typeof payload.id !== "string" || payload.id.length === 0) {
    throw new Error("Privy user lookup returned an invalid response.");
  }
  return { id: payload.id };
}

async function createUserWithWallets(
  config: PrivyConfig,
  customUserId: string,
): Promise<PrivyUser> {
  const payload = await privyRequest<{ id?: unknown }>(config, "/users", {
    method: "POST",
    body: JSON.stringify({
      linked_accounts: [
        {
          type: "custom_auth",
          custom_user_id: customUserId,
        },
      ],
      wallets: [{ chain_type: "ethereum" }, { chain_type: "solana" }],
    }),
  });

  if (typeof payload.id !== "string" || payload.id.length === 0) {
    throw new Error("Privy user creation returned an invalid response.");
  }

  return { id: payload.id };
}

function parseWalletList(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    );
  }

  if (typeof payload !== "object" || payload === null) return [];
  const candidate = payload as Record<string, unknown>;
  const arrays = [candidate.data, candidate.results, candidate.wallets];
  for (const value of arrays) {
    if (!Array.isArray(value)) continue;
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    );
  }
  return [];
}

function normalizeWalletChain(wallet: PrivyWallet): PrivyWalletChain | null {
  const rawChain =
    typeof wallet.chain_type === "string"
      ? wallet.chain_type.toLowerCase()
      : "";
  if (rawChain.includes("sol")) return "solana";
  if (rawChain.includes("eth") || rawChain === "evm") return "ethereum";

  const address = typeof wallet.address === "string" ? wallet.address : "";
  if (address.startsWith("0x")) return "ethereum";
  if (address.length > 0) return "solana";
  return null;
}

function normalizeWalletSummary(
  wallet: PrivyWallet,
): PrivyWalletSummary | null {
  const chain = normalizeWalletChain(wallet);
  const address =
    typeof wallet.address === "string" ? wallet.address.trim() : "";
  const id = typeof wallet.id === "string" ? wallet.id : "";
  if (!chain || !address || !id) return null;
  return { id, chain, address };
}

async function listUserWallets(
  config: PrivyConfig,
  userId: string,
): Promise<PrivyWalletSummary[]> {
  const payload = await privyRequest<unknown>(
    config,
    `/wallets?user_id=${encodeURIComponent(userId)}&limit=100`,
    { method: "GET" },
  );

  const rawWallets = parseWalletList(payload);
  const wallets: PrivyWalletSummary[] = [];
  for (const raw of rawWallets) {
    const summary = normalizeWalletSummary(raw);
    if (!summary) continue;
    if (
      wallets.some(
        (wallet) =>
          wallet.chain === summary.chain && wallet.address === summary.address,
      )
    ) {
      continue;
    }
    wallets.push(summary);
  }
  return wallets;
}

async function createWalletForUser(
  config: PrivyConfig,
  userId: string,
  chain: PrivyWalletChain,
): Promise<void> {
  await privyRequest<unknown>(
    config,
    `/users/${encodeURIComponent(userId)}/wallets`,
    {
      method: "POST",
      body: JSON.stringify({ chain_type: chain }),
    },
  );
}

function pickAddresses(wallets: PrivyWalletSummary[]): PrivyWalletAddresses {
  const evmAddress =
    wallets.find((wallet) => wallet.chain === "ethereum")?.address ?? null;
  const solanaAddress =
    wallets.find((wallet) => wallet.chain === "solana")?.address ?? null;
  return { evmAddress, solanaAddress };
}

export async function ensurePrivyWalletsForCustomUser(
  customUserId: string,
  chains: PrivyWalletChain[] = ["ethereum", "solana"],
  env: NodeJS.ProcessEnv = process.env,
): Promise<PrivyEnsureWalletsResult> {
  const normalizedCustomUserId = customUserId.trim();
  if (!normalizedCustomUserId) {
    throw new Error("customUserId is required.");
  }

  const targetChains = Array.from(new Set(chains));
  const config = assertPrivyConfig(env);

  let user = await getUserByCustomAuthId(config, normalizedCustomUserId);
  let createdUser = false;
  if (!user) {
    user = await createUserWithWallets(config, normalizedCustomUserId);
    createdUser = true;
  }

  let wallets = await listUserWallets(config, user.id);
  for (const chain of targetChains) {
    const exists = wallets.some((wallet) => wallet.chain === chain);
    if (!exists) {
      await createWalletForUser(config, user.id, chain);
    }
  }

  if (targetChains.some((chain) => !wallets.some((w) => w.chain === chain))) {
    wallets = await listUserWallets(config, user.id);
  }

  const addresses = pickAddresses(wallets);
  if (
    targetChains.includes("ethereum") &&
    !addresses.evmAddress &&
    targetChains.includes("solana") &&
    !addresses.solanaAddress
  ) {
    logger.warn(
      `[privy] Wallet ensure returned no addresses for user ${user.id}`,
    );
  }

  return {
    userId: user.id,
    createdUser,
    wallets,
    ...addresses,
  };
}
