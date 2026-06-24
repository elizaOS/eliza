// Vite's optimized-deps cache flattens scoped package names by replacing `/`
// with `_` (for example `@solana/wallet-adapter-react-ui` becomes
// `@solana_wallet-adapter-react-ui.js`). Keep those flattened wallet deps in
// the same lazy crypto chunk too; otherwise Rollup can emit an eager helper
// chunk named after `useWalletModal` and put the bn.js graph there.
export const VENDOR_OPTIMIZED_WALLET_TEST =
  /\/node_modules\/\.vite\/deps\/(?:@solana_[^/]*|@wagmi_[^/]*|@rainbow-me_[^/]*|@walletconnect_[^/]*|@reown_[^/]*|@coinbase_wallet[^/]*|useWalletModal(?:[._-]|$)|wagmi(?:[._-]|$)|viem(?:[._-]|$)|mipd(?:[._-]|$)|eventemitter3(?:[._-]|$)|bn(?:\.js|_js)?(?:[._-]|$)|elliptic(?:[._-]|$)|secp256k1(?:[._-]|$)|buffer(?:[._-]|$)|safe[-_]buffer(?:[._-]|$)|hash[-_]base(?:[._-]|$)|create[-_]hash(?:[._-]|$)|create[-_]hmac(?:[._-]|$)|sha(?:\.js|_js)?(?:[._-]|$))/;
