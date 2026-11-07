/**
 * Browser wallet-connector packages that never belong in a mobile agent bundle.
 *
 * The shared UI's EVM login and crypto-billing views import wagmi, RainbowKit and the
 * MetaMask SDK. A mobile agent paints no UI and its plugin profile never loads a wallet
 * (see test/mobile-wallet-exclusion.test.ts), but the bundler still follows those imports
 * through shared modules and ships the connector closure, including `@metamask/sdk`, whose
 * licence is not open source. The mobile build resolves every such specifier to the
 * `null-plugin` stub instead: importing is inert, named connector exports are absent and any
 * use fails loudly. Desktop, web and server builds are unaffected.
 */
export const MOBILE_WALLET_CONNECTOR_PACKAGES = Object.freeze([
  "wagmi",
  "@wagmi/*",
  "@rainbow-me/*",
  "@metamask/*",
]);

/** Matches a bare specifier (or subpath) of any excluded wallet-connector package. */
export const MOBILE_WALLET_CONNECTOR_FILTER =
  /^(?:wagmi|@wagmi\/[^/]+|@rainbow-me\/[^/]+|@metamask\/[^/]+)(?:\/.*)?$/;

/** A Bun.build plugin resolving wallet-connector imports to `stubPath`. */
export function mobileWalletConnectorStubPlugin(stubPath: string) {
  return {
    name: "eliza-mobile-wallet-connector-stubs",
    setup(build: {
      onResolve(
        options: { filter: RegExp },
        callback: (args: { path: string }) => {
          path: string;
          namespace: string;
        },
      ): void;
    }) {
      build.onResolve({ filter: MOBILE_WALLET_CONNECTOR_FILTER }, () => ({
        path: stubPath,
        namespace: "file",
      }));
    },
  };
}
