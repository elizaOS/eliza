# Launch Readiness 05: Settings QA

## Second-Pass Status (2026-05-05)

- Superseded: the earlier P1 findings for existing API key redisplay, streaming permission filtering, and custom RPC mode are fixed or narrowed by current code.
- Still open: cloud API keys are still stored as plaintext despite hash-oriented schema comments, cloud API create/delete UI can leave loading state stuck on thrown errors, subscription disconnect remains hidden, and a settings connector deep link targets a missing `integrations` section.
- Launch gate: keep the cloud API key redaction contract and settings/component tests in the focused launch suite; add cloud UI error-path tests before calling settings fully verified.

## Current state

The app has a unified in-app Settings shell with a responsive sidebar and these sections: Basics, Providers, Runtime, Appearance, Capabilities, Apps, Wallet & RPC, Permissions, Vault, Security, Updates, and Backup & Reset. Wallet & RPC is hidden when the wallet capability is disabled, and Runtime is shown only for the ElizaOS build variant.

Cloud dashboard settings are a separate tabbed surface with desktop tabs and a mobile select: General, Account, Connections, Usage, Billing, APIs, Analytics, and Organization.

I found no P0 issue, but I found three launch-blocking or near-launch-blocking P1 risks: cloud API keys are redisplayed/copied after creation, web/mobile streaming permission filtering is inverted, and Wallet & RPC custom mode can appear custom while saving Eliza Cloud selections.

## Evidence reviewed with file refs

