/**
 * flap.sh — BNB Chain memecoin launchpad profile.
 *
 * Under the hood, flap.sh's web UI builds a `newTokenV6(NewTokenV6Params)`
 * call against the Portal contract and sends it via the user's connected
 * wallet. Docs:
 *   https://docs.flap.sh/flap/developers/token-launcher-developers
 *
 * Deployed Portals (per docs/deployed-contract-addresses):
 *   - BNB mainnet (chain 56):  Portal 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0
 *   - BNB testnet (chain 97):  Portal 0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9
 *
 * Because the launch terminates in a standard EVM `eth_sendTransaction`
 * sent through `window.ethereum`, our existing browser-wallet bridge +
 * steward sign path handles this without any Solana plumbing — the user
 * confirms the tx in the steward approval sheet exactly like four.meme.
 *
 * Selectors below are best-effort first cuts and need to be tuned against
 * the live site at smoke time. flap.sh's UI changes; if a step fails on
 * "not found" this is the right place to update.
 */

import type { LaunchpadProfile } from "../launchpad-types.js";

export const flapShMainnetProfile: LaunchpadProfile = {
  id: "flap-sh:mainnet",
  displayName: "flap.sh",
  chain: "evm",
  entryUrl: "https://flap.sh/create",
  network: { evmChainId: 56 },
  steps: [
    { kind: "navigate", url: "https://flap.sh/create" },
    {
      kind: "waitFor",
      selector: "input[name='name'], input[placeholder*='Name' i]",
      timeoutMs: 12_000,
    },
    {
      kind: "connectWallet",
      chain: "evm",
      connectButton:
        "button:has-text('Connect Wallet'), button:has-text('Connect'), [data-testid='connect-wallet']",
      narration: "Connecting BSC wallet",
    },
    {
      kind: "fillField",
      field: "name",
      selector: "input[name='name'], input[placeholder*='Name' i]",
    },
    {
      kind: "fillField",
      field: "symbol",
      selector:
        "input[name='symbol'], input[name='ticker'], input[placeholder*='Symbol' i], input[placeholder*='Ticker' i]",
    },
    {
      kind: "fillField",
      field: "description",
      selector: "textarea[name='description'], textarea[placeholder*='Description' i]",
    },
    {
      kind: "uploadImage",
      selector: "input[type='file']",
    },
    {
      kind: "click",
      text: "Launch",
      narration: "Submitting — please confirm in your wallet",
    },
    { kind: "confirmTx", chain: "evm" },
    {
      kind: "awaitTxResult",
      explorerUrlPattern: "bscscan.com",
      timeoutMs: 90_000,
    },
  ],
};

export const flapShTestnetProfile: LaunchpadProfile = {
  ...flapShMainnetProfile,
  id: "flap-sh:testnet",
  network: { evmChainId: 97 },
  steps: flapShMainnetProfile.steps.map((step) =>
    step.kind === "awaitTxResult"
      ? { ...step, explorerUrlPattern: "testnet.bscscan.com" }
      : step,
  ),
};
