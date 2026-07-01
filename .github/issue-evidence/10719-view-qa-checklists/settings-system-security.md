# Settings — System & Security groups — QA Checklist

Scope: the `system` group (runtime, appearance +background, remote-plugins, wallet-rpc, updates, advanced/Backup&Reset) and the `security` group (app-permissions, permissions, secrets/Vault, security), plus the shared `AdvancedToggle` + developerOnly/preview gating. Source: `packages/ui/src/components/settings/*`. All sections are reached through the Settings shell at route `settings` (`/settings`, `packages/ui/src/navigation/index.ts`), selected by hash deep-link `#<sectionId>` (`readSettingsHashSection` / `replaceSettingsHash` in `settings-sections.ts`, consumed by `components/pages/SettingsView.tsx`). `background` also has its own top-level route (`/background`).

Legend for Coverage: `COVERED (path)` = a committed test exercises the item; `PARTIAL` = only render/screenshot/smoke; `GAP` = no committed test.

---

## Runtime (`#runtime` → RuntimeSettingsSection)

### Entry / Nav
- [ ] Reach via `/settings` then select "Runtime" row (system group) — PARTIAL (`settings-mobile-load.spec.ts` renders each section id)
- [ ] Fresh reload on `/settings#runtime` lands directly on Runtime — GAP
- [ ] Deep-link from chat ("open runtime settings") resolves the `#runtime` hash — GAP
- [ ] Back button from Runtime returns to the section list (mobile stacked nav) — GAP
- [ ] "Current mode: {mode}" header reflects `GET /api/runtime/mode` snapshot, falling back to local heuristic while loading — GAP (server snapshot vs fallback path untested)

### Primary interactions
- [ ] Three mode rows render: Cloud, Local, Remote (order + icons Cloud/Laptop/RadioTower) — PARTIAL (mobile-load render only)
- [ ] Active mode row shows `active`/`aria` state matching `currentRuntime.kind` — GAP
- [ ] Clicking a non-active mode row calls `reloadIntoFirstRunRuntime(target)` (full reload into first-run runtime) — GAP; onboarding-side covered by `runtime-configurability.spec.ts` (different surface)
- [ ] Store build hides Local OR shows it disabled with `localDisabledReason` description — GAP
- [ ] Android cloud build (`isAndroidCloudBuild`) hides the Local row entirely — GAP
- [ ] Store build shows the `AdvancedToggle` row; toggling reveals "Sandbox build" group — GAP
- [ ] Sandbox group under Electrobun shows "Import direct-build data" button; non-Electrobun shows the unavailable note — GAP
- [ ] Import flow: `inspectExistingElizaInstall` → `pickDesktopWorkspaceFolder` → `migrateDesktopStateDir`; each branch (canceled / unavailable / failed / skipped / done) sets the correct `migrationMessage` — GAP

### State matrix
- [ ] Loading: header uses local fallback label until `runtimeModeState.phase === "ready"` — GAP
- [ ] Store build vs direct build: Local disabled vs enabled — GAP
- [ ] Import busy: button shows "Importing…" and is disabled — GAP
- [ ] Import error surfaces the thrown message via `migrationMessage` — GAP
- [ ] Non-desktop (no bridge): import unavailable path — GAP

### Repeated / rapid-fire
- [ ] Mash a mode row: `reloadIntoFirstRunRuntime` should fire once (reload interrupts) — GAP
- [ ] Double-click Import while `migrationBusy`: button disabled prevents a second folder picker — GAP

### Back-and-forth / recovery
- [ ] Toggle Advanced on → navigate away → return: sandbox group state derives from persisted advanced flag — GAP
- [ ] Start import, cancel picker, retry: `migrationMessage` resets to null on re-entry — GAP

### Fuzz / adversarial
- [ ] Migrate a folder path with unicode/emoji/whitespace: error message renders without layout break — GAP
- [ ] Rapidly flip Advanced toggle while import busy: no crash, busy state honored — GAP

### Input modalities
- [ ] Keyboard: Tab reaches each mode row; Enter/Space activates — GAP
- [ ] Touch (mobile viewport): mode rows are ≥44px tap targets — GAP
- [ ] External docs link ("Why is local disabled?") opens `target=_blank rel=noreferrer` — GAP

### A11y / geometry
- [ ] Active row has visible selected styling (accent, not blue) — PARTIAL (`settings-theme-audit.spec.ts` color scan)
- [ ] axe pass on the section — GAP

### Concurrency / races
- [ ] Runtime-mode server snapshot arrives while user already clicked a row: no stale label flash — GAP

---

## Appearance (`#appearance` → AppearanceSettingsSection)

### Entry / Nav
- [ ] Reach via `/settings` → "Appearance" — PARTIAL (`settings-mobile-load.spec.ts`)
- [ ] Fresh reload on `/settings#appearance` — GAP
- [ ] Chat deep-link "change theme/appearance" — GAP

### Primary interactions
- [ ] Theme tiles Light/Dark/System each call `setUiThemeMode(mode)` and mark active (`aria-current`) — PARTIAL (theme audit renders both light+dark; click-through GAP)
- [ ] Selecting a theme visibly re-skins the app immediately (document class) — GAP
- [ ] Language tiles (`LANGUAGES`) call `setUiLanguage(id)`, mark active with Check icon — COVERED (`settings-sections-interactions.spec.ts` "selecting a language tile marks it active")
- [ ] Selecting a language re-labels the UI (i18n catalog swap) — GAP
- [ ] `LoadedPacksList` renders active/loaded content packs; toggling a pack calls `toggle` — GAP
- [ ] Advanced toggle reveals `LoadContentPackForm` — GAP
- [ ] LoadContentPackForm accepts a pack and loads it — GAP

