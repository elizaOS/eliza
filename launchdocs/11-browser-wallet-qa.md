# Launch Readiness 11: Browser And Wallet QA

## Second-Pass Status (2026-05-05)

- Superseded: launchpad dry-run now stops before transaction-triggering steps, and `providerOption` is implemented and tested.
- Still open: no pump.fun launchpad support, Solana cloud signing still depends on local `SOLANA_PRIVATE_KEY`, external browser bridge cannot inject wallet providers, app-browser action schema is not realistic enough for site automation, and transaction previews remain thin.
- Launch gate: fake-wallet tests are useful deterministic coverage; real wallet extension, site login, signature rejection/approval, testnet transaction, and selector-drift checks remain live/manual.

## Current state

Static review says the side-chat browser path can open, navigate, inspect, click, fill, upload, and run desktop-only realistic actions when the desktop browser workspace bridge is configured. The Browser view prompt is explicitly watch-mode oriented and says the agent must narrate each browser action and never auto-sign transactions.

The in-app desktop browser path injects wallet provider shims into `<electrobun-webview>` tabs: `window.ethereum` for EVM dapps and Phantom-shaped `window.solana` / `window.phantom.solana` for Solana dapps. Those provider calls route back to the React host, which shows a consent modal before connecting, signing, or sending. The web iframe path has a postMessage bridge, but normal third-party dapps such as pump.fun or flap.sh will not call that bridge unless they were built for it; the launchpad/browser-wallet path should be treated as desktop-webview-only.

For flap.sh, there is a launchpad profile and action path, but it is not launch-ready because the current dry-run gate fires at `confirmTx`, after the profile's `Launch` click step. That contradicts the engine comment that dry run stops before clicking submit and creates a real risk of triggering a wallet transaction prompt or submission during a supposed dry run.

For pump.fun, there is no launchpad profile or buy flow in the reviewed launchpad code. The desktop webview can expose a Solana-shaped provider, but browser Solana transaction signing is only implemented for a local `SOLANA_PRIVATE_KEY`; cloud/Steward Solana signing is advertised in some state surfaces but has no matching browser transaction route. I would not claim pump.fun buy support from the current code.

Wallet/settings surface has too much launch-irrelevant and potentially misleading material. Raw wallet key management is duplicated in Settings and Vault, arbitrary wallet key names are accepted, Birdeye is shown inside Solana RPC configuration even though it is not a signing/execution dependency, and cloud Solana signing availability can be surfaced even though browser Solana transaction signing only works with a local key.

## Evidence reviewed with file refs