- Settings shell and section composition: `packages/app-core/src/components/pages/SettingsView.tsx:118`, `packages/app-core/src/components/pages/SettingsView.tsx:227`, `packages/app-core/src/components/pages/SettingsView.tsx:687`, `packages/app-core/src/components/pages/SettingsView.tsx:981`.
- Settings connector focus/deep-link logic: `packages/app-core/src/components/pages/SettingsView.tsx:755`, `packages/app-core/src/components/pages/SettingsView.tsx:775`.
- Basics: name, system prompt, voice load/save/preview: `packages/app-core/src/components/pages/settings/IdentitySettingsSection.tsx:112`.
- Providers/model settings: `packages/app-core/src/components/settings/ProviderSwitcher.tsx:254`, `packages/app-core/src/components/settings/ProviderSwitcher.tsx:629`, `packages/app-core/src/components/settings/ProviderSwitcher.tsx:654`, `packages/app-core/src/components/settings/ProviderSwitcher.tsx:699`, `packages/app-core/src/components/settings/ProviderSwitcher.tsx:850`, `packages/app-core/src/components/settings/ProviderSwitcher.tsx:940`.
- Direct provider API key settings: `packages/app-core/src/components/settings/ApiKeyConfig.tsx:75`, `packages/app-core/src/components/settings/ApiKeyConfig.tsx:84`, `packages/app-core/src/components/settings/ApiKeyConfig.tsx:227`.
- Subscription provider settings: `packages/app-core/src/components/settings/SubscriptionStatus.tsx:287`, `packages/app-core/src/components/settings/SubscriptionStatus.tsx:570`, `packages/app-core/src/components/settings/SubscriptionStatus.tsx:645`.
- Local inference settings: `packages/app-core/src/components/local-inference/LocalInferencePanel.tsx:29`, `packages/app-core/src/components/local-inference/LocalInferencePanel.tsx:139`, `packages/app-core/src/components/local-inference/LocalInferencePanel.tsx:168`, `packages/app-core/src/components/local-inference/LocalInferencePanel.tsx:323`.
- Runtime settings: `packages/app-core/src/components/pages/settings/RuntimeSettingsSection.tsx:24`, `packages/app-core/test/components/pages/runtime-settings-section.test.ts:93`.
- Appearance settings: `packages/app-core/src/components/settings/AppearanceSettingsSection.tsx:27`, `packages/app-core/src/components/settings/AppearanceSettingsSection.tsx:220`, `packages/app-core/src/components/settings/AppearanceSettingsSection.tsx:280`, `packages/app-core/src/components/settings/AppearanceSettingsSection.tsx:425`.
- Capabilities settings: `packages/app-core/src/components/settings/CapabilitiesSection.tsx:22`, `packages/app-core/src/components/settings/CapabilitiesSection.tsx:93`, `packages/app-core/src/components/settings/CapabilitiesSection.tsx:146`.
- Apps settings: `packages/app-core/src/components/settings/AppsManagementSection.tsx:52`, `packages/app-core/src/components/settings/AppsManagementSection.tsx:117`, `packages/app-core/src/components/settings/AppsManagementSection.tsx:234`.
- Wallet keys and Wallet & RPC settings: `packages/app-core/src/components/settings/WalletKeysSection.tsx:63`, `packages/app-core/src/components/pages/ConfigPageView.tsx:126`, `packages/app-core/src/components/pages/ConfigPageView.tsx:137`, `packages/app-core/src/components/pages/config-page-sections.tsx:158`, `packages/app-core/src/components/pages/config-page-sections.tsx:347`.
- Wallet backend routes/resolution: `packages/agent/src/api/wallet-routes.ts:66`, `packages/agent/src/api/wallet-routes.ts:207`, `packages/agent/src/api/wallet-rpc.ts:116`, `packages/agent/src/api/wallet-rpc.ts:217`.
- Permissions settings: `packages/app-core/src/components/settings/PermissionsSection.tsx:137`, `packages/app-core/src/components/settings/PermissionsSection.tsx:237`, `packages/app-core/src/components/settings/PermissionsSection.tsx:315`, `packages/app-core/src/components/settings/PermissionsSection.tsx:428`.
- Streaming permissions: `packages/app-core/src/components/permissions/StreamingPermissions.tsx:32`, `packages/app-core/src/components/permissions/StreamingPermissions.tsx:97`, `packages/app-core/src/components/permissions/StreamingPermissions.tsx:334`, `packages/app-core/src/components/permissions/StreamingPermissions.tsx:469`.
- Permission contracts/runtime routes: `packages/shared/src/contracts/permissions.ts:5`, `packages/agent/src/api/permissions-routes.ts:91`, `packages/app-core/src/components/settings/permission-controls.tsx:34`, `packages/app-core/src/platform/desktop-permissions-client.ts:15`.
- Vault settings: `packages/app-core/src/components/settings/SecretsManagerSection.tsx:89`, `packages/app-core/src/components/settings/SecretsManagerSection.tsx:157`, `packages/app-core/src/components/settings/SecretsManagerSection.tsx:238`.
- Security settings: `packages/app-core/src/components/settings/SecuritySettingsSection.tsx:249`, `packages/app-core/src/components/settings/SecuritySettingsSection.tsx:427`, `packages/app-core/src/components/settings/SecuritySettingsSection.tsx:594`, `packages/app-core/src/components/settings/SecuritySettingsSection.tsx:834`.
- Updates and Backup & Reset: `packages/app-core/src/components/pages/ReleaseCenterView.tsx:126`, `packages/app-core/src/components/pages/ReleaseCenterView.tsx:276`, `packages/app-core/src/components/pages/SettingsView.tsx:306`, `packages/app-core/src/components/pages/SettingsView.tsx:365`, `packages/app-core/src/components/pages/SettingsView.tsx:435`.
- Cloud settings shell/tabs: `cloud/packages/ui/src/components/settings/settings-page-client.tsx:30`, `cloud/packages/ui/src/components/settings/settings-tabs.tsx:23`, `cloud/packages/ui/src/components/settings/settings-tabs.tsx:50`.
- Cloud General/Account/Billing/APIs/Connections: `cloud/packages/ui/src/components/settings/tabs/general-tab.tsx:42`, `cloud/packages/ui/src/components/settings/tabs/account-tab.tsx:39`, `cloud/packages/ui/src/components/settings/tabs/billing-tab.tsx:50`, `cloud/packages/ui/src/components/settings/tabs/apis-tab.tsx:58`, `cloud/packages/ui/src/components/settings/tabs/connections-tab.tsx:12`.
- Cloud API key API/storage: `cloud/packages/db/schemas/api-keys.ts:16`, `cloud/packages/db/schemas/api-keys.ts:28`, `cloud/packages/db/repositories/api-keys.ts:82`, `cloud/packages/lib/services/api-keys.ts:168`, `cloud/apps/api/v1/api-keys/route.ts:23`, `cloud/packages/lib/client/api-keys.ts:5`.
- Cloud connection components sampled: `cloud/packages/ui/src/components/settings/google-connection.tsx:34`, `cloud/packages/ui/src/components/settings/discord-gateway-connection.tsx:122`, `cloud/packages/ui/src/components/settings/telegram-connection.tsx:46`.