### State matrix
- [ ] No content packs: LoadedPacksList empty state — GAP
- [ ] Many languages: grid wraps (2/3/4 cols responsive) without overflow — PARTIAL (audit-capture screenshot)
- [ ] Active language persists across reload — GAP

### Repeated / rapid-fire
- [ ] Rapidly click between two language tiles: only one active, `setUiLanguage` idempotent — GAP
- [ ] Spam theme Light↔Dark: no flicker-lock, final state applied — GAP

### Back-and-forth / recovery
- [ ] Change language → leave settings → return: selected tile still active — GAP
- [ ] Toggle Advanced on, load a pack, toggle off: pack stays loaded (form hidden only) — GAP

### Fuzz / adversarial
- [ ] Content pack form with malformed/huge manifest surfaces an error, not a crash — GAP
- [ ] RTL language selection flips layout correctly — GAP

### Input modalities
- [ ] Keyboard: theme tiles reachable, Enter selects; language grid arrow/Tab nav — GAP
- [ ] Touch: tiles ≥44px — GAP

### A11y / geometry
- [ ] Active tile hover = accent/darker-accent, never blue, never orange→black — PARTIAL (`settings-theme-audit.spec.ts`)
- [ ] axe pass — GAP

### Concurrency / races
- [ ] Change theme while content pack loading: both settle independently — GAP

---

## Background (`#appearance` sub / `/background` route → BackgroundSettingsSection → BackgroundSettingsControls)

### Entry / Nav
- [ ] Reach via `/background` top-level route — PARTIAL (`BackgroundView.test.tsx`, `settings-background.spec.ts` capture)
- [ ] Reach via Background settings subview inside `/settings` — COVERED-render (`BackgroundSettingsSection.test.tsx`, `AppearanceSettingsSection.background.test.tsx`)
- [ ] Chat "change my background/wallpaper" drives the same store via `background:apply` — GAP (channel exists; UI-settings entry untested)

### Primary interactions
- [ ] Each `BACKGROUND_PRESETS` swatch sets `{mode:"shader", color}`; selected swatch shows Check — COVERED (`settings-sections-interactions.spec.ts` "color controls update the shared wallpaper")
- [ ] Custom-color pipette opens hidden `input[type=color]`; change sets shader color — GAP
- [ ] Upload button opens file picker; `fileToBackgroundDataUrl` → `{mode:"image"}` — GAP
- [ ] Generate button (cloud only) toggles the prompt form; visible only when `cloudAvailable` — GAP
- [ ] Generate submit calls `client.generateBackgroundImage(prompt)` → sets image, closes form, clears prompt — GAP
- [ ] Undo button (only when `canUndoBackground`) calls `undoBackgroundConfig()` reverting to prior — GAP
- [ ] Applying a background updates Home/Launcher/chat live (shared store) — PARTIAL (`settings-background.spec.ts` shader+photo capture)

### State matrix
- [ ] Cloud disconnected / `cloudAuthRejected`: Generate button hidden — GAP
- [ ] Generating: prompt input disabled, spinner on submit — GAP
- [ ] Generate failure: `error` alert (`role=alert`) shown — GAP
- [ ] Upload of non-image / oversized: `BackgroundImageError` message shown — GAP
- [ ] No undo history: Undo button absent — GAP

### Repeated / rapid-fire
- [ ] Mash a swatch: no duplicate store writes, selected state stable — GAP
- [ ] Submit Generate twice quickly: `generating` guard blocks the second call — GAP
- [ ] Spam Undo: stops cleanly at history floor (no throw when `canUndoBackground` false) — GAP

### Back-and-forth / recovery
- [ ] Open prompt form, navigate away, return: prompt draft reset — GAP
- [ ] Upload image, then undo, then reselect a preset: final config consistent — GAP
- [ ] Reload after applying image: persisted image restored — PARTIAL (`useDisplayPreferences.background.test.tsx`)

### Fuzz / adversarial
- [ ] Paste huge/emoji/RTL prompt text: submit trims, no overflow — GAP
- [ ] Whitespace-only prompt: submit disabled (`prompt.trim().length===0`) — GAP
- [ ] Pick a color via keyboard on the native color input — GAP

### Input modalities
- [ ] Enter in prompt input submits the form — GAP
- [ ] Touch: swatches (36px) and action buttons (48px) tappable — GAP
- [ ] Buttons expose `aria-pressed` (Generate) / `aria-label` on every control — GAP

### A11y / geometry
- [ ] Focus visible on swatches/buttons; hover scale transform not color→black — GAP
- [ ] axe pass with prompt form open — GAP

### Concurrency / races
- [ ] Generate in flight while user picks a preset swatch: last write wins, no torn config — GAP

---

## Remote Plugins (`#remote-plugins` → RemotePluginHostSection)

### Entry / Nav
- [ ] Reach via `/settings` → "Remote Plugins" (system group) — PARTIAL (`settings-mobile-load.spec.ts`)
- [ ] Fresh reload on `/settings#remote-plugins` — GAP
- [ ] Section is desktop/Electrobun-only (bridge RPCs); web/mobile shows empty/unavailable — GAP