- `packages/app-core/src/components/pages/page-scoped-conversations.ts:112` defines Browser chat copy; `:115-116` tells the agent to use watch mode, prefer realistic browser subactions, narrate before concrete actions, and never auto-sign.
- `plugins/app-browser/src/action.ts:1060-1077` exposes the `MANAGE_ELIZA_BROWSER_WORKSPACE` action; `:1081-1135` enumerates many browser subactions but omits `realistic-click`, `realistic-fill`, and `realistic-upload` even though those are used by launchpad automation.
- `packages/agent/src/services/browser-workspace.ts:152-156` selects desktop mode only when the browser workspace bridge is configured; `:190-245` and `:248-295` open and navigate tabs through web state or desktop bridge; `:398-461` executes normalized browser commands.
- `packages/agent/src/services/browser-workspace-desktop.ts:93-129` makes eval/snapshot desktop-only; `:131-155` starts the desktop command script path. Search evidence shows `realistic-click`, `realistic-fill`, and `realistic-upload` are implemented in this desktop path.
- `packages/app-core/src/components/pages/BrowserWorkspaceView.tsx:774-1083` handles wallet requests from desktop webviews, including EVM connect/accounts/chain/sign/send and Solana connect/sign/send with host consent.
- `packages/app-core/src/components/pages/BrowserWorkspaceView.tsx:2329-2347` renders desktop tabs as `<electrobun-webview>` with `BROWSER_TAB_PRELOAD_SCRIPT`; `:2357-2428` renders web tabs as sandboxed iframes.
- `packages/app-core/src/utils/browser-tabs-renderer-registry.ts:477-488` explains the injected wallet provider shims; `:505-533` sends wallet requests to the host; `:536-595` installs `window.ethereum`; `:596-737` installs the Phantom-shaped Solana provider.
- `packages/app-core/src/components/pages/useBrowserWorkspaceWalletBridge.ts:46-58` validates postMessage origins for web iframe wallet bridge responses; `:82-115` normalizes EVM transaction requests; `:150-199` dispatches EVM and Solana wallet bridge methods; `:201-250` routes Solana transaction requests to the client.
- `packages/app-core/src/components/pages/browser-workspace-wallet.ts:156-175` resolves wallet mode; `:208-225` marks Steward mode EVM signing available and marks Solana transaction signing available when a Solana address exists; `:228-257` marks local signing availability from wallet config.
- `plugins/app-steward/src/routes/wallet-browser-compat-routes.ts:403-406` detects local EVM/Solana private keys; `:442-481` only supports browser Solana message/transaction signing with a local Solana key; `:484-537` supports EVM browser transactions through Steward or local key.
- `packages/agent/src/api/wallet-routes.ts:765-826` returns wallet config/status and sets `solanaSigningAvailable` true when the primary Solana wallet is cloud or a local Solana key exists.
- `packages/agent/src/api/wallet-capability.ts:193-264` computes wallet execution status; `:230-245` can set a cloud-view-only blocked reason, but `:259-260` computes `executionReady` without checking that blocked reason or signer kind.
- `packages/agent/src/actions/launchpad-launch.ts:45-49` only supports `four-meme`, `four-meme:testnet`, `flap-sh`, and `flap-sh:testnet`; `:95-99` describes BNB launchpad automation; `:181-192` runs the selected launchpad profile.
- `packages/agent/src/services/launchpads/profiles/flap-sh.ts:1-20` documents flap.sh as a BNB Chain EVM flow with best-effort selectors; `:25-78` defines the mainnet steps, including `connectWallet`, form fill, image upload, `Launch` click, `confirmTx`, and BscScan wait.
- `packages/agent/src/services/launchpads/launchpad-engine.ts:10-13` says dry run stops before clicking submit; `:95-145` maps launchpad steps to browser commands; `:209-219` actually stops only when it reaches `confirmTx`, after the preceding submit click step has already run.
- `packages/browser-bridge/src/protocol.ts:55-64`, `packages/browser-bridge/src/dom-actions.ts:67-99`, and `packages/browser-bridge/entrypoints/background.ts:582-694` show the external browser extension can open/navigate/click/type/submit/read, but it does not inject Eliza wallet providers.
- `packages/app-core/src/components/pages/ConfigPageView.tsx:196-282` shows RPC/API key settings, including Birdeye inside the Solana RPC provider section.
- `packages/app-core/src/components/settings/WalletKeysSection.tsx:183-225` duplicates local vault wallet-key management in Settings and prompts for env-var private key names; `:283-315` displays arbitrary wallet entries and raw key labels.
- Repository search for `pump.fun`, `pumpfun`, and `pump fun` in app/agent source found no launchpad profile or buy automation for pump.fun. Hits were unrelated streaming/binance-skill references plus a BrowserWorkspaceView test fixture title.

## What I could validate

- Static code path from page-browser side chat to browser workspace commands exists.
- Desktop in-app browser tabs receive EVM and Solana provider shims.
- Desktop wallet calls require host-side consent before EVM connect/sign/send and Solana connect/sign/send.
- EVM browser transactions can be sent through Steward when Steward is configured, or through a local EVM key when present.
- flap.sh has a BNB/EVM launchpad profile and is plausibly wired to the desktop browser wallet flow, subject to live selector QA and the dry-run blocker below.
- The external browser bridge can drive an already-open real browser profile for navigation/click/type/read operations, but it does not make the Eliza wallet available to third-party dapps.
- I attempted a targeted test command:
  `bun test packages/app-core/src/utils/browser-tab-kit.test.ts packages/app-core/src/components/pages/browser-wallet-consent-format.test.ts packages/browser-bridge/src/browser-bridge-runtime.test.ts packages/agent/src/services/launchpads/launchpad-engine.test.ts packages/agent/src/actions/launchpad-launch.test.ts`
  It failed under direct `bun test` because suites expect Vitest/jsdom helpers such as `vi.stubGlobal`, `vi.mocked`, and `document`. I did not treat this as product validation.

