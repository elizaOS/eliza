import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import type { ExecutionConfig, ExecutionKolSupport } from "../types";
import { collectPublicKolWallets } from "./public-kol";

const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
] as const;

interface KolWalletEntry {
  label: string | undefined;
  address: string;
}

let inMemoryKolWallets: KolWalletEntry[] | null = null;

function normalizeAddress(value: string): string | null {
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

async function loadKolWallets(
  config: ExecutionConfig,
): Promise<KolWalletEntry[]> {
  if (inMemoryKolWallets && inMemoryKolWallets.length > 0) {
    return inMemoryKolWallets;
  }

  if (!config.kol.walletsPath) {
    inMemoryKolWallets = await collectPublicKolWallets(config);
    return inMemoryKolWallets;
  }

  try {
    const content = await readFile(config.kol.walletsPath, "utf8");
    const parsed = JSON.parse(content) as Array<
      string | { label?: string; address?: string }
    >;
    const wallets = parsed
      .map((entry) => {
        const address = typeof entry === "string" ? entry : entry?.address;
        const normalized = address ? normalizeAddress(address) : null;
        if (!normalized) return null;
        return {
          label: typeof entry === "string" ? undefined : entry?.label,
          address: normalized,
        };
      })
      .filter((entry): entry is KolWalletEntry => entry !== null);

    inMemoryKolWallets = wallets;
    return wallets;
  } catch {
    inMemoryKolWallets = await collectPublicKolWallets(config);
    return inMemoryKolWallets;
  }
}

export function setKolWalletCache(
  wallets: Array<{ label?: string; address: string }>,
): void {
  inMemoryKolWallets = wallets
    .map((wallet) => {
      const normalized = normalizeAddress(wallet.address);
      if (!normalized) return null;
      return {
        label: wallet.label,
        address: normalized,
      };
    })
    .filter((wallet): wallet is KolWalletEntry => wallet !== null);
}

export async function evaluateKolSupport(
  config: ExecutionConfig,
  tokenAddress: string,
): Promise<ExecutionKolSupport> {
  if (!config.kol.enabled) {
    return {
      enabled: false,
      trackedWalletCount: 0,
      holderCount: 0,
      qualified: true,
      reason: "KOL gate is disabled.",
    };
  }

  if (!config.rpcUrl) {
    return {
      enabled: true,
      trackedWalletCount: 0,
      holderCount: 0,
      qualified: false,
      reason: "KOL gate requires a configured BNB RPC endpoint.",
    };
  }

  const wallets = await loadKolWallets(config);
  if (wallets.length === 0) {
    return {
      enabled: true,
      trackedWalletCount: 0,
      holderCount: 0,
      qualified: false,
      reason: "KOL gate is enabled, but no wallet list could be loaded.",
    };
  }

  try {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    const contract = new ethers.Contract(
      tokenAddress,
      ERC20_BALANCE_ABI,
      provider,
    );
    const balances = await Promise.all(
      wallets.map(async (wallet) => {
        const balance = (await contract.balanceOf(wallet.address)) as bigint;
        return {
          wallet,
          isHolder: balance > 0n,
        };
      }),
    );
    const holders = balances.filter((entry) => entry.isHolder);
    const qualified = holders.length >= config.kol.minHolderCount;

    return {
      enabled: true,
      trackedWalletCount: wallets.length,
      holderCount: holders.length,
      qualified,
      reason: qualified
        ? `${holders.length}/${wallets.length} tracked KOL wallets still hold this token.`
        : `Only ${holders.length}/${wallets.length} tracked KOL wallets still hold this token; minimum is ${config.kol.minHolderCount}.`,
    };
  } catch (error) {
    return {
      enabled: true,
      trackedWalletCount: wallets.length,
      holderCount: 0,
      qualified: false,
      reason:
        error instanceof Error
          ? `KOL gate check failed: ${error.message}`
          : "KOL gate check failed.",
    };
  }
}