### Primary interactions
- [ ] `refresh()` fans out `getDesktopRemotePluginStoreSnapshot` + `listDesktopRemotePluginWorkerStatuses` + `getDesktopRemotePluginStoreRoot` on mount — GAP
- [ ] Source-dir input round-trips (`getValue`/`onFill` agent element) — GAP
- [ ] "Pick a folder…" calls `pickDesktopWorkspaceFolder`; canceled → no change; unavailable → error — GAP
- [ ] Install button disabled when `sourceDir` empty or `busy`; enabled otherwise — GAP
- [ ] Install calls `installDesktopRemotePluginFromDirectory({sourceDir, devMode:true})`; null result → "Install failed — bridge not available" — GAP
- [ ] Successful install clears input and re-refreshes list — GAP
- [ ] "Reveal in file manager" (footer, when `storeRoot`) calls `desktopOpenPath(storeRoot)` — GAP
- [ ] Per-row Start/Stop toggles `startDesktopRemotePluginWorker`/`stopDesktopRemotePluginWorker`; badge state stopped/starting/running/error — GAP
- [ ] Per-row Logs toggles `getDesktopRemotePluginLogs`; open shows `<pre>` (or "(no logs yet)"), re-click collapses — GAP
- [ ] Uninstall shows `window.confirm`; confirm → `uninstallDesktopRemotePlugin` + refresh; cancel → no-op — GAP
- [ ] Permission groups (host/bun/isolation) rendered per row from `grantedPermissions` — GAP
- [ ] Live subscriptions update snapshot + worker status without manual refresh — GAP
- [ ] Installed count header reflects `remotePlugins.length` — GAP

### State matrix
- [ ] Empty: "No remote plugins installed." — GAP
- [ ] Populated (many rows): list scrolls, ids/versions truncate — GAP
- [ ] Install error: `error` string shown in footer (warn tone) — GAP
- [ ] Worker error state: `status.error` shown under the row — GAP
- [ ] Bridge unavailable: install/folder pickers return null → user-facing message — GAP
- [ ] Logs empty vs long (max-h-48 overflow-auto) — GAP

### Repeated / rapid-fire
- [ ] Double-click Install: `busy` guard prevents a duplicate install — GAP
- [ ] Mash Start/Stop on one row: no duplicate worker spawns; badge converges — GAP
- [ ] Spam Logs open/close: single fetch per open, `logsLoading` disables button — GAP
- [ ] Confirm uninstall twice quickly: single uninstall RPC — GAP

### Back-and-forth / recovery
- [ ] Install in flight, navigate away (unmount): `mountedRef` guards prevent setState after unmount — GAP
- [ ] Return to section: subscriptions re-established, list current — GAP
- [ ] Reload mid-install: no orphaned busy spinner after reload — GAP

### Fuzz / adversarial
- [ ] Source-dir with a relative path / traversal / huge string: install handles/reports without crash — GAP
- [ ] Install a plugin whose manifest requests broad permissions: host/bun/isolation tags surface truthfully — GAP
- [ ] Rapid interleave install + start + uninstall on same id — GAP

### Input modalities
- [ ] Keyboard: Tab order input → Pick folder → Install → row buttons — GAP
- [ ] Enter in source-dir does not accidentally submit (no form) / or triggers install intentionally — GAP
- [ ] Touch: row action buttons (Start/Logs/Uninstall) ≥44px — GAP

### A11y / geometry
- [ ] State badges have sufficient contrast; running=ok, error/starting=warn (no blue) — GAP
- [ ] axe pass with a row expanded — GAP

### Concurrency / races
- [ ] Worker-changed subscription fires while Start click pending: status merges, no flip-flop — GAP
- [ ] Store-changed subscription during an in-flight refresh: latest snapshot wins — GAP

---

## Wallet & RPC (`#wallet-rpc` → WalletRpcSection = WalletKeysSection + ConfigPageView embedded)

### Entry / Nav
- [ ] Reach via `/settings` → "Wallet & RPC" — PARTIAL (`settings-mobile-load.spec.ts`)
- [ ] Fresh reload on `/settings#wallet-rpc` — GAP

### Primary interactions (WalletKeysSection)
- [ ] List existing wallet keys — COVERED (`wallet-keys.spec.ts` deep round-trip)
- [ ] Add a wallet key persists via the real backend key path — COVERED (`wallet-keys.spec.ts`)
- [ ] Reveal a key value round-trips — COVERED (`wallet-keys.spec.ts`)
- [ ] Delete a key removes it — COVERED (`wallet-keys.spec.ts`)
- [ ] Cloud wallet import path — COVERED (`cloud-wallet-import.spec.ts`)

### Primary interactions (ConfigPageView embedded = RPC/provider config)
- [ ] Embedded config fields render and save via `/api/config` — PARTIAL (capabilities config write covered elsewhere; embedded-in-wallet GAP)
- [ ] RPC endpoint fields validate + persist — GAP

### State matrix
- [ ] No keys: empty state — GAP
- [ ] Many keys: list overflow — GAP
- [ ] Add with invalid key material: error surfaced — GAP
- [ ] Reveal while unauthenticated/guest: gated — GAP

### Repeated / rapid-fire
- [ ] Submit Add twice: no duplicate key rows — PARTIAL (`wallet-keys.spec.ts` counts PUTs)
- [ ] Mash Reveal/Hide: value toggles cleanly — GAP

### Back-and-forth / recovery
- [ ] Add key, navigate away, return: key present, draft cleared — GAP
- [ ] Reload after delete: key stays deleted — GAP

### Fuzz / adversarial
- [ ] Paste huge/whitespace/emoji key or RPC URL: validation rejects, no crash — GAP
- [ ] Malformed RPC URL rejected before save — GAP

### Input modalities
- [ ] Keyboard nav through key rows + config inputs — GAP
- [ ] Touch tap targets ≥44px — GAP

### A11y / geometry
- [ ] Reveal button announces state; axe pass — GAP

### Concurrency / races
- [ ] Add key while config save pending: independent, both settle — GAP

---

## Updates (`#updates`)