## What I could not validate

- I did not perform real site login, wallet login, wallet connection, funding, signing, or purchases.
- I did not run the desktop app against live pump.fun or flap.sh.
- I could not validate flap.sh selectors, file upload behavior, wallet picker behavior, network switching, or BscScan confirmation polling against the live site.
- I could not validate pump.fun at all as a launch target because no pump.fun launchpad profile exists in the reviewed automation.
- I could not validate real Steward/cloud wallet availability, balances, RPC credentials, or site-specific anti-bot/login gates in this environment.

## Bugs/risks P0-P3

### P0

- `packages/agent/src/services/launchpads/launchpad-engine.ts:209-219` makes `dryRun: "stop-before-tx"` stop at the `confirmTx` step, but `packages/agent/src/services/launchpads/profiles/flap-sh.ts:67-71` clicks `Launch` before that. A dry run can therefore perform the submit click before stopping. This must be fixed before any human tests with funded wallets or real launchpad accounts.

### P1

- No pump.fun buy path exists. `packages/agent/src/actions/launchpad-launch.ts:45-49` supports only four.meme and flap.sh. Current code cannot honestly claim side chat can buy a token on pump.fun.
- Browser Solana signing state is misleading. `packages/app-core/src/components/pages/browser-workspace-wallet.ts:208-225` and `packages/agent/src/api/wallet-routes.ts:823-825` can advertise Solana transaction signing from Steward/cloud state, but `plugins/app-steward/src/routes/wallet-browser-compat-routes.ts:459-481` only signs browser Solana transactions with local `SOLANA_PRIVATE_KEY`.
- External browser bridge cannot expose the Eliza wallet to sites. It can drive a Chrome/Safari profile, but `packages/browser-bridge/src/protocol.ts:55-64` and `packages/browser-bridge/src/dom-actions.ts:67-99` only cover basic DOM actions. Any dapp buy flow through that bridge depends on a separate wallet extension already installed and logged in.
- Launchpad wallet picker support is incomplete. `LaunchpadStep` has `providerOption`, but `packages/agent/src/services/launchpads/launchpad-engine.ts:112-117` ignores it and only clicks the connect button. Sites that require choosing Eliza/MetaMask/Phantom can stall.

### P2

- Transaction consent is too thin for token-buy flows. `packages/app-core/src/components/pages/BrowserWorkspaceView.tsx:932-935` shows from/to/value/chain, and Solana consent at `:1054-1057` shows even less. It does not decode calldata, spender, token, mint, slippage, route, or launch contract method.
- Web iframe mode is not sufficient for third-party dapps. `packages/app-core/src/components/pages/BrowserWorkspaceView.tsx:2357-2428` renders sandboxed iframes and posts readiness, but normal dapps will look for injected providers and many launchpad pages will block framing.
- `packages/agent/src/api/wallet-capability.ts:259-260` can report `executionReady` without checking the `cloud-view-only` signer block computed at `:230-245`, which can make settings/status overstate readiness.
- The Solana shim is best-effort. `packages/app-core/src/utils/browser-tabs-renderer-registry.ts:603-610` throws on `publicKey.toBytes`, and `:714-721` returns signed transaction bytes rather than a transaction object. Some Solana dapps may expect Phantom-compatible object behavior.
- Browser action schema and prompt are inconsistent with launchpad automation. The page prompt recommends realistic subactions and the engine uses them, but `plugins/app-browser/src/action.ts:1081-1135` omits them from the public action enum.

### P3