## What I could validate

- Targeted app-core tests passed:
  - Command: `bun run --cwd packages/app-core test -- test/components/pages/runtime-settings-section.test.ts src/components/pages/ConfigPageView.test.tsx src/components/settings/ProviderSwitcher.test.tsx src/components/settings/WalletKeysSection.test.tsx src/components/settings/SecuritySettingsSection.test.tsx src/components/settings/CapabilitiesSection.test.tsx src/components/settings/permission-types.test.ts src/state/useWalletState.test.tsx src/services/local-inference/providers.test.ts src/runtime/mobile-local-inference-gate.test.ts`
  - Result: 10 files passed, 57 tests passed.
- Targeted cloud API-key unit test passed:
  - Command: `SKIP_DB_DEPENDENT=1 SKIP_SERVER_CHECK=true bun test --preload ./packages/tests/load-env.ts packages/tests/unit/api-keys-cache-validation.test.ts`
  - Result: 1 test passed.
- Runtime switch helper clears persisted runtime state and navigates to `?runtime=picker`.
- ProviderSwitcher has coverage for provider list rendering, local provider panel, direct API provider use from local-only mode, and local embeddings toggle.
- Wallet keys panel has coverage for wallet-filtered inventory load, empty/error states, and reveal endpoint.
- Security settings have coverage for session list, revoke session, remote password setup/change prerequisites, and access/API base display.
- Wallet state has coverage for cloud wallet refresh after Eliza Cloud RPC save, warnings, primary switching, and local/cloud wallet provisioning.
- Static code review confirms settings wiring to the expected backend routes for permissions, wallet/RPC, vault, apps, security, updates, cloud billing, cloud API keys, and cloud connections.

## What I could not validate

- I did not run a live desktop app or browser session, so I could not manually click through settings, capture screenshots, or verify layout at desktop/mobile breakpoints.
- I did not validate native OS permission prompts for macOS, Windows, Linux, iOS, or Android.
- I did not validate real OAuth flows for Anthropic, OpenAI, Google, Microsoft, Discord, Telegram, Twilio, Blooio/iMessage, or WhatsApp.
- I did not validate Stripe checkout, crypto checkout, invoices, auto-top-up, or pay-as-you-go billing against live services.
- I did not validate local inference downloads, hardware detection, EventSource progress, activation, verification, uninstall, or routing assignments against real model files.
- I did not validate real cloud wallet provisioning, wallet balances, cloud login, custom RPC credentials, or primary-wallet switching against live chain/RPC services.
- I did not validate updater IPC against a packaged desktop build.

## Bugs/risks P0-P3

### P0

- None found.

### P1