### Entry / Nav
- [ ] Reach via `/settings` → "Updates" — PARTIAL (`settings-mobile-load.spec.ts`)
- [ ] Fresh reload on `/settings#updates` — GAP
- [ ] NOTE: no dedicated `UpdatesSection` file found under `settings/`; the `updates` id maps through `settings-sections.ts` — verify which component renders and whether it is bridge/`services/app-updates`-backed — GAP (component identity unconfirmed; audit before writing behavior tests)

### Primary interactions
- [ ] "Check for updates" triggers the app-updates service; shows current version — GAP
- [ ] Available-update state offers download/install; up-to-date state shows confirmation — GAP
- [ ] Channel/auto-update toggle persists — GAP

### State matrix
- [ ] Checking / up-to-date / update-available / download-progress / error — GAP
- [ ] Web/mobile (no native updater): section shows unavailable/N-A state — GAP

### Repeated / rapid-fire
- [ ] Double-click Check: single request, no duplicate download — GAP

### Back-and-forth / recovery
- [ ] Leave mid-download, return: progress restored or cleanly reset — GAP

### Fuzz / adversarial
- [ ] Simulated failed/partial download surfaces an error, not a stuck spinner — GAP

### A11y / geometry
- [ ] axe pass; progress announced via aria-live — GAP

---

## Backup & Reset / Advanced (`#advanced` → AdvancedSection)

### Entry / Nav
- [ ] Reach via `/settings` → "Backup & Reset" (labelled "advanced" id) — PARTIAL (`settings-mobile-load.spec.ts`)
- [ ] Fresh reload on `/settings#advanced` — GAP
- [ ] Chat "reset my agent" / "export my agent" deep-link — GAP

### Primary interactions
- [ ] Export row opens the Export modal — COVERED (`settings-sections-interactions.spec.ts` "Export opens its modal")
- [ ] Import row opens the Import modal — GAP
- [ ] Export modal: password input round-trips; "Include recent logs" checkbox toggles `exportIncludeLogs` — GAP
- [ ] Export submit calls `handleAgentExport` (busy spinner, disabled while busy); success/error banners — GAP
- [ ] Import modal: Browse opens file picker (`.eliza-agent,.agent`); selected filename shows; password round-trips — GAP
- [ ] Import submit calls `handleAgentImport`; success/error banners — GAP
- [ ] "Developer views" switch → `setDeveloperMode` (reveals logs/database/trajectories views) — GAP
- [ ] "Preview views" switch → `setPreviewMode` (reveals alpha views) — GAP
- [ ] Toggling Developer/Preview immediately changes visible nav tabs — GAP
- [ ] Danger zone "Reset Everything" opens confirm modal — COVERED (`AdvancedSection.test.tsx`)
- [ ] Reset only runs after confirm; Cancel aborts; runs exactly once — COVERED (`AdvancedSection.test.tsx` 4 cases)

### State matrix
- [ ] Export busy vs idle; export error vs success banner (`role=alert`/`role=status`) — GAP
- [ ] Import busy; import error vs success — GAP
- [ ] Import with no file selected: placeholder "Choose an exported backup" — GAP
- [ ] Guest/unauthenticated: reset/export behavior — GAP

### Repeated / rapid-fire
- [ ] Double-click Export submit: `exportBusy` disables second submit — GAP
- [ ] Reopen Export modal: `resetExportState` clears password + logs flag each open — GAP
- [ ] Reopen Import modal: `resetImportState` clears file input + password — GAP
- [ ] Mash Developer/Preview toggles: state converges, nav updates once settled — GAP
- [ ] Confirm Reset once, cannot double-fire (modal closes) — COVERED (`AdvancedSection.test.tsx` "exactly once")

### Back-and-forth / recovery
- [ ] Open Export, type password, close (Esc/Cancel): draft cleared; reopen is blank — GAP
- [ ] Start export, navigate away mid-request, return: no latched spinner — GAP
- [ ] Select import file, cancel, reopen: file input reset — GAP

### Fuzz / adversarial
- [ ] Export password with emoji/RTL/huge/whitespace: handled, no crash — GAP
- [ ] Import a non-backup file (wrong extension bypassed): error surfaced, not a crash — GAP
- [ ] Import wrong password: decryption error banner — GAP

### Input modalities
- [ ] Keyboard: focus trapped in each Dialog; Esc closes; Enter submits — GAP (Dialog focus-trap untested here)
- [ ] Tab order within Export/Import modals sensible — GAP
- [ ] Touch: modal buttons ≥42px (min-h-[2.625rem]) — GAP

### A11y / geometry
- [ ] Danger button uses destructive (red) tone, not blue; hover stays in red family — PARTIAL (`settings-theme-audit.spec.ts`)
- [ ] Reset confirm modal focus-visible + aria-live danger copy — GAP
- [ ] axe pass with each modal open — GAP

### Concurrency / races
- [ ] Export and Import modals cannot both be open; opening one while the other busy — GAP
- [ ] Toggle Developer mode while an export is in flight: independent — GAP

---

## App Permissions (`#app-permissions` → AppPermissionsSection)

### Entry / Nav
- [ ] Reach via `/settings` → "App Permissions" (security group) — PARTIAL (`settings-mobile-load.spec.ts`)
- [ ] Fresh reload on `/settings#app-permissions` — GAP

### Primary interactions
- [ ] On mount, `client.listAppPermissions()` (`GET /api/apps/permissions`) populates rows — PARTIAL
- [ ] Refresh button re-queries `/api/apps/permissions` — COVERED (`settings-sections-interactions.spec.ts` "Refresh re-queries")
- [ ] Per-app namespace toggles (fs=Filesystem, net=Network) call `client.setAppPermissions(slug, nextSet)` (`PUT /api/apps/permissions/:slug`) — GAP
- [ ] Toggle is optimistic; reverts + shows error + `setActionNotice` on failure — GAP
- [ ] Requested-permission summary (`fs read/write`, `net outbound`) rendered per namespace — GAP
- [ ] first-party ("auto-granted") vs external ("explicit consent") description per app — GAP
- [ ] `grantedAt` date shown when present — GAP
- [ ] Apps without a manifest collapse into the `<details>` disclosure with a count — GAP

