// Vite's optimized-deps cache flattens scoped package names by replacing `/`
// with `_` (for example `@solana/wallet-adapter-react-ui` becomes
// `@solana_wallet-adapter-react-ui.js`). Rollup can also create virtual/CJS
// facade ids named after wallet entry points such as `useWalletModal`. The
// direct crypto billing card imports both the Solana modal and EVM wallet stack,
// so pin that route-local component with the same graph as well. Otherwise
// Rollup can emit an eager helper chunk named after `useWalletModal` and put the
// bn.js graph there.
export const VENDOR_OPTIMIZED_WALLET_TEST =
  /(?:\/node_modules\/\.vite\/deps\/(?:@solana_[^/]*|@wagmi_[^/]*|@rainbow-me_[^/]*|@walletconnect_[^/]*|@reown_[^/]*|@coinbase_wallet[^/]*|useWalletModal(?:[._-]|$)|wagmi(?:[._-]|$)|viem(?:[._-]|$)|mipd(?:[._-]|$)|eventemitter3(?:[._-]|$)|bn(?:\.js|_js)?(?:[._-]|$)|elliptic(?:[._-]|$)|secp256k1(?:[._-]|$)|buffer(?:[._-]|$)|safe[-_]buffer(?:[._-]|$)|hash[-_]base(?:[._-]|$)|create[-_]hash(?:[._-]|$)|create[-_]hmac(?:[._-]|$)|sha(?:\.js|_js)?(?:[._-]|$))|(?:^|[\0/])useWalletModal(?:[._?/-]|$)|\/packages\/ui\/src\/cloud\/billing\/components\/direct-crypto-credit-card\.tsx(?:[?/-]|$))/;
