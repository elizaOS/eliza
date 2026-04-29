/**
 * four.meme — BNB Chain memecoin launchpad profile.
 *
 * Selectors are best-effort first cuts and need to be tuned against the
 * live site during smoke testing. The launchpad UI changes; if a step
 * fails on a "not found" error the profile is the right place to update.
 */

import type { LaunchpadProfile } from "../launchpad-types.js";

export const fourMemeMainnetProfile: LaunchpadProfile = {
  id: "four-meme:mainnet",
  displayName: "four.meme",
  chain: "evm",
  entryUrl: "https://four.meme/create-token",
  network: { evmChainId: 56 },
  steps: [
    { kind: "navigate", url: "https://four.meme/create-token" },
    {
      kind: "waitFor",
      selector: "input[name='name'], input[placeholder*='Name' i]",
      timeoutMs: 12_000,
    },
    {
      kind: "connectWallet",
      chain: "evm",
      connectButton: "button:has-text('Connect Wallet'), [data-testid='connect-wallet']",
      providerOption: "[data-wallet='metamask']",
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
      selector: "input[name='symbol'], input[placeholder*='Symbol' i]",
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

export const fourMemeTestnetProfile: LaunchpadProfile = {
  ...fourMemeMainnetProfile,
  id: "four-meme:testnet",
  entryUrl: "https://test.four.meme/create-token",
  network: { evmChainId: 97 },
  steps: fourMemeMainnetProfile.steps.map((step) =>
    step.kind === "navigate"
      ? { ...step, url: "https://test.four.meme/create-token" }
      : step.kind === "awaitTxResult"
        ? { ...step, explorerUrlPattern: "testnet.bscscan.com" }
        : step,
  ),
};