- Cloud Settings -> APIs redisplays and copies full secret API keys after creation. The DB schema stores a plaintext `key` column even though the schema comment says keys are hashed, the list route returns `apiKeysService.listByOrganization(...)` directly, the client type includes `key`, and the tab copy buttons copy `apiKey.key`. This contradicts the modal warning that the newly created key is shown only once. Evidence: `cloud/packages/db/schemas/api-keys.ts:16`, `cloud/packages/db/schemas/api-keys.ts:28`, `cloud/apps/api/v1/api-keys/route.ts:23`, `cloud/packages/lib/client/api-keys.ts:5`, `cloud/packages/lib/client/api-keys.ts:38`, `cloud/packages/ui/src/components/settings/tabs/apis-tab.tsx:410`, `cloud/packages/ui/src/components/settings/tabs/apis-tab.tsx:563`.
- Web/mobile streaming permission filtering is inverted. `screen` is marked `modes: ["web"]`, but both settings and onboarding render `MEDIA_PERMISSIONS.filter((def) => !def.modes?.includes(mode))`. Result: web hides the screen permission and mobile shows the screen permission. Evidence: `packages/app-core/src/components/permissions/StreamingPermissions.tsx:50`, `packages/app-core/src/components/permissions/StreamingPermissions.tsx:334`, `packages/app-core/src/components/permissions/StreamingPermissions.tsx:469`.
- Wallet & RPC custom mode can show custom providers while saving underlying Eliza Cloud selections. Switching from cloud to custom only updates `rpcMode`; it does not change `selectedEvmRpc`, `selectedBscRpc`, or `selectedSolanaRpc`. The render path masks `"eliza-cloud"` as the first non-cloud option, but save uses the unmasked selected values. Evidence: `packages/app-core/src/components/pages/ConfigPageView.tsx:126`, `packages/app-core/src/components/pages/ConfigPageView.tsx:137`, `packages/app-core/src/components/pages/ConfigPageView.tsx:534`, `packages/app-core/src/components/pages/ConfigPageView.tsx:555`, `packages/app-core/src/components/pages/ConfigPageView.tsx:576`.

### P2

- Subscription disconnect is implemented but hidden for both Anthropic and OpenAI. `SubscriptionProviderPanel` shows Disconnect only when `connected && canDisconnect`, and the parent passes `canDisconnect={false}` unconditionally for Anthropic and OpenAI. Evidence: `packages/app-core/src/components/settings/SubscriptionStatus.tsx:150`, `packages/app-core/src/components/settings/SubscriptionStatus.tsx:287`, `packages/app-core/src/components/settings/SubscriptionStatus.tsx:576`, `packages/app-core/src/components/settings/SubscriptionStatus.tsx:649`.
- Cloud Settings -> APIs create/delete handlers can leave buttons stuck loading on API or network errors. `handleCreateSubmit` and `handleConfirmDelete` throw without local catch/finally, so `creating` or `deletingKeyId` may never reset. Evidence: `cloud/packages/ui/src/components/settings/tabs/apis-tab.tsx:114`, `cloud/packages/ui/src/components/settings/tabs/apis-tab.tsx:120`, `cloud/packages/ui/src/components/settings/tabs/apis-tab.tsx:132`, `cloud/packages/ui/src/components/settings/tabs/apis-tab.tsx:175`, `cloud/packages/ui/src/components/settings/tabs/apis-tab.tsx:180`, `cloud/packages/ui/src/components/settings/tabs/apis-tab.tsx:186`.
- Settings connector deep links target a nonexistent `integrations` section. The section list has `secrets` but no `integrations`, while `focusProvider()` sets and aligns `"integrations"`. Evidence: `packages/app-core/src/components/pages/SettingsView.tsx:118`, `packages/app-core/src/components/pages/SettingsView.tsx:186`, `packages/app-core/src/components/pages/SettingsView.tsx:755`, `packages/app-core/src/components/pages/SettingsView.tsx:776`.

### P3

- Direct desktop permission hook runtime IDs omit `location`, while the shared contract and desktop client patch include it. This can make location depend on the patched client path and increases risk of stale/non-requestable location rows in other render paths. Evidence: `packages/shared/src/contracts/permissions.ts:5`, `packages/app-core/src/components/settings/permission-controls.tsx:34`, `packages/app-core/src/platform/desktop-permissions-client.ts:15`.
- Cloud settings tabs read `?tab=` on load, but clicking desktop tabs or mobile select only updates component state. Back/forward/shareable tab URLs do not track user tab changes. Evidence: `cloud/packages/ui/src/components/settings/settings-page-client.tsx:31`, `cloud/packages/ui/src/components/settings/settings-tabs.tsx:52`, `cloud/packages/ui/src/components/settings/settings-tabs.tsx:93`.
- Cloud General settings save has no local catch/finally. A failed PATCH throws and can leave the button in Saving state without a toast. Evidence: `cloud/packages/ui/src/components/settings/tabs/general-tab.tsx:57`, `cloud/packages/ui/src/components/settings/tabs/general-tab.tsx:76`, `cloud/packages/ui/src/components/settings/tabs/general-tab.tsx:82`.
- Cloud Billing card checkout path does not wrap the card fetch in try/finally, unlike the crypto path. A network exception can leave Redirecting active. Evidence: `cloud/packages/ui/src/components/settings/tabs/billing-tab.tsx:99`, `cloud/packages/ui/src/components/settings/tabs/billing-tab.tsx:150`, `cloud/packages/ui/src/components/settings/tabs/billing-tab.tsx:175`.
- Appearance content-pack URLs allow plain `http:`. That may be acceptable for local/dev packs, but for launch it is a weaker default than HTTPS-only plus localhost exception. Evidence: `packages/app-core/src/components/settings/AppearanceSettingsSection.tsx:27`.
- Cloud Services toggles mark "Restart required" but do not offer an inline restart action. Users can save cloud service routing and miss that settings are not active yet. Evidence: `packages/app-core/src/components/pages/config-page-sections.tsx:347`, `packages/app-core/src/components/pages/config-page-sections.tsx:373`.

