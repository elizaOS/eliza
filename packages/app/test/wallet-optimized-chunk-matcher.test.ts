/**
 * Unit tests for the Wallet Optimized Chunk Matcher app shell contract and
 * coverage guardrail.
 */
import { describe, expect, it } from "vitest";
import { VENDOR_OPTIMIZED_WALLET_TEST } from "../vite/wallet-chunk-matcher.ts";

describe("wallet optimized-deps chunk matcher", () => {
  it("matches flattened scoped wallet deps emitted by Vite", () => {
    const optimizedWalletDeps = [
      "/repo/node_modules/.vite/deps/@solana_wallet-adapter-react-ui.js?v=123",
      "/repo/node_modules/.vite/deps/@solana_web3__js.js",
      "/repo/node_modules/.vite/deps/@solana_spl-token.js",
      "/repo/node_modules/.vite/deps/@rainbow-me_rainbowkit.js",
      "/repo/node_modules/.vite/deps/@walletconnect_modal.js",
      "/repo/node_modules/.vite/deps/@reown_appkit.js",
      "/repo/node_modules/.vite/deps/@wagmi_core.js",
      "/repo/node_modules/.vite/deps/@coinbase_wallet-sdk.js",
    ];

    for (const dep of optimizedWalletDeps) {
      expect(VENDOR_OPTIMIZED_WALLET_TEST.test(dep), dep).toBe(true);
    }
  });

  it("matches flattened optimized crypto deps that share the bn.js graph", () => {
    const optimizedCryptoDeps = [
      "/repo/node_modules/.vite/deps/bn__js.js",
      "/repo/node_modules/.vite/deps/buffer.js",
      "/repo/node_modules/.vite/deps/safe-buffer.js",
      "/repo/node_modules/.vite/deps/hash_base.js",
      "/repo/node_modules/.vite/deps/create-hash.js",
      "/repo/node_modules/.vite/deps/create_hmac.js",
      "/repo/node_modules/.vite/deps/sha_js.js",
    ];

    for (const dep of optimizedCryptoDeps) {
      expect(VENDOR_OPTIMIZED_WALLET_TEST.test(dep), dep).toBe(true);
    }
  });

  it("matches optimized wallet helpers that Rollup may otherwise chunk eagerly", () => {
    expect(
      VENDOR_OPTIMIZED_WALLET_TEST.test(
        "/repo/node_modules/.vite/deps/useWalletModal.js?v=123",
      ),
    ).toBe(true);
  });

  it("matches virtual wallet helper facades that lack a node_modules prefix", () => {
    const facadeIds = [
      "\0useWalletModal.js?commonjs-entry",
      "\0commonjs-proxy:/repo/node_modules/@solana/wallet-adapter-react-ui/lib/esm/useWalletModal.js",
      "/repo/.vite/generated/useWalletModal-GR6cQmcn.js",
    ];

    for (const id of facadeIds) {
      expect(VENDOR_OPTIMIZED_WALLET_TEST.test(id), id).toBe(true);
    }
  });

  it("never matches first-party source (the manual-chunk fold would anchor vendor-crypto into the entry)", () => {
    // Rollup folds a pinned module's whole dependency subtree into the manual
    // chunk. Pinning an app component (the old direct-crypto-credit-card pin)
    // dragged the shared @elizaos/core + UI graph into vendor-crypto, forcing
    // the entry to statically import the multi-MB wallet chunk on every boot
    // (#13187 residual). First-party consumers stay behind dynamic import()
    // boundaries instead; scripts/verify-chunk-safety.mjs gates the bundle.
    const firstPartyIds = [
      "/repo/packages/ui/src/cloud/billing/components/direct-crypto-credit-card.tsx",
      "/repo/packages/ui/src/cloud/billing/wallet/steward-wallet-providers.tsx",
      "/repo/packages/core/dist/browser/index.browser.js",
    ];

    for (const id of firstPartyIds) {
      expect(VENDOR_OPTIMIZED_WALLET_TEST.test(id), id).toBe(false);
    }
  });
});
