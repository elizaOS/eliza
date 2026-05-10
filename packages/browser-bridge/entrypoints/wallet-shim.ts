/**
 * Wallet shim content script — runs at `document_start` on every page.
 *
 * Reads `walletShim.apiBase` / `walletShim.signToken` (and the cached
 * `solanaPublicKey` / `evmAddress` / `evmChainId`) from `chrome.storage.local`,
 * bakes them into the shim template (which lives in the bundle as a string
 * constant via `__WALLET_SHIM_TEMPLATE__`), and injects the resulting JS into
 * the page's MAIN world by appending a `<script>textContent=…</script>` to
 * `document.documentElement`. The MAIN-world script registers a Wallet-Standard
 * Solana wallet and an EIP-1193 EVM provider (`window.ethereum` + EIP-6963).
 *
 * If config is missing or stale, the shim no-ops — pages see no provider.
 *
 * Population path:
 *   `chrome.storage.local.set({ walletShim: { apiBase, signToken,
 *     solanaPublicKey, evmAddress, evmChainId } })`
 *
 * The popup will eventually expose a paired-agent button that pulls these
 * fields from the agent's auth handshake and writes them; until then they can
 * be populated manually from the extension's service worker console.
 */

declare const __WALLET_SHIM_TEMPLATE__: string;

interface WalletShimStored {
  apiBase: string;
  signToken: string;
  solanaPublicKey?: string | null;
  evmAddress?: string | null;
  evmChainId?: number;
  walletName?: string;
  walletIcon?: string;
}

const DEFAULT_EVM_RPCS: Record<string, string> = {
  "1": "https://eth.llamarpc.com",
  "8453": "https://mainnet.base.org",
  "56": "https://bsc-dataseed.bnbchain.org",
  "10": "https://mainnet.optimism.io",
  "42161": "https://arb1.arbitrum.io/rpc",
  "137": "https://polygon-rpc.com",
};

const DEFAULT_ICON =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#9b87f5"/><text x="16" y="22" font-family="Arial,sans-serif" font-size="18" fill="#fff" text-anchor="middle" font-weight="700">E</text></svg>',
  );

function readShimConfig(): Promise<WalletShimStored | null> {
  return new Promise((resolve) => {
    try {
      // Manifest V3: chrome.storage.local is async-callback or Promise-based.
      const api = (globalThis as unknown as {
        chrome?: typeof chrome;
        browser?: typeof chrome;
      }).chrome ?? (globalThis as unknown as { browser?: typeof chrome }).browser;
      if (!api?.storage?.local?.get) {
        resolve(null);
        return;
      }
      const maybe = api.storage.local.get(["walletShim"], (items: unknown) => {
        const stored = (items as { walletShim?: WalletShimStored } | undefined)
          ?.walletShim;
        resolve(stored ?? null);
      });
      // Some browsers (Firefox) return a Promise instead of using callback.
      if (
        maybe &&
        typeof (maybe as Promise<unknown>).then === "function"
      ) {
        (maybe as Promise<{ walletShim?: WalletShimStored }>)
          .then((items) => resolve(items?.walletShim ?? null))
          .catch(() => resolve(null));
      }
    } catch {
      resolve(null);
    }
  });
}

function bakeShim(stored: WalletShimStored): string | null {
  if (!stored.apiBase || !stored.signToken || stored.signToken.length < 16) {
    return null;
  }
  const baked = {
    apiBase: stored.apiBase.replace(/\/+$/, ""),
    signToken: stored.signToken,
    walletName: stored.walletName ?? "Eliza Wallet",
    walletIcon: stored.walletIcon ?? DEFAULT_ICON,
    solanaPublicKey: stored.solanaPublicKey ?? null,
    evmAddress: stored.evmAddress ?? null,
    evmChainId: stored.evmChainId ?? 1,
    evmRpcByChainId: DEFAULT_EVM_RPCS,
  };
  return __WALLET_SHIM_TEMPLATE__.replace(
    "/*ELIZA_WALLET_SHIM_CONFIG_INSERT*/ null",
    JSON.stringify(baked),
  );
}

function injectIntoMainWorld(js: string): void {
  try {
    const root = document.documentElement;
    if (!root) return;
    const tag = document.createElement("script");
    tag.textContent = js;
    // Prepending so we run before any page script that does early provider
    // detection.
    root.insertBefore(tag, root.firstChild);
    // The script runs synchronously on insertion; remove the element to keep
    // the DOM clean (page scripts that race document_start may still pick up
    // our window.solana/window.ethereum since they're set during the insert).
    tag.remove();
  } catch {
    // Permission-denied / CSP violations are expected on a few hardened
    // origins (Chrome web store, etc.). We silently no-op in that case.
  }
}

(async () => {
  const stored = await readShimConfig();
  if (!stored) return;
  const js = bakeShim(stored);
  if (!js) return;
  injectIntoMainWorld(js);
})();
