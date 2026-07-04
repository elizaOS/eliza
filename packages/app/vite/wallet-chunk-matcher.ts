// Vite's optimized-deps cache flattens scoped package names by replacing `/`
// with `_` (for example `@solana/wallet-adapter-react-ui` becomes
// `@solana_wallet-adapter-react-ui.js`). Rollup can also create virtual/CJS
// facade ids named after wallet entry points such as `useWalletModal`; pin
// those facades into `vendor-crypto` too so the bn.js graph can never land in
// an eager helper chunk named after a wallet entry point.
//
// This matcher must pin ONLY node_modules/facade ids — never first-party
// source. Rollup folds a pinned module's whole dependency subtree into the
// manual chunk (unless a dependency is itself pinned elsewhere), so pinning an
// app component drags the shared UI/core graph the entry needs into
// `vendor-crypto` and forces the entry to statically import the multi-MB
// wallet chunk at boot. `scripts/verify-chunk-safety.mjs` gates both hazards:
// bn.js confinement AND entry-chunk eagerness.
export const VENDOR_OPTIMIZED_WALLET_TEST =
  /(?:\/node_modules\/\.vite\/deps\/(?:@solana_[^/]*|@wagmi_[^/]*|@rainbow-me_[^/]*|@walletconnect_[^/]*|@reown_[^/]*|@coinbase_wallet[^/]*|useWalletModal(?:[._-]|$)|wagmi(?:[._-]|$)|viem(?:[._-]|$)|mipd(?:[._-]|$)|eventemitter3(?:[._-]|$)|bn(?:\.js|_js)?(?:[._-]|$)|elliptic(?:[._-]|$)|secp256k1(?:[._-]|$)|buffer(?:[._-]|$)|safe[-_]buffer(?:[._-]|$)|hash[-_]base(?:[._-]|$)|create[-_]hash(?:[._-]|$)|create[-_]hmac(?:[._-]|$)|sha(?:\.js|_js)?(?:[._-]|$))|(?:^|[\0/])useWalletModal(?:[._?/-]|$))/;
