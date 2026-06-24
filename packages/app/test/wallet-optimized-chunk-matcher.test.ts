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
});