### State matrix
- [ ] Loading: spinner on Refresh, list absent — GAP
- [ ] Error: "Failed to load app permissions: …" (danger) — GAP
- [ ] Empty (no grantable apps): "No apps declare permissions yet." — GAP
- [ ] Zero manifest-less vs many manifest-less apps in `<details>` — GAP
- [ ] Toggle pending disables the switch (`row.pending`) — GAP

### Repeated / rapid-fire
- [ ] Mash a namespace toggle on/off: no duplicate PUTs, final state == last intent, optimistic flip consistent — GAP
- [ ] Double-click Refresh while loading: disabled prevents duplicate GET — GAP
- [ ] Toggle two namespaces of the same app quickly: both PUTs use correct `nextSet` (no lost update) — GAP

### Back-and-forth / recovery
- [ ] Toggle fails (offline) → optimistic revert restores prior granted set — GAP
- [ ] Navigate away mid-PUT (unmount): `mountedRef` prevents setState-after-unmount — GAP
- [ ] Reload after a grant: server reflects the persisted namespace — GAP

### Fuzz / adversarial
- [ ] App with malformed `requestedPermissions` manifest: `parseAppPermissions` returns null → summary omitted, no crash — GAP
- [ ] Rapid random interleave of toggles across many apps: no cross-app state bleed — GAP

### Input modalities
- [ ] Keyboard: switches reachable + toggled with Space; `htmlFor`/`id` binds label to switch — GAP
- [ ] Touch: switch tap targets ≥44px — GAP

### A11y / geometry
- [ ] Each switch has `aria-label` ("Toggle Filesystem for …"); axe pass — GAP
- [ ] Granted switch color = accent, not blue — PARTIAL (theme audit)

### Concurrency / races
- [ ] Refresh fired while a toggle PUT is pending: list reload doesn't clobber the in-flight optimistic row — GAP

---

## Permissions (`#permissions` → PermissionsSection: platform-branched)

Note: renders `WebPermissionsView` (web), `MobilePermissionsView` (native non-desktop), or `DesktopPermissionsView`. `PolicyControlsView` (wallet policy) is a SEPARATE component NOT wired into this section — see its own section below.

### Entry / Nav
- [ ] Reach via `/settings` → "Permissions" (security group) — PARTIAL (`settings-mobile-load.spec.ts`, `permissions-stories-smoke.test.tsx` stories)
- [ ] Fresh reload on `/settings#permissions` — GAP
- [ ] Correct platform branch chosen (web vs mobile vs desktop) — GAP

### Primary interactions — Desktop
- [ ] `useDesktopPermissionsState` loads system permission states — GAP
- [ ] Each `SYSTEM_PERMISSIONS` row: Request calls `handleRequest(id)`; Open Settings calls `handleOpenSettings(id)` — GAP
- [ ] `shell` permission row shows a toggle wired to `handleToggleShell` — GAP
- [ ] `not-applicable` permissions filtered out of the desktop list — GAP
- [ ] Capability toggles (`CAPABILITIES`) call `handlePluginToggle(cap.id, enabled)`; gated on `permissionsGranted` — GAP
- [ ] WebsiteBlocker card (desktop mode) wired to request/open-settings for `website-blocking` — GAP

### Primary interactions — Mobile
- [ ] `StreamingPermissionsSettingsView` (mobile) renders — GAP
- [ ] MobileSystemPermissions: per-def `registry.check`; Grant → `registry.request`; Open Settings → `openMobilePermissionSettings` — GAP
- [ ] Refresh re-checks all mobile permissions (spinner) — GAP
- [ ] MobileSignals (LifeOps) setup actions: badge Ready/Needs action/Unavailable; act → request or openSettings per action id — GAP
- [ ] App/Website blocker cards render when boot config provides them — GAP

### Primary interactions — Web
- [ ] `StreamingPermissionsSettingsView` (web/browser) renders — GAP
- [ ] Local-browser runtime shows `LocalWebsiteBlockingCard` (desktop-mode card) vs remote shows web card — GAP

### State matrix
- [ ] Loading: "Loading permissions..." — GAP
- [ ] Desktop unable to load: "Unable to load permissions." — GAP
- [ ] Permission status granted / denied / not-determined / not-applicable per row — GAP
- [ ] Mobile permission def list empty (platform mismatch): panel hidden — GAP
- [ ] MobileSignals plugin missing `checkPermissions`: panel hidden — GAP
- [ ] Platform-specific grant note (darwin/win32/linux) shown in footer — GAP

### Repeated / rapid-fire
- [ ] Mash Grant on a mobile permission: `busyId` guards duplicate requests — GAP
- [ ] Double-click Refresh (mobile/desktop): single re-check pass — GAP
- [ ] Toggle a capability rapidly: `handlePluginToggle` idempotent — GAP

### Back-and-forth / recovery
- [ ] Request a permission, background app, resume: state re-checked on refresh — GAP
- [ ] Deny at OS level, return, Refresh: row shows denied + grant note guidance — GAP
- [ ] Unmount mid-check: cancelled flag prevents setState — GAP

### Fuzz / adversarial
- [ ] Registry `check` throws for one def: falls back to `registry.get(def.id)` without failing the whole panel — GAP
- [ ] MobileSignals `checkPermissions` rejects: panel silently hides (status null) — verify this is desired, not a swallowed error — GAP

