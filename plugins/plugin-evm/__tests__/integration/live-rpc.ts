import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const integrationDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(integrationDir, "../../../../../../");

const ENV_CANDIDATE_PATHS = [
  resolve(integrationDir, "../.env.local"),
  resolve(integrationDir, "../../.env.local"),
  resolve(repoRoot, ".env.local"),
  resolve(repoRoot, "eliza", "cloud", ".env.local"),
  resolve(repoRoot, "eliza", "steward-fi", ".env.local"),
];

for (const envPath of ENV_CANDIDATE_PATHS) {
  if (existsSync(envPath)) {
    config({ path: envPath, override: false });
  }
}

export const LIVE_EVM_RPC_TEST = process.env.ELIZA_LIVE_EVM_RPC_TEST === "1";

export const ELIZA_CLOUD_BASE_URL = (
  process.env.ELIZAOS_CLOUD_BASE_URL?.trim() || "https://www.elizacloud.ai/api/v1"
).replace(/\/$/, "");
export const ELIZA_CLOUD_API_KEY = process.env.ELIZAOS_CLOUD_API_KEY?.trim() || "";
export const HAS_ELIZA_CLOUD_RPC_KEY = ELIZA_CLOUD_API_KEY.length > 0;

const DEFAULT_PUBLIC_RPC_CANDIDATES = {
  mainnet: [
    "https://ethereum.publicnode.com/",
    "https://ethereum-rpc.publicnode.com/",
    "https://eth.llamarpc.com/",
    "https://rpc.ankr.com/eth",
  ],
  base: [
    "https://base.publicnode.com/",
    "https://base-rpc.publicnode.com/",
    "https://base.llamarpc.com/",
    "https://mainnet.base.org/",
  ],
  bsc: [
    "https://bsc.publicnode.com/",
    "https://bsc-rpc.publicnode.com/",
    "https://binance.llamarpc.com/",
    "https://rpc.ankr.com/bsc",
    "https://bsc-dataseed.bnbchain.org/",
    "https://bsc-dataseed1.binance.org/",
    "https://bsc-dataseed2.binance.org/",
    "https://bsc-dataseed3.binance.org/",
  ],
} as const;

type PublicLiveChain = keyof typeof DEFAULT_PUBLIC_RPC_CANDIDATES;

function normalizeRpcUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function splitRpcCandidates(...values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value?.split(",") ?? [])
        .map((value) => normalizeRpcUrl(value))
        .filter((value): value is string => Boolean(value))
    ),
  ];
}

function getEnvCandidateKeys(chain: PublicLiveChain): string[] {
  switch (chain) {
    case "mainnet":
      return ["ETHEREUM_PROVIDER_MAINNET", "ETHEREUM_PROVIDER_ETHEREUM", "ETHEREUM_RPC_URL"];
    case "base":
      return ["ETHEREUM_PROVIDER_BASE", "BASE_RPC_URL"];
    case "bsc":
      return [
        "ETHEREUM_PROVIDER_BSC",
        "BSC_RPC_URL",
        "NODEREAL_BSC_RPC_URL",
        "QUICKNODE_BSC_RPC_URL",
      ];
  }
}

function buildRpcCandidates(chain: PublicLiveChain): string[] {
  const envCandidates = splitRpcCandidates(
    ...getEnvCandidateKeys(chain).map((key) => process.env[key])
  );
  return [...new Set([...envCandidates, ...DEFAULT_PUBLIC_RPC_CANDIDATES[chain]])];
}

export const PUBLIC_FALLBACK_RPC_CANDIDATES = {
  mainnet: buildRpcCandidates("mainnet"),
  base: buildRpcCandidates("base"),
  bsc: buildRpcCandidates("bsc"),
} as const satisfies Record<PublicLiveChain, string[]>;

export const PUBLIC_FALLBACK_RPC_URLS = {
  mainnet: PUBLIC_FALLBACK_RPC_CANDIDATES.mainnet[0],
  base: PUBLIC_FALLBACK_RPC_CANDIDATES.base[0],
  bsc: PUBLIC_FALLBACK_RPC_CANDIDATES.bsc[0],
} as const satisfies Record<PublicLiveChain, string>;

const HEALTHY_RPC_CACHE = new Map<PublicLiveChain, Promise<string>>();
let cloudRpcReadyPromise: Promise<boolean> | null = null;

function isRpcJsonResponse(responseText: string): boolean {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("<") || /monthly cap/i.test(trimmed)) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      typeof parsed === "object" && parsed !== null && ("result" in parsed || "error" in parsed)
    );
  } catch {
    return false;
  }
}

async function probeRpcUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const responseText = await response.text();
    return response.ok && isRpcJsonResponse(responseText);
  } catch {
    return false;
  }
}

async function probeElizaCloudRpc(): Promise<boolean> {
  if (!HAS_ELIZA_CLOUD_RPC_KEY) {
    return false;
  }

  try {
    const response = await fetch(`${ELIZA_CLOUD_BASE_URL}/proxy/evm-rpc/mainnet`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ELIZA_CLOUD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const responseText = await response.text();
    return response.ok && isRpcJsonResponse(responseText);
  } catch {
    return false;
  }
}

export async function shouldUseElizaCloudRpc(): Promise<boolean> {
  if (!cloudRpcReadyPromise) {
    cloudRpcReadyPromise = probeElizaCloudRpc();
  }
  return await cloudRpcReadyPromise;
}

export async function resolveHealthyPublicRpcUrl(chain: PublicLiveChain): Promise<string> {
  const existing = HEALTHY_RPC_CACHE.get(chain);
  if (existing) {
    return await existing;
  }

  const request = (async () => {
    const candidates = PUBLIC_FALLBACK_RPC_CANDIDATES[chain];
    for (const candidate of candidates) {
      if (await probeRpcUrl(candidate)) {
        return candidate;
      }
    }
    return PUBLIC_FALLBACK_RPC_URLS[chain];
  })();

  HEALTHY_RPC_CACHE.set(chain, request);
  return await request;
}
