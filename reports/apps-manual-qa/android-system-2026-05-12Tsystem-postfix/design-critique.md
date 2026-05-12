# Android System, Companion, and Utility App QA

Generated: 2026-05-12

## Scope

- Android system app recapture: `reports/apps-manual-qa/android-system-2026-05-12Tsystem-postfix`
- Companion and utility final capture set: `reports/apps-manual-qa/companion-utility-final-20260512T080841833Z`
- Android system apps covered: Phone, Contacts, WiFi, Messages, Device Settings.
- Utility/companion apps covered: lifeops, tasks, plugins, skills, fine-tuning, trajectories, relationships, memories, runtime, database, logs, inventory, elizamaker, companion, shopify, vincent, hyperliquid, polymarket.
- Third-party games were not included.

## Overall Verdict

All reviewed captures render without red error screens and without horizontal overflow in desktop or mobile viewports.

The Android system report has 10 captures. Every capture reached its ready selector, and every capture has `scrollWidth <= innerWidth`.

The companion/utility report has 36 captures. The summary is:

- `readyFailures`: 0
- `errorScreens`: 0
- `overflow`: 0
- `consoleIssues`: 0

The Android system report still records 20 raw page errors, but all 20 are the QA web shim message `"Keyboard" plugin is not implemented on web`. These are not visible UI errors and are filtered in the Playwright E2E guard. WiFi also logs the expected web fallback warning for the Network plugin when the Android platform shim is used in Chromium.

## Verification

- `bun run build` in `packages/native-plugins/system`: passed.
- `bun run typecheck` and `bun run build` for Phone, WiFi, Messages, and Device Settings app packages: passed.
- `bun run --cwd packages/app build:web`: passed with existing browser/native externalization and pglite eval warnings.
- `bun run --cwd packages/app test:e2e -- test/ui-smoke/android-system-apps.spec.ts`: 2 passed.
- `bun run --cwd packages/app test:e2e -- test/ui-smoke/apps-utility-interactions.spec.ts`: 3 passed.

## Fixes Made From This Pass

- Added `@elizaos/app-messages`, an Android-only Messages app backed by `@elizaos/capacitor-messages` for listing SMS threads and drafting/sending SMS.
- Added `@elizaos/app-device-settings`, an Android-only Device Settings app for brightness, volume streams, Android role requests, and settings shortcuts.
- Extended `@elizaos/capacitor-system` with brightness, volume, display/sound/write-settings, and network settings bridge methods.
- Fixed AOSP overlay registration by importing `@elizaos/app-phone/register`, `@elizaos/app-contacts/register`, `@elizaos/app-wifi/register`, `@elizaos/app-messages/register`, and `@elizaos/app-device-settings/register` directly in `packages/app/src/main.tsx`.
- Improved Phone's empty Recent/Contacts states so they no longer read as a blank screen.
- Improved WiFi's empty/off state with permission/network-settings guidance and direct Network settings actions.
- Added a Network shortcut to Device Settings.
- Added targeted Android system Playwright coverage for render, overflow, Phone dialing/backspace, Contacts new-contact flow, WiFi scan, Messages draft composition, and Device Settings slider interaction.
- Added the repeatable Android-system capture script at `scripts/ai-qa/capture-android-system-apps.mjs`.

## Android System App Findings

### Phone

Status: fixed enough for this pass.

The initial problem was that the Recent tab looked like a nearly empty black screen on both desktop and mobile. The updated capture now centers a phone icon, explanatory copy, and Dialer/Refresh actions. Mobile no longer feels broken when there is no call log.

Remaining gap: desktop still behaves like a phone-sized task inside a wide canvas. That is acceptable for a device dialer, but a future desktop layout could use a split view with dialer, recent calls, and contact shortcuts visible together. The Contacts tab is disabled in the Chromium shim because the soft contacts module is not available through that path; the standalone Contacts app works.

### Contacts

Status: pass with product gaps.

The app renders normally, search fits, new-contact open/cancel works, and the empty state has a clear import action. Mobile spacing is clean with no overflow.

Remaining gap: the desktop empty state is stable but sparse. A better wide layout would keep the list/detail structure visible with import, new contact, and permission state in the empty detail pane.

### WiFi

Status: fixed enough for this pass.

The earlier WiFi capture had a large empty gap and little guidance when WiFi was off. The updated capture now shows an off-state card, explains that WiFi/location access are required, and provides Scan again plus Network settings actions. Mobile fills the screen more intentionally and remains within width.