### Input modalities
- [ ] Keyboard: Request/Open Settings buttons + shell toggle reachable — GAP
- [ ] Touch: action buttons min-h-11 (44px) — GAP

### A11y / geometry
- [ ] Status badges color-coded (ok/warn/muted), no blue; axe pass per platform branch — GAP

### Concurrency / races
- [ ] Refresh fired while a Grant request pending: `busyId` + refresh don't deadlock the spinner — GAP

---

## PolicyControlsView (wallet policy — standalone; currently reachable only via Storybook)

Note: `PolicyControlsView` is exported from `components/index.ts` but is NOT registered in `settings-sections.ts`; grep shows only `PolicyControls/*` stories consume its subsections. FLAG: potential orphaned view / broken pipeline (an implemented policy editor with no live nav trigger). Confirm intended host before de-larping.

### Entry / Nav
- [ ] Confirm a real trigger exists (route, tab, chat, or embedded host) — GAP / possible orphan
- [ ] If embedded, reach it and load `client` policies — GAP

### Primary interactions
- [ ] Loads policy rules (`PolicyRule[]`) via `client`; loading spinner then list — GAP
- [ ] PolicyToggle enables/disables a policy type — GAP
- [ ] Spending limit section: numeric input + save through `useSettingsSave` — GAP
- [ ] Rate limit section persists — GAP
- [ ] Time window: from/to hour selects (0–24), day-of-week, timezone select persist — GAP
- [ ] Approved addresses: add/remove, `isValidAddress` validation, chain-type label — GAP
- [ ] Auto-approve toggle + confirm dialog for destructive change — GAP

### State matrix
- [ ] Loading / empty (no policies) / populated / save error — GAP

### Repeated / rapid-fire
- [ ] Save twice quickly: single write; toggle spam idempotent — GAP

### Fuzz / adversarial
- [ ] Invalid address (bad checksum, wrong length, emoji): rejected by `isValidAddress` — GAP
- [ ] Negative / NaN / huge spending or rate-limit numbers rejected — GAP
- [ ] from-hour > to-hour time window: validation or sane handling — GAP

### Input modalities
- [ ] Keyboard: Select (Radix) open/close/arrow; Slider arrow-key; Enter to add address — GAP
- [ ] Touch: slider draggable; selects tappable — GAP

### A11y / geometry
- [ ] ConfirmDialog focus-trap; Select/Slider a11y roles; axe pass — GAP

### Concurrency / races
- [ ] Edit two policy sections and save: no lost update across sections — GAP

---

## Vault / Secrets (`#secrets` → SecretsManagerSection launcher + VaultModal)

### Entry / Nav
- [ ] Reach via `/settings` → "Vault" (security group) launcher row — PARTIAL (`settings-mobile-load.spec.ts`)
- [ ] "Manage…" button dispatches `dispatchSecretsManagerOpen()` → modal — PARTIAL (`vault-modal-interactions.spec.ts` opens modal)
- [ ] Global shortcut ⌘⌥⌃V opens the modal (`useSecretsManagerShortcut`) — GAP
- [ ] Paste `#vault/<tab>` URL opens the modal on that tab (`readHashTab`) — GAP
- [ ] Menu accelerator opens modal — GAP
- [ ] Fresh reload on `/settings#secrets` keeps the anchor; opening/closing modal restores prior hash — GAP

### Primary interactions — launcher row
- [ ] Row summary shows primary backend label + "Primary" badge + "+N more" when `enabledCount>1` — GAP
- [ ] Summary refreshes on mount and whenever the modal closes (`isOpen` effect) — GAP
- [ ] Summary reads `/api/secrets/manager/backends` + `/preferences` — GAP

### Primary interactions — VaultModal (tabbed)
- [ ] On open, bulk `load()` fetches backends/preferences/install-methods/inventory/routing/agents/apps — GAP
- [ ] Tab switching Overview/Secrets/Logins/Routing updates `#vault/<tab>` hash (replaceState, not push) — PARTIAL (routing tab covered)
- [ ] Overview: toggle enabled backends, Save calls `PUT /api/secrets/manager/preferences`; "Saved" label clears after 2.5s — GAP
- [ ] Overview: install method / sign-in / sign-out (`POST /api/secrets/manager/signout`) re-load — GAP
- [ ] Secrets tab: add/reveal/persist/delete a secret end-to-end (`/api/secrets/inventory`) — COVERED (`vault-modal-interactions.spec.ts` deep round-trip)
- [ ] Logins tab renders — GAP
- [ ] Routing tab: add a routing rule, persists across tab reopen — COVERED (`vault-routing.spec.ts`)
- [ ] Cross-tab navigate (`navigate({tab, focusKey, focusProfileId})`) focuses target entry — GAP
- [ ] Close button (`onOpenChange(false)`) closes and restores prior hash — GAP

### State matrix
- [ ] Modal loading: "Loading…" spinner until `isReady` (backends+prefs+methods) — GAP
- [ ] Bulk load error: single `vault-modal-error` banner; tabs still render own empty states — GAP
- [ ] Best-effort agents/apps 404: routing tab still works with empty lists — GAP
- [ ] Save error banner; sign-out HTTP error banner — GAP
- [ ] Empty vault (no entries) vs many entries (scroll) — GAP

### Repeated / rapid-fire
- [ ] Mash "Manage…": modal opens once (idempotent open dispatch) — GAP
- [ ] Double-click Save: `saving` disables Close + second save — GAP
- [ ] Rapid tab switching: hash + active content stay in sync, no torn state — GAP
- [ ] Add same secret twice: dedup / overwrite behavior asserted (`INVENTORY_KEY_RE` PUT count) — PARTIAL (`vault-modal-interactions.spec.ts`)

