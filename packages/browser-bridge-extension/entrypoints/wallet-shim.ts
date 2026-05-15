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
      const api =
        (
          globalThis as unknown as {
            chrome?: typeof chrome;
            browser?: typeof chrome;
          }
        ).chrome ??
        (globalThis as unknown as { browser?: typeof chrome }).browser;
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
      if (maybe && typeof (maybe as Promise<unknown>).then === "function") {
        (maybe as Promise<{ walletShim?: WalletShimStored }>)
          .then((items) => resolve(items.walletShim ?? null))
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
    root.insertBefore(tag, root.firstChild);
    tag.remove();
  } catch {}
}

(async () => {
  const stored = await readShimConfig();
  if (!stored) return;
  const js = bakeShim(stored);
  if (!js) return;
  injectIntoMainWorld(js);
})();
