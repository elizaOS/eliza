/**
 * Build a self-contained JS string that, when evaluated in a page's MAIN
 * world, registers the agent as a Wallet-Standard Solana wallet and an
 * EIP-1193 EVM provider. All signing requests are forwarded to the wallet
 * plugin's HTTP sign endpoints (gated by the bearer token).
 *
 * Consumers:
 *   - browser-bridge extension content script (MAIN world, document_start)
 *   - Playwright `page.addInitScript(buildWalletShim({...}))`
 *   - plugin-browser `BROWSER eval` (post-load fallback)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface WalletShimConfig {
  /** Base URL of the wallet HTTP API (e.g. `http://127.0.0.1:31337`). */
  apiBase: string;
  /** Shared bearer token (matches `WALLET_BROWSER_SIGN_TOKEN`). */
  signToken: string;
  /** Display name shown to dApps. */
  walletName?: string;
  /** Optional data URL icon. */
  walletIcon?: string;
  /** Active Solana public key (base58). Pass null to disable Solana surface. */
  solanaPublicKey: string | null;
  /** Active EVM address (0x…). Pass null to disable EVM surface. */
  evmAddress: string | null;
  /** Default EVM chain id the provider reports until a switch is requested. */
  evmChainId?: number;
  /** Public RPC URLs the shim uses for read-only EVM calls, keyed by chainId. */
  evmRpcByChainId?: Record<string, string>;
}

const DEFAULT_EVM_RPCS: Record<string, string> = {
  // Ethereum mainnet
  "1": "https://eth.llamarpc.com",
  // Base
  "8453": "https://mainnet.base.org",
  // BSC
  "56": "https://bsc-dataseed.bnbchain.org",
  // Optimism
  "10": "https://mainnet.optimism.io",
  // Arbitrum
  "42161": "https://arb1.arbitrum.io/rpc",
  // Polygon
  "137": "https://polygon-rpc.com",
};

const DEFAULT_ICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#9b87f5"/><text x="16" y="22" font-family="Arial,sans-serif" font-size="18" fill="#fff" text-anchor="middle" font-weight="700">E</text></svg>',
  ).toString("base64");

let cachedTemplate: string | null = null;

function readTemplate(): string {
  if (cachedTemplate) return cachedTemplate;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // When loaded from src/ during dev, template lives next to this file.
  // When loaded from dist/, the build copies it alongside.
  const candidates = [
    path.join(here, "shim.template.js"),
    path.join(here, "..", "..", "src", "browser-shim", "shim.template.js"),
  ];
  for (const candidate of candidates) {
    try {
      cachedTemplate = fs.readFileSync(candidate, "utf8");
      return cachedTemplate;
    } catch {
      // try next
    }
  }
  throw new Error(
    `wallet shim template not found in any of: ${candidates.join(", ")}`,
  );
}

export function buildWalletShim(config: WalletShimConfig): string {
  if (!config.apiBase) throw new Error("buildWalletShim: apiBase required");
  if (!config.signToken || config.signToken.length < 16) {
    throw new Error(
      "buildWalletShim: signToken must be ≥16 chars (WALLET_BROWSER_SIGN_TOKEN)",
    );
  }
  const template = readTemplate();
  const baked = {
    apiBase: config.apiBase.replace(/\/+$/, ""),
    signToken: config.signToken,
    walletName: config.walletName ?? "Eliza Wallet",
    walletIcon: config.walletIcon ?? DEFAULT_ICON,
    solanaPublicKey: config.solanaPublicKey,
    evmAddress: config.evmAddress,
    evmChainId: config.evmChainId ?? 1,
    evmRpcByChainId: { ...DEFAULT_EVM_RPCS, ...(config.evmRpcByChainId ?? {}) },
  };
  return template.replace(
    "/*ELIZA_WALLET_SHIM_CONFIG_INSERT*/ null",
    JSON.stringify(baked),
  );
}

export function buildWalletShimFromTemplate(
  template: string,
  config: WalletShimConfig,
): string {
  const baked = {
    apiBase: config.apiBase.replace(/\/+$/, ""),
    signToken: config.signToken,
    walletName: config.walletName ?? "Eliza Wallet",
    walletIcon: config.walletIcon ?? DEFAULT_ICON,
    solanaPublicKey: config.solanaPublicKey,
    evmAddress: config.evmAddress,
    evmChainId: config.evmChainId ?? 1,
    evmRpcByChainId: { ...DEFAULT_EVM_RPCS, ...(config.evmRpcByChainId ?? {}) },
  };
  return template.replace(
    "/*ELIZA_WALLET_SHIM_CONFIG_INSERT*/ null",
    JSON.stringify(baked),
  );
}