Remaining gap: real Android permission states are not visible in the Chromium shim. A hardware pass should verify ACCESS_FINE_LOCATION denial, WiFi-off behavior, scanned network rows, secured-network password entry, and connection failure messages.

### Messages

Status: new app implemented; needs real-device validation.

The app renders a thread list/composer split on desktop and a focused composer on mobile. The QA interaction drafts an SMS address/body and verifies the send button becomes enabled, but does not send to avoid an externally visible SMS.

Remaining gap: Android default-SMS role and SMS read/send permissions need hardware validation. When `System.getStatus()` returns roles on a real Android device, the app should show the default SMS role banner if the role is available but not held.

### Device Settings

Status: new app implemented; needs real-device validation for mutating settings.

Desktop uses screen space well with brightness, Android settings shortcuts, volume cards, and default role cards. Mobile scrolls predictably and has no horizontal overflow. The QA pass moved brightness and media-volume sliders but did not click Apply to avoid mutating the host device from a web shim.

Remaining gap: hardware validation should confirm WRITE_SETTINGS permission flow, brightness writes, volume writes for each stream, and role request flows. The current capture is partly scrolled to the volume section because the smoke interaction focused the media slider before screenshot.

## Companion And Utility App Criticism

### lifeops

Passes render and interaction checks. It is one of the densest utility screens and uses mobile space reasonably. The remaining design gap is prioritization: the empty/no-data state could surface a clearer next action per missing connector instead of many small disconnected status fragments.

### tasks

Stable but too empty. Desktop and mobile both show "No orchestrator work running" with almost no actionable surface. This should eventually include create/import actions, recent task history, queued/running/completed counters, and a useful empty workflow state.

### plugins

Good density and no visible layout failures. Mobile cards are readable, but the toggle/status affordances could be clearer about whether a plugin is installed, enabled, configured, or just available.

### skills

Stable and much better than a blank page, but still reads like an empty marketplace shell. The empty state should use categories, recommended skills, and a stronger installed/available split.

### fine-tuning

Good dashboard density and mobile stacking. The app fills the viewport better than most utility screens. Remaining gap is disabled/offline explanation: users need a clearer path from "runtime offline" to prerequisites.

### trajectories

Stable but sparse. Desktop has a left rail and a large empty panel; mobile is a small empty state. Add recent import/export actions, collection status, and example trajectory metadata.

### relationships

Stable but sparse. The filter shell is visible, but no-data state should explain source requirements and provide relationship import or scan actions.

### memories

Stable but sparse. The feed/browse structure is useful, but empty state should show memory sources, indexing status, and recent ingestion actions.

### runtime

Good diagnostic density on desktop and still useful on mobile. This is one of the stronger utility captures. The only concern is mobile discoverability because much of the value sits below the fold.

### database

Stable and clear about the runtime dependency. Desktop/table tabs use space decently, but the empty state should offer "start local runtime" or "connect runtime" actions instead of stopping at unavailable.

### logs

Pass. The filters and sample rows use the space well. Mobile is readable and has no overflow.

### inventory

Pass with caveats. It uses empty space better than most empty utilities by showing market fallback cards. Remaining gap is that missing wallet/address setup should be more prominent than external market placeholders.

### elizamaker

Stable but the weakest visual use of space. It is mostly an empty chat surface with a bottom provider prompt. Add templates, recent characters, model/provider status, and a first-run creation path.

### companion

Pass. The avatar and chat render without the previous red/error symptoms. On mobile, the avatar dominates the first viewport; acceptable for companion mode, but chat entry and connection/model status should remain easier to scan.

### shopify

Stable and clear, but very sparse on desktop. The connection card should be paired with setup state, docs links, store health, or a mock preview so the wide canvas is not mostly empty.

### vincent

Stable but sparse on desktop. It should expose connection prerequisites, current account/vault state, and last sync attempts more visibly.

### hyperliquid

Good density and mobile scanning. Public read status, credential state, account state, markets, and positions are all visible enough for an empty/unauthenticated state.

### polymarket

Good density and mobile scanning. It clearly separates read access, trading readiness, active markets, and mock market data.

## Remaining QA Work

- Run the Android system app suite on a real Android device or emulator with native Capacitor plugins, not only the web shim.
- Verify externally visible actions manually: real SMS send, real phone call handoff, contact creation/import, WiFi connection request, brightness Apply, volume Apply, and role requests.
- Add a cleaner QA platform mode so Capacitor Keyboard does not emit web-shim pageerrors while still allowing Android-only apps to register in Chromium.
- Expand the capture script to optionally save both initial and post-interaction screenshots for scroll-heavy apps like Device Settings.