- Wallet settings should hide or demote launch-irrelevant configuration. `packages/app-core/src/components/pages/ConfigPageView.tsx:265-282` places Birdeye next to Solana RPC configuration even though it is not required for browser wallet signing.
- `packages/app-core/src/components/settings/WalletKeysSection.tsx:183-225` duplicates Vault private-key management and encourages raw env-var key names in Settings. For launch QA, this should be hidden behind an advanced local-key section or removed from the default wallet setup surface.
- Arbitrary wallet key entries in `WalletKeysSection` can confuse readiness. Only supported execution keys such as `EVM_PRIVATE_KEY` and `SOLANA_PRIVATE_KEY` should be surfaced in the launch path, with per-agent/raw vault entries hidden by default.
- `packages/agent/src/services/launchpads/launchpad-types.ts` contains stale/misleading comments saying flap.sh is on Solana while the profile and action correctly treat flap.sh as BNB/EVM.

## Codex-fixable work

- Move the dry-run safety gate before any transaction-triggering click. Prefer an explicit step flag such as `triggersTransaction: true`, or split submit into `prepareSubmit` and `submitTx` so dry run stops before the submit command.
- Add unit coverage proving `dryRun: "stop-before-tx"` does not dispatch the `Launch` click for flap.sh/four.meme profiles.
- Implement `providerOption` handling after `connectWallet`, or remove it from profiles/types until supported.
- Add a pump.fun profile only after deciding the supported wallet path: local Solana key, real Phantom extension in external browser, or a real Steward/cloud Solana signer route.
- Hide cloud/Steward Solana transaction signing availability until `/api/wallet/browser-solana-transaction` can actually sign through that path.
- Decode and display transaction previews for EVM calldata and Solana instructions before consent.
- Add `realistic-click`, `realistic-fill`, `realistic-type`, `realistic-press`, and `realistic-upload` to the app-browser action schema if the agent is expected to call them directly.
- Move Birdeye, raw private-key entry, arbitrary wallet keys, and per-agent vault wallet entries out of the default launch wallet settings path.
- Fix misleading flap.sh/Solana comments and any settings copy that implies cloud Solana signing works for browser dapps.

## Human wallet/funds/site-login QA needed

- Verify flap.sh in desktop-webview mode with a funded throwaway BNB test wallet first, then a tiny mainnet budget only after dry-run is fixed.
- Confirm whether flap.sh requires account login, captcha, wallet picker selection, network switch, token image upload restrictions, or terms acceptance.
- Confirm the Eliza EIP-6963 provider appears in flap.sh wallet picker and that the site accepts the injected provider.
- Confirm Steward approval sheet displays enough information for a human to reject unexpected contract calls.
- Verify BNB chain id switching, gas estimation, failure handling, and BscScan/testnet BscScan confirmation detection.
- Decide pump.fun wallet strategy and QA it separately. If using external browser bridge, install/login a real Phantom-compatible wallet in that profile. If using Eliza desktop webview, validate the Solana shim against pump.fun before any funded test.
- Use fresh throwaway wallets, tiny balances, and testnet/devnet where available. Do not use production funds until selectors, prompts, and safety gates pass.

## Suggested safety gates

- Disable real launchpad submission unless the dry-run pre-submit gate has passing tests.
- Default launchpad action requests to testnet or dry-run; require an explicit mainnet flag with a per-run spend cap.
- Require a final human confirmation that shows site, chain, wallet address, token name/symbol, contract/mint, value, estimated fees, decoded method/instructions, recipient/spender, and slippage.
- Add per-domain wallet permissions scoped by protocol and chain; do not let an EVM connect approval silently authorize Solana or another chain on the same hostname.
- Block unknown chains and unknown launch contracts by default; allow only reviewed flap.sh/four.meme contracts until pump.fun support is implemented and reviewed.
- Never auto-approve wallet popups or Steward requests from side chat. The agent can prepare and narrate; the human must click the wallet approval.
- Stop on login/captcha/terms/funding/insufficient-balance states and ask the human to handle them.
- Record a transaction audit event before sending and after confirmation/failure, including the decoded preview shown to the user.

## Changed paths

- `launchdocs/11-browser-wallet-qa.md`