### Back-and-forth / recovery
- [ ] Open on Routing via hash, close, reopen: lands on last tab (initial consumed) — GAP
- [ ] Open modal, edit prefs without saving, close: prefs reset on next open (re-`load`) — GAP
- [ ] Paste a new `#vault/secrets` while open (hashchange listener) switches tab — GAP
- [ ] Prior settings hash (`#secrets`) restored after modal close — GAP

### Fuzz / adversarial
- [ ] Secret key/value with emoji/RTL/huge/whitespace-only round-trips or is rejected cleanly — GAP
- [ ] Routing rule with injection-ish selector string handled — GAP
- [ ] Paste `#vault/<invalid-tab>`: `readHashTab` returns null → falls back to overview — GAP

### Input modalities
- [ ] Keyboard: Dialog focus-trap; Esc closes; Tab cycles tabs (Radix Tabs arrow keys) — GAP
- [ ] Shortcut label rendered matches platform (`getShortcutLabel`) — GAP
- [ ] Touch: tab triggers + Save/Close ≥44px — GAP

### A11y / geometry
- [ ] Modal focus trapped + returns focus to launcher on close — GAP
- [ ] `data-testid` hooks present for every tab; axe pass per tab — GAP

### Concurrency / races
- [ ] Save prefs while inventory refresh (`refreshInventory`) pending: independent, no clobber — GAP
- [ ] Open modal, close before `load()` resolves: no setState-after-close warning — GAP

---

## Security (`#security` → SecuritySettingsSection: Access + Remote Password + Sessions)

### Entry / Nav
- [ ] Reach via `/settings` → "Security" (security group) — PARTIAL (`settings-mobile-load.spec.ts`)
- [ ] Fresh reload on `/settings#security` — GAP
- [ ] `securitySettingsUrl(origin)` (`<origin>/settings#security`) is the canonical remote-access link — GAP

### Primary interactions — Access
- [ ] On mount `authMe()` (`GET /api/auth/me`) resolves `AccessState` loaded/locked/error — GAP
- [ ] Access card renders correct title/detail/status badge per state (local vs remote vs locked reasons) — GAP
- [ ] "Remote password" row shows Set/Not set with ok/warn/danger tone — GAP
- [ ] Advanced toggle reveals Current-browser + Page-URL + API-base endpoint rows (`describeEndpoint` loopback/LAN/all-interfaces/remote) — GAP
- [ ] Access Refresh button re-runs `authMe` — GAP

### Primary interactions — Remote Password
- [ ] setup mode (local + `!ownerConfigured`) shows display-name field; calls `authSetup` — GAP
- [ ] change mode calls `authChangePassword`; `currentPasswordRequired` when not local — GAP
- [ ] Submit disabled until: (setup→displayName), (remote→current pw), new pw ≥12 chars, confirm matches — GAP
- [ ] `confirmMismatch` shows inline error + `aria-invalid` + danger border — GAP
- [ ] Success clears fields + shows success + re-refreshes access — GAP
- [ ] Server error surfaces `result.message` (`role=alert`) — GAP
- [ ] Button label reflects Set vs Change — GAP

### Primary interactions — Sessions
- [ ] `authListSessions` (`GET`) loads sessions; each row shows device icon/kind/ip/ua/last-seen/expires — GAP
- [ ] Current session tagged "This session", no revoke button — GAP
- [ ] Revoke a non-current session → `authRevokeSession`; row spinner while `revoking` — GAP
- [ ] "Sign out everywhere else" (shown when >1 non-current) revokes all others sequentially — GAP
- [ ] Sessions Refresh reloads the list — GAP

### State matrix
- [ ] Access loading (spinner badge) / loaded-local / loaded-remote / locked(remote_auth_required) / locked(remote_password_not_configured) / error — GAP
- [ ] Password section: loading / locked-not-configured message / sign-in-to-manage / editable form — GAP
- [ ] Sessions: loading / error(401 sign-in required vs generic) / empty / one / many — GAP
- [ ] Unauthenticated/guest: password + sessions gated with guidance copy — GAP

### Repeated / rapid-fire
- [ ] Double-submit password form: `isSubmitting` disables the button — GAP
- [ ] Mash Revoke on one session: `revokingIds` set guards duplicate revokes — GAP
- [ ] Spam "Sign out everywhere else": sequential loop doesn't double-revoke a session — GAP
- [ ] Mash Refresh (access + sessions): single reload each — GAP

### Back-and-forth / recovery
- [ ] Type password, navigate away, return: form draft reset (component remounts) — GAP
- [ ] After password success, access card + password button label update (re-refresh) — GAP
- [ ] Revoke current-adjacent session, refresh: list reflects removal — GAP
- [ ] Reload after setting remote password: `passwordConfigured` true — GAP

### Fuzz / adversarial
- [ ] New password < 12 chars rejected (submit stays disabled) — GAP
- [ ] Mismatched confirm blocks submit + shows error — GAP
- [ ] Password with emoji/RTL/whitespace/huge value handled by `authSetup`/`authChangePassword` — GAP
- [ ] Wrong current password (remote change) surfaces server error — GAP
- [ ] `useId()` colon-stripping (`.replace(/:/g,"")`) keeps ids valid for label binding — GAP

### Input modalities
- [ ] Keyboard: form Tab order displayName→current→new→confirm→submit; Enter submits — GAP
- [ ] autoComplete attrs correct (username/current-password/new-password) — GAP
- [ ] Touch: inputs h-11 (44px); revoke buttons tappable — GAP