## Low-risk fixes Codex can do

- Sanitize Cloud API-key list responses to omit plaintext `key`; update `ClientApiKey` and the UI to copy only `plainKey` from create responses. The DB plaintext column removal is higher-risk and should be reviewed separately.
- Fix streaming permission filtering to include definitions with no `modes` or definitions whose `modes` include the current mode; add web/mobile tests that assert screen is web-only.
- In Wallet & RPC, when switching to custom mode from all-cloud selections, set each selected provider to the first non-cloud option or restore the last custom selection; add a regression test that clicks Custom RPC then Save.
- Wire subscription `canDisconnect` from credential source: allow app/setup-token-owned credentials, keep CLI-owned credentials read-only.
- Add try/catch/finally to cloud API key create/delete, General save, and Billing card checkout handlers.
- Change settings connector focus target from `integrations` to the real section that owns connector/vault UI, or add an actual `integrations` section.
- Add `location` to `RUNTIME_PERMISSION_IDS` in `permission-controls.tsx` or centralize runtime permission IDs.
- Update cloud settings tab clicks to write `?tab=` via `useSearchParams`/navigation.
- Restrict content-pack remote URLs to `https:` except loopback/local development origins if launch policy requires it.
- Add an inline Restart button next to Cloud Services "Restart required" if the underlying client restart path is available.

## Human/manual QA needed

- Desktop permissions on macOS: Accessibility, Screen Recording, Microphone, Camera, Shell toggle, Website Blocking, Location, Allow All, Refresh, and per-row Open Settings.
- Desktop permissions on Windows and Linux: advisory/privacy flows, unavailable states, shell behavior, and capability locks.
- Web permissions: camera, microphone, and screen grant/deny flows after the filter fix.
- iOS and Android permissions: camera/microphone prompts, unsupported screen sharing behavior, website/app blocker cards, and ElizaOS runtime picker.
- Providers: Eliza Cloud provider selection, direct API key save/reveal/fetch models, Anthropic setup token, Anthropic OAuth, OpenAI OAuth callback paste, disconnect after fix, and agent restart behavior.
- Local inference: hardware badge, device bridge status, curated/search/download tabs, download/cancel, activate/unload, verify/redownload/uninstall, slot assignments, device selection, external scans, and SSE reconnect behavior.
- Wallet & RPC: wallet capability hidden/shown, add/reveal/hide/delete wallet keys, cloud wallet import, custom RPC provider save, cloud services toggles, balance fetch, primary wallet switching, and live RPC readiness.
- Cloud dashboard settings: General profile save/toggles, Account stats/logout/copy org ID, Usage/Billing/Analytics tab navigation, Billing card/crypto/auto-top-up/pay-as-you-go/invoices, API key create/copy/delete after API-key response hardening, and all Connections connect/disconnect/setup instructions.
- Responsive QA: app settings sidebar collapse/expand, mobile settings section switcher, cloud settings mobile select, long labels, narrow wallet/provider panels, and modal overflow.
- Updates and Backup & Reset: packaged desktop update check/apply IPC, update refresh, export/import password flows, include logs, file chooser, reset confirmation, and restart/local state recovery.

## Button-by-button checklist

