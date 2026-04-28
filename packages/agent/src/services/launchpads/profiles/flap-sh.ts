/**
 * flap.sh — Solana memecoin launchpad profile.
 *
 * Selectors are best-effort first cuts and need to be tuned against the
 * live site during smoke testing. flap.sh's UI changes; if a step fails
 * on "not found" the profile is the right place to update.
 *
 * Solana cluster gating: flap.sh's mainnet UI lives at https://flap.sh.
 * If the site lacks an in-UI cluster toggle, dryRun: "stop-before-tx"
 * lets us exercise the full flow against mainnet without submitting.
 */

import type { LaunchpadProfile } from "../launchpad-types.js";

export const flapShMainnetProfile: LaunchpadProfile = {
  id: "flap-sh:mainnet",
  displayName: "flap.sh",
  chain: "solana",
  entryUrl: "https://flap.sh/create",
  network: { solanaCluster: "mainnet" },
  steps: [
    { kind: "navigate", url: "https://flap.sh/create" },
    {
      kind: "waitFor",
      selector: "input[name='name'], input[placeholder*='Name' i]",
      timeoutMs: 12_000,
    },
    {
      kind: "connectWallet",
      chain: "solana",
      connectButton:
        "button:has-text('Connect Wallet'), button:has-text('Select Wallet'), [data-testid='connect-wallet']",
      narration: "Connecting Solana wallet",
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
    { kind: "confirmTx", chain: "solana" },
    {
      kind: "awaitTxResult",
      explorerUrlPattern: "solscan.io",
      timeoutMs: 90_000,
    },
  ],
};

export const flapShDevnetProfile: LaunchpadProfile = {
  ...flapShMainnetProfile,
  id: "flap-sh:devnet",
  network: { solanaCluster: "devnet" },
  // No public devnet host is documented. Smoke tests should run this
  // profile with dryRun: "stop-before-tx" to exercise everything except
  // the live submission.
};