### A11y / geometry
- [ ] Error copy `role=alert`; status badges color-coded (no blue); focus-visible on inputs — PARTIAL (theme audit color scan)
- [ ] axe pass in loaded + locked + error states — GAP

### Concurrency / races
- [ ] Change password while sessions loading: independent — GAP
- [ ] Access refresh mid password-submit: no stale `accessState` clobbers the success — GAP
- [ ] "Sign out everywhere else" while a single Revoke already pending on one of them — GAP

---

## AdvancedToggle + developerOnly / preview gating (cross-cutting)

Appears in Runtime (store build), Appearance, and Security (Access); developer/preview view gating lives in AdvancedSection.

### Behavior
- [ ] Toggle persists to `localStorage` (default OFF) via `writePersistedAdvancedFlag` — COVERED (`AdvancedToggle.test.tsx`)
- [ ] Reads initial state from localStorage — COVERED (`AdvancedToggle.test.tsx`)
- [ ] Two AdvancedToggles on the page stay in sync via listener cascade — COVERED (`AdvancedToggle.test.tsx`)
- [ ] `onChange` fires with new state — COVERED (`AdvancedToggle.test.tsx`)
- [ ] Custom label supported — COVERED (`AdvancedToggle.test.tsx`)
- [ ] `useAdvancedSettingsEnabled` returns false by default, true when '1', subscribes to changes — COVERED (`AdvancedToggle.test.tsx`)
- [ ] Toggling in Appearance reveals `LoadContentPackForm`; in Runtime reveals sandbox group; in Security reveals endpoint rows — GAP (per-consumer reveal untested)
- [ ] Developer views switch (`setDeveloperMode`) actually adds developer nav tabs (logs/database/trajectories) — GAP
- [ ] Preview views switch (`setPreviewMode`) actually adds preview nav tabs — GAP
- [ ] developerOnly settings sections hidden until developer mode on — GAP

### Rapid-fire / recovery
- [ ] Mash the switch: persisted value equals final intent; no listener leak on unmount — PARTIAL (`AdvancedToggle.test.tsx` persistence)
- [ ] Toggle in one section reflects immediately in another open section (cascade) — COVERED (`AdvancedToggle.test.tsx`, single-page)

### A11y
- [ ] Switch has role=switch + `aria-label`; keyboard Space toggles; label click propagates — GAP
- [ ] 44px min target for the wrapping label control — GAP

---

## Coverage summary

| View | Existing test path(s) | Biggest gap |
| --- | --- | --- |
| Runtime | `packages/app/test/ui-smoke/settings-mobile-load.spec.ts` (render), `runtime-configurability.spec.ts` (onboarding, not this section) | Mode-switch → `reloadIntoFirstRunRuntime`, store/cloud build gating, sandbox import flow: all untested in the settings section |
| Appearance | `settings-sections-interactions.spec.ts` (language tile active), theme/spacing audits | Theme apply, content-pack load/toggle, RTL, persistence |
| Background | `settings-sections-interactions.spec.ts` (color), `settings-background.spec.ts` (capture), `BackgroundSettingsSection.test.tsx` (render), `useDisplayPreferences.background.test.tsx` | Upload, cloud generate (open/submit/error/guard), undo — the entire non-preset half is untested |
| Remote Plugins | `settings-mobile-load.spec.ts` (render only) | ZERO behavior coverage: install/start/stop/logs/uninstall/confirm/live-subscriptions all GAP (biggest single gap in the group) |
| Wallet & RPC | `wallet-keys.spec.ts`, `cloud-wallet-import.spec.ts` | Embedded `ConfigPageView` RPC config validate/save; key fuzz/guest gating |
| Updates | `settings-mobile-load.spec.ts` (render) | Component identity unconfirmed; check/download/install/error states entirely untested |
| Backup & Reset (Advanced) | `settings-sections-interactions.spec.ts` (Export opens), `AdvancedSection.test.tsx` (reset confirm ×4) | Export/Import submit + banners + modal reset/focus-trap; Developer/Preview view-gating effect on nav |
| App Permissions | `settings-sections-interactions.spec.ts` (Refresh) | Optimistic namespace toggle → `PUT /api/apps/permissions/:slug`, revert-on-error, rapid-fire idempotency |
| Permissions | `permissions-stories-smoke.test.tsx`, `settings-mobile-load.spec.ts` | Platform-branched request/openSettings/toggle behavior across web/mobile/desktop; registry fallback + swallowed-error verification |
| PolicyControlsView | `PolicyControls/*` stories only | Appears ORPHANED (not in `settings-sections.ts`); confirm live trigger, then full behavior (spending/rate/time-window/addresses/auto-approve) |
| Vault / Secrets | `vault-modal-interactions.spec.ts` (secret round-trip), `vault-routing.spec.ts` (routing rule) | Launcher summary, Overview backend enable/save/signout, hash restore, shortcut open, focus-trap, error banner |
| Security | `settings-mobile-load.spec.ts` (render), theme audit | Password setup/change validation (≥12, mismatch, current-pw), session revoke + sign-out-everywhere, access-mode states, endpoint classification — no behavior tests at all |
| AdvancedToggle / dev-preview gating | `AdvancedToggle.test.tsx` (persistence/sync/hook) | Per-consumer reveal (sandbox/content-pack/endpoint rows) and developer/preview switch → actual nav-tab visibility change |

**Single biggest gap:** RemotePluginHostSection has ZERO behavior coverage — install, start/stop, log tailing, uninstall-with-confirm, and the two live desktop-bridge subscriptions (store-changed / worker-changed) are all completely untested, and it is a high-risk surface because a remote plugin "can call the app's API as you." SecuritySettingsSection (remote-password setup/change + session revocation) is a close second: an auth-critical surface with only render-level coverage.
