/**
 * Esbuild resolver for wallet connector peers that are intentionally absent
 * from the cloud settings fixture. The fixture never exercises wallet
 * connections, but wagmi keeps optional connector imports in its module graph.
 */

import type { Plugin } from "esbuild";

export const optionalWalletPeers = [
  "@base-org/account",
  "@coinbase/wallet-sdk",
  "@metamask/connect-evm",
  "@safe-global/safe-apps-provider",
  "@safe-global/safe-apps-sdk",
  "@walletconnect/ethereum-provider",
  "cbw-sdk",
  "porto",
] as const;

const escapedPeers = optionalWalletPeers.map((peer) =>
  peer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
);
const optionalWalletPeerPattern = new RegExp(
  `^(?:${escapedPeers.join("|")})(?:/.*)?$`,
);

export const optionalWalletPeerStubPlugin: Plugin = {
  name: "optional-wallet-peer-stub",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: optionalWalletPeerPattern }, (args) => ({
      path: args.path,
      namespace: "optional-wallet-peer-stub",
    }));
    pluginBuild.onLoad(
      { filter: /.*/, namespace: "optional-wallet-peer-stub" },
      () => ({
        contents: `const inertPeer = {};
export default inertPeer;
export const Porto = { create: () => ({ provider: inertPeer }) };
export const RpcSchema = { wallet_connect: { Capabilities: inertPeer } };
export const z = { encode: (_schema, value) => value };`,
        loader: "js",
      }),
    );
  },
};