| Surface | Control | Status |
| --- | --- | --- |
| Settings shell | Sidebar section buttons | Code reviewed; scroll/hash behavior present. Needs manual responsive QA. |
| Settings shell | Collapse/expand sidebar | Code reviewed in `SettingsView`; needs manual desktop/mobile QA. |
| Basics | Voice selector | Code reviewed; needs manual save/preview QA. |
| Basics | Preview/Stop voice | Code reviewed; needs audio/cloud voice manual QA. |
| Basics | Save basics | Code reviewed; not covered by targeted tests. |
| Providers | Eliza Cloud provider row | Code reviewed and partially covered by ProviderSwitcher tests. |
| Providers | Local provider row | Covered by ProviderSwitcher test opening local model panel. |
| Providers | Subscription provider rows | Code reviewed; disconnect hidden bug noted. |
| Providers | API-key provider rows | Covered by ProviderSwitcher direct provider test. |
| Providers | Use Eliza Cloud | Code reviewed; calls `client.switchProvider("elizacloud")`. Needs live restart/routing QA. |
| Providers | Use local only | Code reviewed; disables cloud services and restarts. Needs live local mode QA. |
| Providers | Use local embeddings checkbox | Covered by ProviderSwitcher tests. |
| Providers | Cloud model selects | Code reviewed; saves model routing and restarts. Needs live model selection QA. |
| Providers | Advanced model settings disclosure | Code reviewed; no targeted interaction test. |
| Providers | Local model tab buttons Curated/Search/Downloads | Code reviewed; needs live local inference QA. |
| Providers | Download/Cancel/Activate/Unload/Uninstall/Verify/Redownload | Code reviewed; needs live model-file QA. |
| Providers | Local model assignments/devices | Code reviewed; needs live device/routing QA. |
| Direct provider config | Reveal secret | Code reviewed; calls plugin reveal endpoint. Needs manual audit/log QA. |
| Direct provider config | Fetch models | Code reviewed; no targeted test. |
| Direct provider config | Save API key/provider config | Code reviewed; no targeted test. |
| Subscription Anthropic | Setup token tab | Code reviewed; needs live token QA. |
| Subscription Anthropic | OAuth tab/Login/Complete/Start over | Code reviewed; needs live OAuth QA. |
| Subscription OpenAI | Login/Complete/Start over | Code reviewed; needs live OAuth callback QA. |
| Subscription providers | Disconnect | Handler exists, but UI passes `canDisconnect=false`; P2. |
| Runtime | Switch runtime | Covered by runtime helper tests. Needs ElizaOS manual QA. |
| Appearance | Language tiles | Code reviewed; needs visual/manual persistence QA. |
| Appearance | Light/Dark buttons | Code reviewed; needs visual/manual persistence QA. |
| Appearance | Theme tiles | Code reviewed; needs visual/manual persistence QA. |
| Appearance | Load content pack URL | Code reviewed; HTTP policy risk noted. |
| Appearance | Load from folder | Code reviewed; needs browser support/manual QA. |
| Appearance | Loaded pack toggle/Deactivate current pack | Code reviewed; needs asset cleanup/manual QA. |
| Capabilities | Wallet switch | Code reviewed; affects Settings Wallet & RPC visibility. Needs manual persistence QA. |
| Capabilities | Browser switch | Code reviewed; no targeted interaction test. |
| Capabilities | Computer Use switch | Capability copy covered; needs permission-gated manual QA. |
| Capabilities | Auto-training switch | Code reviewed; needs backend availability/manual QA. |
| Apps | Create new app | Code reviewed; needs live `/api/apps/create` QA. |
| Apps | Load from directory | Code reviewed; needs live filesystem/manual QA. |
| Apps | Verify on relaunch checkbox | Code reviewed; needs live relaunch QA. |
| Apps | Launch/Relaunch/Edit/Stop app | Code reviewed; needs live app lifecycle QA. |
| Wallet keys | Add wallet key toggle/form Save/Cancel | Code reviewed; inventory route covered partially. |
| Wallet keys | Reveal/Hide | Reveal route covered by WalletKeysSection test; hide needs manual QA. |
| Wallet keys | Delete | Code reviewed; needs manual confirm/delete QA. |
| Wallet & RPC | Eliza Cloud mode button | Code reviewed; cloud wallet state tests cover downstream refresh. |
| Wallet & RPC | Custom RPC mode button | P1 bug when switching from cloud to custom. |
| Wallet & RPC | Connect to Eliza Cloud | Code reviewed; needs live cloud login QA. |
| Wallet & RPC | EVM/BSC/Solana provider buttons | Code reviewed; save bug noted. |
| Wallet & RPC | Secrets button | Code reviewed; opens SecretsView modal. Needs manual QA. |
| Wallet & RPC | Save | Existing tests cover all-cloud and existing custom saves, not cloud-to-custom switch. |
| Wallet & RPC | Cloud Services RPC/Media/TTS/Embeddings switches | Code reviewed; restart-required UX risk noted. |
| Permissions desktop | Allow All | Code reviewed; needs OS manual QA. |
| Permissions desktop | Refresh | Code reviewed; needs OS manual QA. |
| Permissions desktop | Per-row Request/Open Settings | Code reviewed; needs OS manual QA. |
| Permissions desktop | Shell toggle | Code reviewed; backend route reviewed. Needs restart/manual QA. |
| Permissions desktop | Capability toggles | Code reviewed; needs plugin toggle/manual QA. |
| Permissions web/mobile | Grant Camera/Microphone/Screen | P1 filter bug; needs tests and manual QA after fix. |
| Vault | Manage button | Code reviewed; opens global modal. |
| Vault modal | Overview/Secrets/Logins/Routing tabs | Code reviewed at shell level; detailed tab actions need manual QA. |
| Security | Access Refresh | Code reviewed; security tests cover access details. |
| Security | Set/Change remote password | Covered by SecuritySettingsSection tests. |
| Security | Revoke session | Covered by SecuritySettingsSection tests. |
| Security | Sign out everywhere else | Code reviewed; needs multi-session manual QA. |
| Updates | Check for desktop updates | Code reviewed; needs packaged desktop QA. |
| Updates | Apply downloaded update | Code reviewed; needs packaged desktop QA. |
| Updates | Refresh update status | Code reviewed; needs packaged desktop/API QA. |
| Backup & Reset | Export Agent / Export modal Cancel/Export/include logs | Code reviewed; needs manual encrypted export QA. |
| Backup & Reset | Import Agent / Browse/Change/Cancel/Import | Code reviewed; needs manual file import QA. |
| Backup & Reset | Reset Everything | Code reviewed; reset handler has confirm in state layer. Needs manual destructive-flow QA. |
| Cloud settings tabs | Desktop tab buttons/mobile select | Code reviewed; URL update gap noted. |
| Cloud General | Save changes, notification switches | Code reviewed; error handling risk noted. |
| Cloud Account | Manage account, View analytics, Log out, Contact support, Copy org ID | Code reviewed; needs live account/session QA. |
| Cloud Connections | Google/Microsoft connect/disconnect | Code reviewed; needs live OAuth QA. |
| Cloud Connections | Twilio/Blooio/WhatsApp connect/disconnect/setup/copy | Code reviewed; needs live provider QA. |
| Cloud Connections | Discord/Telegram create/connect/edit/delete/instructions | Code reviewed; needs live provider QA. |
| Cloud Billing | Card/Crypto selector, amount input, Buy credits/Pay with Crypto | Code reviewed; live checkout/manual QA needed; card error handling risk noted. |
| Cloud Billing | Pay-as-you-go, Auto-top-up, invoice view | Code reviewed at tab level; needs live billing QA. |
| Cloud APIs | Create new secret key, Copy newly created key, Done | Code reviewed; full-key redisplay risk noted. |
| Cloud APIs | Copy existing key | P1 security risk. |
| Cloud APIs | Delete key confirm/cancel/delete | Code reviewed; loading-state error risk noted. |
| Cloud Analytics | Time range and focus metric buttons | Code reviewed; needs live analytics QA. |
| Cloud Usage | Billing CTA | Code reviewed; needs live usage/credits QA. |

## Changed paths

- `launchdocs/05-settings-qa.md`
