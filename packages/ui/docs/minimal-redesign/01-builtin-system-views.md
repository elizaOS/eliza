# Per-View UX + Code + State Inventory — Built-in System / Apps / Settings Views

Repo: `/home/shaw/milady/eliza`. All view files under `packages/ui/src/components/pages/` and `packages/ui/src/components/settings/`. Routes from `packages/ui/src/navigation/index.ts` `TAB_PATHS`.

Redesign direction being judged against: **minimalism** (cut text/descriptions/borders/cards/badges/redundant inputs; icons + color + whitespace over text), **lighter flat-futuristic look** (orange `#ff8a24` accent, blue `#1d91e8` info, white/black/gray; no heavy black bg, no dark/light toggle as a feature), **floating chat overlay is the primary interface** (views should be glanceable, voice-forward, expose view-dependent actions, surface proactive agent context, integrate with chat).

Metric note: `border=` counts below are raw `grep -c border` occurrences (includes `border-*` color/width utilities, so they over-count, but are a consistent heaviness proxy). Verified counts inline.

---

## SECTION A — APPS surface

### A1. AppsPageView
- **id / route / file:** `apps` / `/apps` / `pages/AppsPageView.tsx` (97 lines)
- **Purpose:** Thin route shim: game-mode passthrough → `GameView`, else `AppsView`, wrapped in `ShellViewAgentSurface viewId="apps"`.
- **States:** game-active (`appsSubTab==="games" && hasActiveGame`), modal-embedded, normal.
- **Current visual structure:** No header/cards/badges of its own. One slop point: the `inModal` branch hardcodes a green accent palette via 8 inline CSS vars — `"--accent": "var(--section-accent-apps, #10b981)"` … `"--s-accent": "#10b981"` (AppsPageView.tsx:73-80). Green (`#10b981`) is **off-brand** — should be orange `#ff8a24` or neutral.
- **Heaviness / slop critique:** The hardcoded green palette is the only issue. URL-sync `useEffect` (37-53) is fine.
- **Minimization recommendations:** Replace the green `#10b981` var block with the orange accent (or delete the per-view accent override entirely; let the theme own it).
- **Even-simpler note:** Keep — it is already a shim.

### A2. AppsView
- **id / route / file:** `apps` / `/apps` / `pages/AppsView.tsx` (1238 lines)
- **Purpose:** Apps tab shell — resizable sidebar + running-apps row + catalog grid + desktop app-window pin controls; delegates `/apps/<slug>/details` to AppDetailsView.
- **States:** loading (from cache), error, populated browse, details sub-page (mutually exclusive), conditional window-controls section (`appWindows.length>0`), conditional active-run banner. **Dead:** `appsSubTab==="running"` is force-rewritten to `"browse"` (532-535) — vestigial tab. **Dead:** `searchQuery` state + `_setSearchQuery` disabled setter (274) — full search plumbing to `filterAppsForCatalog` (1007) with **no search box rendered**.
- **Current visual structure:** ~900 lines of launch/window/heartbeat handlers; rendered JSX is thin (1153-1236). `border`=53 grep (mostly delegated children). Header/title: 0. Two bespoke pill buttons: `AppWindowPinButton` and `ActiveRunButton`.
  - Heaviest JSX (AppsView.tsx:205): `"inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted transition-colors hover:border-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"` — micro-typography uppercase pill on a pin toggle.
  - AppsView.tsx:1173 (window pill): `"inline-flex min-w-0 items-center gap-2 rounded-full border border-border/55 bg-card/70 px-3 py-1.5 text-xs text-muted"`.
- **Heaviness / slop critique:** Dead search plumbing + vestigial "running" tab are migration leftovers (DELETE). Uppercase `tracking-[0.16em]` micro-pills are decorative weight. Most visual heaviness is in delegated `AppsCatalogGrid`/`AppsSidebar`/`RunningAppsRow` (not this file).
- **Minimization recommendations:** Delete `searchQuery`/`_setSearchQuery` and the "running" sub-tab branch. Drop uppercase-tracking treatment on pin/run pills → icon + color only. App-window pin controls belong on the window itself (desktop chrome), not as an in-view bordered section — consider moving out. Surface running apps as a single glanceable strip; let chat ("launch X", "stop X") drive launch/stop instead of per-card buttons.
- **Agent-surface:** `useAgentElement` only (no `ShellViewAgentSurface` here — provided by AppsPageView). Elements: `window-pin-${id}` (toggle), `open-active-run` (button).
- **Even-simpler note:** The catalog could be chat-first (agent recommends/launches apps); the grid becomes a glanceable favorites strip.

### A3. AppDetailsView
- **id / route / file:** `apps` sub-page / `/apps/<slug>/details` / `pages/AppDetailsView.tsx` (1052 lines)
- **Purpose:** Per-app config + diagnostics + widgets + Launch page.
- **States:** catalog-error, loading, not-found, populated; conditional session-features chips / last-failure banner / Detail-extension / Recent Runs / Widgets / per-widget expanded preview; forms = launch-destination radio fieldset + always-on-top checkbox + per-widget show checkbox; launching state.
- **Current visual structure:** **`border`=66 (highest of all page views, verified).** `text-[`=7. Hero `<header>` + `<h2>` + **6 always-uppercase `SectionHeader`** blocks (Launch/About/Details/Recent Runs/Diagnostics/Widgets) rendered even when empty (Diagnostics renders empty, 985-990). **Provenance-badge overload**: up to 2 origin/support badges each with bespoke color classes + a "{{count}} running" pill (147-198, 733). 4-tile stat grid with internal `border-l` dividers inside a bordered card; bordered fieldset nested inside the bordered launch `<section>` (card-in-card-in-card). A `<label>` styled as a pill-button (905-933) duplicating real-button look.
  - Heaviest JSX (AppDetailsView.tsx:747): `"flex flex-col gap-4 rounded-sm border border-border/45 bg-card/30 p-4"` containing 4 tiles each `"min-w-0 border-l border-border/35 pl-3"` (788/797/805/818) → card-in-card with internal dividers.
  - AppDetailsView.tsx:857 (fieldset): `"flex flex-col gap-2 rounded-sm border border-border/40 bg-bg/20 p-3"` nested inside the bordered launch section.
  - AppDetailsView.tsx:775 (Launch button): `"… rounded-full bg-accent px-5 py-2 text-xs font-semibold uppercase tracking-[0.16em] …"`.
  - Pervasive `text-[10px] uppercase tracking-[0.14em]` micro-labels (e.g. 330).
- **Heaviness / slop critique:** This is the single most over-decorated app view. 6 uppercase section headers, provenance badge cluster, nested bordered stat grid, fieldset-in-card, label-as-button, `text-[10px]` micro-typography everywhere. Diagnostics section renders even when empty.
- **Minimization recommendations:** Collapse to: hero (icon + name + one status line), a single primary **Launch** button, and an inline "About" sentence. Move launch-destination radios + always-on-top into a small "⋯" / disclosure (most users launch with defaults). Drop the 4-tile stat grid → one line of metadata. Cut Diagnostics + Recent Runs to a single "last run: ok/failed" pill; full history is a chat question ("how did X run last time"). Replace provenance badges with one small colored dot + tooltip. Widgets list → icon toggles, no per-row preview card. Kill all uppercase `tracking-[0.1Xem]` micro-labels.
- **Agent-surface:** `useAgentElement` (no shell wrapper). Elements: `widget-preview-${k}`, `widget-show-${k}`, `launch`, `launch-mode-window`, `launch-mode-inline`, `always-on-top`.
- **Even-simpler note:** Strong candidate to become a **chat affordance + lightweight launch sheet**. "Open the X app" / "launch X in a window" handles 90%; the details page collapses to a launch sheet with one disclosure.

### A4. ElizaOsAppsView (Phone / Messages / Contacts)
- **id / route / file:** AOSP-shell tiles (`phone` `/phone`, `messages` `/messages`, `contacts` `/contacts`) / `pages/ElizaOsAppsView.tsx` (1960 lines, 3 exported views)
- **Purpose:** ElizaOS-Android native-bridge workspaces: PhonePageView (dialer/recents/contacts/import/transcripts, 5 sub-tabs), MessagesPageView (compose + SMS list + cloud forward), ContactsPageView (create + search).
- **States:** per-view loading/busy, error/notice (`StatusNotice`), empty (`EmptyState`), forms, search; Phone has a 5-panel tab bar.
- **Current visual structure:** **`border`=53 (verified).** ~9 redundant `Panel` description `<p>` that restate the title ("Contacts" → "Android Contacts Provider.", "Messages" → "Recent rows from Android's SMS provider."). Deep card-in-card-in-panel nesting. ~15 inputs/textareas, 30+ buttons, 12-key dialpad. **BRAND VIOLATION (verified):** uses blue `primary` tokens, not orange `accent` — `"border-primary bg-primary text-primary-foreground"` (line 374), `hover:border-primary` (lines 404, 433). **Duplicated UI:** Phone's contacts panel + new-contact form (955-1024, 1297-1346) substantially duplicate the standalone ContactsPageView (1764-1959).
  - Heaviest JSX (ElizaOsAppsView.tsx:372-377, tab): `` `inline-flex h-9 items-center gap-2 rounded-sm border px-3 text-sm font-medium ${isActive ? "border-primary bg-primary text-primary-foreground" : "border-border bg-bg text-txt"}` ``.
  - ElizaOsAppsView.tsx:404 (dialpad): `"aspect-[1.6] rounded-sm border border-border bg-bg text-lg font-semibold text-txt hover:border-primary"`.
- **Heaviness / slop critique:** Blue token usage breaks the orange-only rule; ~9 title-restating description paragraphs; 3-level border nesting; duplicated contacts surface; SMS-gateway env-var + `fetch` forwarding logic (95-110, 1532-1595) embedded in a "view" file.
- **Minimization recommendations:** Swap every `primary`/`primary-foreground`/`hover:border-primary` → `accent`. Delete the ~9 Panel descriptions. Flatten the dialer panel's 3-level bordered sub-cards. De-duplicate contacts (one ContactsPageView, reused by Phone). Move SMS-gateway forwarding out of the view into a service. Voice-forward: "call Mom" / "text Alex …" should run through chat, leaving the dialpad as a fallback.
- **Agent-surface:** Both `useAgentElement` and `ShellViewAgentSurface` (viewIds `elizaos-apps-phone`/`-messages`/`-contacts`). Many element ids (phone-tab-*, dialpad-*, recent-call-*, dialer-*, messages-*, contacts-*).
- **Even-simpler note:** Messages/Contacts could each be one glanceable list + chat compose. The dialpad is the only thing that genuinely needs a dedicated surface.

---

## SECTION B — PLUGINS surface

### B1. PluginsPageView
- **id / route / file:** `plugins` / `/apps/plugins` / `pages/PluginsPageView.tsx` (27 lines)
- **Purpose:** Route shim → `ShellViewAgentSurface viewId="plugins-page"` → `PluginsView mode="all-social"`.
- **States:** none (passthrough).
- **Current visual structure:** Zero — cleanest file in the set.
- **Minimization recommendations:** None. Keep.

### B2. PluginsView (monolith)
- **id / route / file:** `plugins` / `/apps/plugins` / `pages/PluginsView.tsx` (1440 lines)
- **Purpose:** Master controller (`PluginListView`) owning all plugin state + 4 render shells (connector-sidebar-editor, game modal, default card-grid) keyed by `mode`/`inModal`.
- **States:** sidebar-editor shell (social mode), game-modal shell, default card-grid; per-shell empty/populated; in-flight toggle notice; subgroup chip filter bar; localStorage drag-order + reset; `PluginSettingsDialog` always mounted. **Search has no in-page input** — hijacked from the floating chat composer via `useRegisterViewChatBinding` (85-96) with a `ChatSearchHint`.
- **Current visual structure:** `border`=grep across file ~6 inline. Header `<header>` with "ADVANCED" eyebrow + `<h1>` + "{{count}} shown" pill (1288-1303 — decorative chrome). Three near-duplicate `PagePanel.Empty` copy blocks (1161/1341/1354). ~30 `t()` label constants declared up-front (119-215). Redundant mode-flag aliases (231-247): `isConnectorShellMode === isSocialMode === isSidebarEditorShellMode === (mode==="social")`. `_handleConnectorSelect` unused (1079). `connectorDesktopPlacement` prop accepted but `ConnectorSidebar` NOT rendered in the social branch (renders `ConnectorPluginGroups`).
  - Heaviest JSX (PluginsView.tsx:1222): `"chat-native-scrollbar relative flex flex-1 min-w-0 flex-col overflow-x-hidden overflow-y-auto bg-transparent px-4 pb-4 pt-2 sm:px-6 sm:pb-6 sm:pt-3 lg:px-7 lg:pb-7 lg:pt-4"`.
  - PluginsView.tsx:344-348 (subgroup chip nested ternary) + 353-358 (count sub-badge inside the chip = badge-in-button).
- **Heaviness / slop critique:** "ADVANCED" eyebrow + count pill above the grid is pure chrome. Redundant mode-flag aliases + unused handler + unwired `ConnectorSidebar` path. Three duplicate empty states. Drag-and-drop ordering is heavy for a niche feature.
- **Minimization recommendations:** Delete the "ADVANCED" eyebrow, count pill, the redundant mode-flag aliases, `_handleConnectorSelect`, and the unwired sidebar path (verify with grep first). Unify the 3 empty states. Keep the chat-driven search (good — matches direction). The subgroup chip bar could become a single segmented control or move into chat ("show wallet plugins").
- **Agent-surface:** 1 `useAgentElement`: `reset-plugin-order` (button). Shell wrapper from PluginsPageView.
- **Even-simpler note:** A glanceable installed-plugins grid + chat for enable/disable/configure ("turn on Discord", "configure Telegram"). The drag-order feature is a candidate for removal.

### B3. PluginCard
- **id / route / file:** child of PluginsView / `pages/PluginCard.tsx` (551 lines)
- **Purpose:** Single plugin tile — name/icon/toggle/status badges + inline install/update/uninstall/release/settings.
- **States:** showcase (DEMO badge), enabled+ready, needs-config, no-config, enabled-not-active, toggling, drag states, open/settings, validation errors, per-action busy.
- **Current visual structure:** **`border`=40 (verified).** **Badge overload: up to 5+ simultaneous pill badges** in the footer (357-408), each a separate bordered/tinted `rounded-full` span. Left-accent `border-l-[3px]` traffic-light (239-245) **duplicates** info already shown by the toggle + Ready badge. Up to 8 action buttons per card. Inner status dot inside the Ready badge (badge-in-badge). `&#9881;` HTML-entity gear (530) instead of an icon. `backdrop-blur-sm` with no backdrop (line 40).
  - Heaviest JSX (PluginCard.tsx:289-297): `` `group relative flex flex-col rounded-lg border border-border bg-card transition-all duration-150 … ${isOpen ? "ring-1 ring-accent border-accent/50" : "hover:border-accent/40 hover:shadow-[0_2px_18px_-8px_rgba(var(--accent-rgb),0.35)]"} …` `` — 5-way conditional border/ring/shadow/opacity pileup.
- **Heaviness / slop critique:** Status is encoded redundantly THREE ways (left-border color + badge + toggle). 8 inline action buttons crowd each card.
- **Minimization recommendations:** Collapse Ready/NoConfig/inactive/restarting into ONE status element (dot or single pill). Drop the left-`border-l-[3px]` traffic light. Reduce visible per-card buttons to toggle + a "⋯" overflow; install/update/uninstall move into the settings dialog or chat. Replace `&#9881;` with a `Settings` icon. Remove `backdrop-blur-sm`.
- **Agent-surface:** 7 `useAgentElement` (toggle/release-main/release-beta/install/update/uninstall/settings, all `group: "plugin-card"`) + resource-link ids — registered even when the button isn't rendered.

### B4. PluginConfigForm
- **id / route / file:** child / `pages/PluginConfigForm.tsx` (231 lines)
- **Purpose:** Bridges plugin `parameters[]` → generic `ConfigRenderer` schema engine; + Telegram allow-all/specific toggle.
- **States:** Telegram two-mode toggle; otherwise delegates to ConfigRenderer (no own loading/empty/error).
- **Current visual structure:** One bordered Telegram row; 2 helper-text spans explaining an obvious toggle. Non-token color: `bg-[var(--card,rgba(255,255,255,0.03))]` (line 67) bypasses the design system.
- **Minimization recommendations:** Fix `bg-[var(--card,…)]` → `bg-card`. Cut the two helper spans. Mostly lean already.
- **Agent-surface:** none (delegated to ConfigRenderer).

### B5. plugin-view-sidebar
- **id / route / file:** child (desktop connector rail) / `pages/plugin-view-sidebar.tsx` (371 lines)
- **Purpose:** Desktop collapsible connector nav rail with per-row select/toggle/expand + category `Select` filter.
- **States:** collapsed→null, rail mode, empty, populated; per-row selected/expanded/busy.
- **Current visual structure:** Mostly delegates to `SidebarContent.*` composites; few raw borders. Local `mergeRefs` re-implementation (25-37).
- **Heaviness / slop critique:** **Appears NOT rendered by PluginsView's social branch** (renders `ConnectorPluginGroups`, not `ConnectorSidebar`) — likely an unwired/legacy sidebar path. 3 `useAgentElement` per row is heavy for a nav item.
- **Minimization recommendations:** **Verify with grep, then likely delete** the unwired sidebar path + `connectorDesktopPlacement` plumbing in PluginsView.
- **Agent-surface:** `connector-sidebar-category-filter` (select), `connector-rail-${id}`, `connector-sidebar-${id}-select/-toggle/-expand`.

### B6. plugin-view-connectors (monolith)
- **id / route / file:** child / `pages/plugin-view-connectors.tsx` (1296 lines)
- **Purpose:** Connector accordion — per-connector collapsible card with mode selector, Cloud OAuth (Slack/Twitter/Google), managed-Discord, Telegram gateway, inline config, validation, test/reset/save.
- **States:** single vs multi-group (multi wraps each in a floating-label fieldset); per card expand/select/ready/busy/saving; up to **5+ stacked `PagePanel.Notice` panels** in one expanded card.
- **Current visual structure:** `border`=grep ~8 inline. Heavy hardcoded copy table `CLOUD_OAUTH_CONNECTORS` (154-182) with near-identical Slack/Twitter/Google hint strings. Status icon swap (CheckCircle2/AlertCircle) duplicates the "X/Y configured" heading text. **No-op ternary** `${isSelected ? "" : ""}` (line 913). Multi-group floating-label fieldset is decorative chrome.
  - Heaviest JSX (plugin-view-connectors.tsx:1220-1228): test button — a 4-deep nested ternary of border/bg/hover (loading/success/error/default).
  - plugin-view-connectors.tsx:1283 fieldset `"relative rounded-sm border border-border/30 px-2 pb-2 pt-5"` + absolute floating label (1285).
- **Heaviness / slop critique:** Notice overload (5+ multi-sentence prose panels). Duplicated OAuth copy. No-op ternary. Status encoded redundantly (icon + heading + badge).
- **Minimization recommendations:** Cut notice prose to one line each; consolidate the OAuth copy table; delete the no-op ternary; drop the floating-label fieldset chrome; remove the redundant status icon. **Extract a shared `TestConnectionButton`** (the 4-deep ternary is duplicated in plugin-view-dialogs and PluginCard).
- **Agent-surface:** 10 ids per card (`connector-${id}-toggle/-expand/-managed-discord/-managed-discord-continue/-telegram-open-cloud/-install/-test/-reset/-save/-managed-discord-agent`) + oauth/link sub-ids.

### B7. plugin-view-modal
- **id / route / file:** child (game modal) / `pages/plugin-view-modal.tsx` (493 lines)
- **Purpose:** Full-screen gamified master-detail plugin modal (CSS-class-driven `plugins-game-*`).
- **States:** list empty/populated, detail empty/populated, mobile drill-down.
- **Current visual structure:** Few inline borders (heaviness hidden in external CSS). Non-token color `bg-black/10` (line 407). **Parallel config implementation:** `PluginGameParamField` (116-158) re-implements a bare label+`<Input>` config editor instead of reusing PluginConfigForm/ConfigRenderer. **3rd copy of icon resolution** (`ResolvedPluginIcon`, 187-217).
- **Minimization recommendations:** Strong candidate for **removal** — it is a third parallel plugin surface (alongside the card-grid + connector accordion) with its own duplicate config path and icon resolver. Consolidate to one plugin surface.
- **Agent-surface:** `plugin-game-card-${id}`, `plugin-game-${id}-link-${k}`, `plugin-game-${id}-param-${k}`, `plugin-game-back/-toggle/-test/-save`.

### B8. plugin-view-dialogs
- **id / route / file:** child (settings dialog) / `pages/plugin-view-dialogs.tsx` (348 lines)
- **Purpose:** Modal settings dialog for a single plugin in the card-grid — metadata header + tags + npm/deps + config form + footer actions.
- **States:** no-plugin→null, showcase, description/tags/npm/deps conditional, Telegram-vs-generic config, footer install/test/reset/save.
- **Current visual structure:** **Duplicated test-button 4-deep ternary** (289-297) shared with plugin-view-connectors. **3rd-or-4th copy of icon resolution** (`SettingsDialogIcon`, 47-67). `backdrop-blur-md` decorative blur. Two trailing-space className bugs (257, 323). Two stacked metadata rows (description+tags / npm+deps) that could merge.
- **Minimization recommendations:** Use the shared `TestConnectionButton`; merge the two metadata rows; fix trailing-space classNames; remove `backdrop-blur-md`.
- **Agent-surface:** `plugin-dialog-install/-test/-reset/-save`.

**Cross-plugin slop (load-bearing):** Icon resolution implemented **3-4×** (PluginsView.renderResolvedIcon 844-877, plugin-view-modal 187-217, plugin-view-dialogs 47-67). **3 config-form surfaces** for the same params (PluginConfigForm schema engine, PluginGameParamField raw inputs, ConnectorSetupPanel). **Test-button ternary duplicated 3×**. **Two ~1300-line monoliths** (PluginsView + plugin-view-connectors) carry the weight.

---

## SECTION C — CONFIG page (Wallet & RPC)

### C1. ConfigPageView
- **id / route / file:** embedded in Settings `wallet-rpc` section (via WalletRpcSection) / `pages/ConfigPageView.tsx` (783 lines) + `pages/config-page-sections.tsx` (455 lines)
- **Purpose:** Agent-level wallet RPC provider config: Eliza-Cloud-vs-Custom mode selector, per-chain (EVM/BSC/Solana) provider buttons + API-key inputs, Cloud-services toggles, Secrets modal.
- **States:** cloud mode (connected → 3 chain rows + CloudServicesSection; disconnected → connect CTA), custom mode (3 RpcConfigSection), legacy-RPC warning banner, Secrets modal, saving.
- **Current visual structure:** Two large mode-selector cards with `border-2`, inline SVG icons, descriptions, and a check-circle badge each (390-488). Inline hand-drawn SVGs for cloud/wrench/lock (multiple). Per-chain provider button rows. Cloud-services section = 4 toggle rows each with label + description `<p>` (config-page-sections.tsx:417-453).
  - Heaviest JSX (ConfigPageView.tsx:397-401): `"relative flex flex-col items-start gap-1.5 rounded-sm border-2 p-4 text-left transition-all h-auto !whitespace-normal ${rpcMode === "cloud" ? "border-accent bg-accent/8 " : "border-border/40 bg-card/30 opacity-50 grayscale hover:opacity-70 hover:grayscale-0"}"`.
- **Heaviness / slop critique:** The two `border-2` mode cards with descriptions + SVG + check badge are heavy for a binary choice. Several inline hand-drawn SVGs (cloud/wrench/lock/key) instead of lucide icons. Cloud-services descriptions restate the labels. `grayscale`+`opacity-50` on the unselected card is a heavy treatment.
- **Minimization recommendations:** Convert the cloud/custom mode cards → a compact segmented toggle (2 icons + labels, no descriptions, no SVGs, no check badge). Replace inline SVGs with lucide icons (Cloud/Wrench/Lock/Key). Cut the 4 cloud-service descriptions to labels + icons. Most users want "Eliza Cloud, done" — default to cloud and hide custom behind a disclosure.
- **Agent-surface:** `ShellViewAgentSurface viewId="config"`. Elements: `rpc-mode-cloud`, `rpc-mode-custom`, `cloud-connect`, `wallet-rpc-save`, `open-secrets`.
- **Even-simpler note:** For cloud-default users this whole view is "RPC: Eliza Cloud ✓" + a "customize" link. Could merge into the wallet settings row.

---

## SECTION D — SETTINGS surface

The Settings shell (`pages/SettingsView.tsx`, 399 lines) is **well-architected and on-direction**: a nav rail (desktop) / grouped hub (mobile) built from the standardized `SettingsStack`/`SettingsGroup`/`SettingsRow` iOS-grouped-list primitives (`settings/settings-layout.tsx`). Sections are data-driven from `settings-section-meta.ts` (16 built-ins in 3 groups: Agent / System / Security) + a registry. `ShellViewAgentSurface viewId="settings"`, one agent element per nav row (`section-${id}`). **The shell is the reference for the redesign; the problem is the section *bodies* that ignore the primitives and hand-roll chrome.**

Full settings directory file list (`packages/ui/src/components/settings/`):
`AdvancedSection.tsx`, `AdvancedToggle.tsx`, `ApiKeyConfig.tsx`, `AppearanceSettingsSection.tsx`, `AppPermissionsSection.tsx`, `AppsManagementSection.tsx`, `CapabilitiesSection.tsx`, `CloudAgentsSection.tsx`, `ConnectorsSection.tsx`, `DesktopWorkspaceDisplay.tsx`, `DesktopWorkspaceSection.tsx`, `IdentitySettingsSection.tsx`, `LoadContentPackForm.tsx`, `LoadedPacksList.tsx`, `permission-controls.tsx`, `PermissionsSection.tsx`, `PolicyControlsView.tsx`, `ProviderCard.tsx`, `ProviderPanels.tsx`, `ProviderRoutingPanel.tsx`, `ProviderSwitcher.tsx`, `RemotePluginHostSection.tsx`, `RuntimeSettingsSection.tsx`, `SecretsManagerSection.tsx`, `SecuritySettingsSection.tsx`, `settings-agent-rows.tsx`, `settings-control-primitives.tsx`, `settings-layout.tsx`, `settings-section-*.ts`, `SubscriptionStatus.tsx`, `VaultInventoryPanel.tsx`, `VoiceConfigView.tsx`, `VoiceProfileSection.tsx`, `VoiceSection*.tsx`, `VoiceTierBanner.tsx`, `WalletKeysSection.tsx`, `WalletRpcSection.tsx`, `XRSettingsSection.tsx`, plus `vault-tabs/` and `*.stories.tsx`/`*.test.tsx`/`*.hooks.ts` helpers. (Voice section is a separate review track.)

Conformance verdict per assessed section (heaviest → cleanest), with verified inline `grep border` counts:

| Section (id) | File | Conforms? | border | Verdict |
|---|---|---|---|---|
| Security | SecuritySettingsSection.tsx | **NO — bespoke** | 22 | Worst settings offender (see D1) |
| Backup & Reset | AdvancedSection.tsx | **NO — decorative cards** | 28 | Hero lift-cards (see D2) |
| Apps | AppsManagementSection.tsx | **NO — raw table** | 15 | Raw `<table>`+`<select>` (see D3) |
| Models & Providers | ProviderPanels.tsx | **NO — reimpl header** | 8 | `ProviderPanelHeader` duplicates SettingsRow (D4) |
| Remote Plugins | RemotePluginHostSection.tsx | partial | 6 | `RemotePluginRow`→SettingsRow; kill About essay |
| Connectors | ConnectorsSection.tsx | mixed | 6 | Bespoke `<details>` card-per-row |
| Permissions | permission-controls.tsx | badge-heavy | 8 | 3 inline pills → shared StatusBadge |
| App Permissions | AppPermissionsSection.tsx | mostly | 8 | group-per-app is verbose |
| Wallet Keys | WalletKeysSection.tsx | mostly | 9 | bespoke add-form card |
| Vault | SecretsManagerSection.tsx | yes (launcher) | 13 | section fine; heavy tabbed modal |
| Capabilities | CapabilitiesSection.tsx | yes (form-heavy) | ~0 | move router form behind disclosure |
| Identity | IdentitySettingsSection.tsx | **YES** | ~5 | leave alone |
| Cloud Agents | CloudAgentsSection.tsx | mostly | 0 | 2 bespoke flex rows; missing agent ids |
| Appearance | AppearanceSettingsSection.tsx | **YES** | ~2 | clean; language/mode tiles |
| Runtime | RuntimeSettingsSection.tsx | **YES — reference** | 0 | gold standard |
| Wallet & RPC | WalletRpcSection.tsx | **YES — shim** | 0 | composes ConfigPageView (see C1) |
| Updates | ReleaseCenterView.tsx | **YES** | 6 | see E2 |

### D1. SecuritySettingsSection (security) — file `settings/SecuritySettingsSection.tsx` (37KB, biggest)
- **Purpose:** Remote-access security — access-mode status, active-session list + revoke, set/change remote password (3 sub-areas: `AccessModeSection` / `SessionsSection` / `RemotePasswordSection`).
- **States:** Access has a 4-phase state (loading/loaded/locked/error) with ~150 lines of per-phase `t()` title/detail/status/tone permutations (272-419). Sessions loading/error/loaded/empty + per-row revoking. Password idle/submitting/success/error × setup/change/locked/loading + confirm-mismatch.
- **Heaviest JSX:** `SectionShell` inner card `"space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5"` (line 79, used 3× = card-in-bare-group). `AccessInfoRow` `"grid gap-1 border-t border-border/30 py-2.5 first:border-t-0 sm:grid-cols-[10rem_minmax(0,1fr)] …"` (line 217, ×6, nested in another bordered box line 460 = card-in-card-in-group). Local `StatusBadge` (241) duplicates the shared `ui/status-badge`. 11 `<p>` help paragraphs. Does **not use SettingsRow at all**.
- **Minimization recommendations:** Kill `SectionShell` → use non-bare `SettingsGroup` directly. Convert `AccessInfoRow` grid → `SettingsRow` (label + value + description). Delete the duplicate local `StatusBadge`. Table-drive the access copy permutations. Refresh links → group `action`.
- **Agent-surface:** `security-access-refresh`, `security-sessions-refresh`, `security-sessions-sign-out-everywhere`, `security-session-revoke-${id}`, `security-password-display-name/-current/-new/-confirm/-submit`.

### D2. AdvancedSection (backup & reset) — `settings/AdvancedSection.tsx`
- **Purpose:** Export/import password-encrypted backup + Developer-Mode toggle + Danger-Zone reset.
- **Heaviest JSX:** Two hover-lift "hero" card-buttons — `"min-h-[5.5rem] h-auto rounded-lg border border-border bg-card p-5 … hover:-translate-y-0.5 hover:border-accent"` (line 174, dup 193) with an oversized 56px nested icon medallion (`h-14 w-14`, 178). 3 dialogs with 4 near-identical danger/ok banner blocks (294/302/404/412). **`-translate-y-0.5` hover-lift + box-shadow transition violates the neutral-hover rule.**
- **Minimization recommendations:** Replace the two hero cards with plain `SettingsRow` nav rows (icon + label + chevron) that open the dialogs. Extract one shared modal-result banner. Drop the hover-lift transition.
- **Agent-surface:** `advanced-export-open/-import-open/-reset-open`, `advanced-export-password/-include-logs/-submit`, `advanced-import-browse/-password/-submit`, `advanced-reset-confirm`, + cancels.

### D3. AppsManagementSection (apps) — `settings/AppsManagementSection.tsx`
- **Purpose:** Installed-apps inventory `<table>` + create-app form + load-from-directory form + verify-on-relaunch toggle.
- **Heaviest JSX:** Raw HTML `<table>` in `"overflow-x-auto rounded-lg border border-border"` (line 761) → `<table className="w-full min-w-[34rem] text-left text-sm">`. Raw `<select>` `"block h-11 w-full rounded-md border border-border bg-card …"` (585) reimplements `SettingsSelectRow`. Two near-identical inline form panels with duplicate submit/cancel (600-643 vs 682-724).
- **Minimization recommendations:** Convert the table → grouped list of app `SettingsRow`s. Replace raw select/inputs with `settings-agent-rows`. Collapse the two inline forms into one.
- **Agent-surface:** `apps-create-toggle/-load-toggle/-verify-on-relaunch`, `apps-create-intent/-edit-target/-submit/-cancel`, `apps-load-directory/-submit/-cancel`, per-app `apps-launch/-relaunch/-edit/-stop-<name>`.

### D4. Models & Providers (ai-model) — `ProviderSwitcher.tsx` + `ProviderPanels.tsx` + `ProviderCard.tsx`
- **Purpose:** Pick provider (card grid) → render matching config panel (Local/Cloud/Subscription/ApiKey) → Advanced disclosure (routing matrix + devices).
- **Conformance:** `ProviderSwitcher` conforms (delegates everything; the model the others should imitate). `ProviderPanels` does NOT — `ProviderPanelHeader` (37-71) hand-rebuilds the SettingsRow header (medallion `"… h-9 w-9 … rounded-md bg-surface text-txt-strong ring-1 ring-border/70"`, line 54, a **verbatim copy** of SettingsRowBody's medallion) + bordered `<header border-b>` per panel; duplicated local-only-paused warn banner (262, 341). `ProviderCard` is a justified primitive but its category chip (Cloud/Subscription/API key/Local) duplicates icon+state-label = badge overload.
- **Minimization recommendations:** Replace `ProviderPanelHeader` with `SettingsGroup` title/description/action. Extract the warn banner. Cut the ProviderCard category chip. Reuse the SettingsRow medallion class.
- **Agent-surface:** `provider-<id>` (ProviderCard); `local-use-local-only`, `cloud-use-cloud`, `sub-use-<id>`, `apikey-use-<panelId>` (panels).

### D5. Cross-settings consolidation seams (verified)
- Medallion class `"h-9 w-9 … rounded-md bg-surface text-txt-strong ring-1 ring-border/70"` copy-pasted in `settings-layout.tsx:160`, `ProviderPanels.tsx:54`, `ProviderCard.tsx:94` — three definitions of one atom.
- Warn-banner string `"rounded-sm border border-warn/30 bg-warn/5 … text-warn"` recurs (ProviderPanels ×2, AppsManagement).
- `permission-controls.tsx` has 3 hand-rolled pills (155/232/241) that should be the shared `StatusBadge`.

---

## SECTION E — Other system views (Cloud / Release / Runtime / Secrets / Heartbeats)

### E1. ElizaCloudDashboard
- **id / route / file:** embedded in AI-Model/Cloud provider panel (not a standalone tab) / `pages/ElizaCloudDashboard.tsx` (996 lines)
- **Purpose:** Eliza Cloud account widget — credit balance, Stripe top-up checkout, auto-top-up billing settings.
- **States:** disconnected/login, two internal views (`overview`/`billing` via `cloudDashboardView`), loading, rate-limited countdown banner, auth-rejected alert, billingError alert, Stripe checkout `Dialog`, top-up + auto-top-up forms.
- **Current visual structure:** **`border`=30 (verified).** ~540 lines of logic (rate-limit dual-detection, OAuth callback) before any JSX. 2 status chips (account pill + auto-top-up pill, 717-747) that duplicate info. Heavy i18n string-concatenation defaults inflating the file. Flat (no card-in-card, 0 gradients).
  - Heaviest JSX (ElizaCloudDashboard.tsx:640): status chip `"shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wider ${statusChipClass}"`.
- **Heaviness / slop critique:** Two redundant pill chips; uppercase `text-[10px]` micro-chips; the back-arrow-navigated overview/billing split adds a hidden mode.
- **Minimization recommendations:** Collapse account + auto-top-up chips to one line. Drop uppercase `text-[10px]` micro-chips → plain text + color. Surface "credits: $X, auto-top-up on" as one glanceable line; top-up via chat ("add $20 credits"). Merge overview/billing into one scroll.
- **Agent-surface:** **NONE** (no `useAgentElement` / `ShellViewAgentSurface`) — not agent-controllable. A redesign should add agent elements (connect / top-up / toggle auto-top-up).

### E2. ReleaseCenterView (Updates)
- **id / route / file:** Settings `updates` section / `pages/ReleaseCenterView.tsx` (668 lines)
- **Purpose:** App/agent update center — version rows, check/apply updates, release-notes URL.
- **States:** error/status/auto-update-disabled banners, loading, desktop-vs-web branches, agent-update branch, release-notes URL form.
- **Current visual structure:** **`border`=6 (verified — cleanest page view).** Fully built on shared `SettingsGroup`/`SettingsRow`/`SettingsStack`. No bespoke cards/badges. The bloat is the `versionRows` array (306-425, up to 13 flat rows). 3 near-identical agent-button wrappers (40-132) exist only to register agent ids.
- **Minimization recommendations:** Fold the 6 agent-version rows behind a disclosure (show App version + a single "up to date / update available" status by default). Collapse the 3 button wrappers into one parametrized wrapper. This is **the model other views should emulate.**
- **Agent-surface:** 7 ids — `updates-check/-apply/-open-detached/-refresh/-open-release-notes/-reset-release-url/-release-notes-url`.

### E3. RuntimeView
- **id / route / file:** `runtime` / `/apps/runtime` / `pages/RuntimeView.tsx` (819 lines)
- **Purpose:** Developer runtime-inspector — sidebar section nav + summary order-cards + recursive JSON tree of the runtime snapshot.
- **States:** loading skeleton, empty, runtime-offline empty, error banner, summary (6 order-cards) vs section (header + 4 meta-cards + recursive tree); 7-section sidebar; chat-bound search; depth/array-cap/object-cap inputs.
- **Current visual structure:** **THE WORST page offender: `border`=63, `linear-gradient`=26 (verified — the only file using gradients).** The 3 sidebar numeric inputs each carry an identical ~640-char gradient+backdrop-blur+`::before`-shimmer string (540/560/580). The Refresh/Expand/Collapse pill button repeats a ~520-char gradient string 4× (594/606/734/747). `ServicesOrderCard` nests `PagePanel` 3 levels deep. Oversized `text-[2rem]` section header + kicker + description + 4 meta-cards around what is just a JSON tree.
  - Heaviest JSX (RuntimeView.tsx:540): `"relative overflow-hidden border border-border/28 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_86%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] backdrop-blur-md transition-[border-color,background-color,box-shadow] duration-200 before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.24),transparent)] hover:border-border/40 … focus-within:border-accent/24 … h-9 rounded-sm px-3 text-sm text-txt"`.
- **Heaviness / slop critique:** This is a developer JSON inspector dressed up with 26 gradients, backdrop-blur, shimmer pseudo-elements, and 3-deep card nesting. The gradient strings are the single biggest cleanup target in the whole package.
- **Minimization recommendations:** Strip ALL gradients/backdrop-blur/`::before` shimmer → flat input/button variants. Remove the 4 meta-cards + oversized header. Make the section nav a simple list. Keep the chat-bound search (good).
- **Agent-surface:** `ShellViewAgentSurface viewId="runtime"`; **no per-element `useAgentElement`** (gap — refresh/inputs not agent-addressable).
- **Even-simpler note:** This is a power-user/dev surface. Could be gated behind Developer Mode and reduced to a flat searchable tree; "what services are registered?" is a chat question.

### E4. SecretsView
- **id / route / file:** opened as a modal from ConfigPageView / `pages/SecretsView.tsx` (610 lines)
- **Purpose:** Secrets "vault" — pin/group env secrets by category, edit masked values, add via search-picker modal.
- **States:** loading skeleton, error+retry, empty vault, populated category sections (collapsible), `SecretPicker` dialog (search + grouped add-list + empty/no-match), per-card value input + show/hide, save bar with dirty count.
- **Current visual structure:** **`border`=39 (verified).** **Empty description div** rendered with no content (`<div className="m-0 max-w-2xl text-sm leading-6 text-muted" />`, line 268) — dead markup. **Redundant double border tokens** on save bar: `"… border border-border/50 bg-card/92 … border-border/60 …"` (line 348). Hand-rolled card shell `"rounded-sm border border-border/50 bg-card/92"` repeated 5× (247/297/348/533/582). Per-card chrome: status dot + key + Required badge + Remove + "Used by N plugins…" line + masked box + input + Show/Hide. Picker duplicates the "active plugin(s)" derivation that SecretCard also computes.
- **Heaviness / slop critique:** Dead empty `<div>`; conflicting border tokens; 5 hand-rolled copies of one card surface; heavy per-row chrome.
- **Minimization recommendations:** Delete the empty description div. Fix the double-border token. Extract one `Card` primitive for the 5 copies. Collapse per-row to: key + status dot + value (tap to reveal/edit). Drop the "Used by N plugins" sentence (or make it a tooltip).
- **Agent-surface:** `ShellViewAgentSurface viewId="secrets"`; **no per-element `useAgentElement`** (gap).
- **Even-simpler note:** Overlaps the Settings → Vault (`SecretsManagerSection`) surface — these two secrets UIs should be unified into one.

### E5. HeartbeatsView
- **id / route / file:** `triggers`/`automations` family / reached via `/automations` / `pages/HeartbeatsView.tsx` (1096 lines)
- **Purpose:** Scheduled-trigger ("heartbeats") manager — sidebar list + templates + read pane + hosts the create/edit `HeartbeatForm` (master-detail).
- **States:** loading, error, first-run empty vs select-placeholder, sidebar list (+no-match empty) + templates (user/built-in) + collapsed rail, detail read-pane (header + 4 summary cards + run-history loading/empty/populated), editor mode (HeartbeatForm), long-running-host warning banner, mobile back, chat-bound search.
- **Current visual structure:** **`border`=16 (verified — moderate; chrome delegated to PagePanel/SidebarContent).** **Two identical public exports** `HeartbeatsView` + `HeartbeatsDesktopShell` (1082-1096) — redundant. **Run-history list duplicated** with HeartbeatForm's `HeartbeatRunHistory`. 4 summary cards is a lot of chrome. `LongRunningHostBanner` (72-122) is a long multi-sentence help paragraph. Controller returns a 40+-field object then re-destructures it. Detail header has 4 action buttons (pause/edit/duplicate/run-now).
  - Heaviest JSX (HeartbeatsView.tsx:816): mobile back `"mb-3 flex items-center gap-2 rounded-sm border border-border/30 bg-bg/25 px-4 py-3 text-base font-medium text-muted hover:text-txt md:hidden"`.
- **Heaviness / slop critique:** Duplicate export; duplicate run-history; 4 summary cards; long banner prose.
- **Minimization recommendations:** Delete the duplicate `HeartbeatsDesktopShell` export. Unify run-history with HeartbeatForm into one component. Collapse the 4 summary cards to one line (schedule + next run + last status). Shrink the long-running banner to one sentence + icon. Reduce the 4-button toolbar.
- **Agent-surface:** `ShellViewAgentSurface viewId="heartbeats"`; 7 ids — `new-heartbeat`, `toggle-heartbeat-enabled/edit-heartbeat/duplicate-heartbeat/run-heartbeat-now/refresh-run-history`.

### E6. HeartbeatForm
- **id / route / file:** child of HeartbeatsView / `pages/HeartbeatForm.tsx` (1465 lines, 50KB)
- **Purpose:** Create/edit a single heartbeat — what to run (prompt vs workflow), when (interval/once/cron/event), run behavior, inline schedule preview + run history.
- **States:** NOT a wizard — one long scrolling form of **4 grouped panel sections** keyed by `triggerType`/`kind`. ~11-13 fields (displayName, kind-toggle, instructions, workflowId, triggerType, wakeMode, durationValue, durationUnit, scheduledAtIso, cronExpression, eventKind, maxRuns, enabled). Template notice, error notice, edit-vs-create toolbar, workflow picker (loading/empty/populated), cron valid/invalid, event preset/custom, schedule-preview, host-warning, run-history (edit only).
- **Current visual structure:** **`border`=40 (verified).** **3 identical section-box shells** `"grid gap-4 rounded-sm border border-border/30 bg-bg/20 p-4"` (429/447/622). Prompt/Workflow tab pair duplicates its full ternary class string twice (837-855). **21 `useAgentElement` registrations** (~80 lines of pure boilerplate before JSX, 253-335) — the main reason the file is 50KB. **Duplicated run-history** with HeartbeatsView (even uses a different fallback date). `AgentSelectField` wraps 5 selects with double-wired state. 4 speculative label-override props the caller never sets.
- **Heaviness / slop critique:** Boilerplate-driven 50KB (21 agent registrations + many tiny wrapper components), not deep markup. 3 hand-rolled identical section shells. Duplicated tab ternary + run-history. Speculative props.
- **Minimization recommendations:** Extract one `FormSection` for the 3 shells + one shared `HeartbeatRunHistory`. Extract a registration helper to shrink the 21 inline blocks. Delete the 4 unused label-override props. Single-wire `AgentSelectField`. Make the form a stepper or progressive disclosure (most users want "every morning, do X" — interval/cron complexity hides behind "advanced").
- **Agent-surface:** 21 ids (heaviest in set): `heartbeat-run-now/-toggle-enabled/-delete/-display-name/-max-runs/-enabled/-save-template/-submit/-cancel/-duration-value/-scheduled-at/-duration-unit/-trigger-type/-wake-mode/-kind-prompt/-kind-workflow/-instructions/-go-to-workflows/-workflow-select/-cron-expression/-cron-example-<expr>(×3)/-event-kind/-event-name/-refresh-runs`.
- **Even-simpler note:** Strong candidate for a **chat-first builder**: "remind me every weekday at 9am to review my inbox" → agent fills the form. The form becomes a confirm/edit sheet, not the primary entry path.

---

## TOP-LEVEL SYNTHESIS

### Worst slop offenders (by verified heaviness)
1. **RuntimeView.tsx** — 63 `border`, **26 `linear-gradient`** (the only gradients in the package), backdrop-blur + shimmer pseudo-elements, 3-deep card nesting. A dev JSON inspector wearing a tuxedo. The ~640-char input string (×3) and ~520-char button string (×4) are the single biggest cleanup target.
2. **AppDetailsView.tsx** — 66 `border`, 7 `text-[`. 6 always-uppercase section headers, provenance badge cluster, nested bordered stat grid + fieldset-in-card, label-as-button, pervasive `text-[10px]` micro-typography.
3. **PluginCard.tsx** (40 border) + **plugin-view-connectors.tsx** — badge overload (5+ pills), status encoded 3 ways, 8 buttons/card, notice-prose overload, duplicated test-button ternary (3×) and icon-resolver (3-4×).
4. **HeartbeatForm.tsx** (50KB / 40 border) — 21 agent-registration blocks + duplicated section shells/run-history/tab-ternary.
5. **SecuritySettingsSection.tsx** (22 border, no SettingsRow) + **AdvancedSection.tsx** (28 border, hover-lift hero cards) — the two settings sections that ignore the standardized primitives.
6. **ElizaOsAppsView.tsx** (53 border) — **brand violation** (blue `primary` tokens, not orange `accent`, lines 374/404/433) + ~9 title-restating descriptions + duplicated contacts UI.

### Highest-impact simplifications
- **Strip RuntimeView gradients/blur/shimmer** → flat variants. One change removes the heaviest JSX in the package.
- **Adopt the SettingsGroup/SettingsRow vocabulary everywhere.** RuntimeSettingsSection (0 border) and ReleaseCenterView (6 border) prove the pattern; SecuritySettingsSection, AdvancedSection, AppsManagementSection, ProviderPanels must convert.
- **Collapse status encodings to one element** (PluginCard's left-border + badge + toggle → one dot; AppDetailsView's 3-badge cluster → one dot+tooltip; ConnectorsSection's icon+heading+badge).
- **Fix the brand violation** in ElizaOsAppsView (blue → orange) and AppsPageView (green `#10b981` → orange).
- **Extract shared atoms:** one `TestConnectionButton`, one plugin `Icon` resolver, one `RunHistory`, one medallion class, one warn-banner, one `FormSection`, one modal-result banner. These dedups touch 12+ files.
- **Default-to-cloud + disclosure** for ConfigPageView (RPC mode cards → segmented toggle), Capabilities (router form), ReleaseCenter (agent rows), HeartbeatForm (advanced schedule).
- **Cut title-restating descriptions** across ElizaOsAppsView (9), CloudServices (4), provider/connector notices, plugin empty states.
- **Add agent-surface parity** to the three views that lack per-element wiring (ElizaCloudDashboard = none; RuntimeView/SecretsView = view-level only).

### Views removable / mergeable
- **plugin-view-modal.tsx** — a third parallel plugin surface with its own duplicate config path + icon resolver. **Remove**; consolidate to one plugin surface.
- **plugin-view-sidebar.tsx** + `connectorDesktopPlacement` plumbing — appears **unwired** (PluginsView social branch renders `ConnectorPluginGroups`, not `ConnectorSidebar`). **Verify + delete.**
- **SecretsView.tsx (modal)** overlaps **SecretsManagerSection / Vault**. **Merge** into one secrets surface.
- **ConfigPageView** for cloud-default users ≈ "RPC: Eliza Cloud ✓" — **merge** into a wallet settings row + "customize" disclosure.
- **AppDetailsView** → collapsible into a **launch sheet + chat affordance** ("open/launch X").
- **HeartbeatForm** → **chat-first builder** with the form as a confirm sheet.
- **HeartbeatsView** duplicate export `HeartbeatsDesktopShell` — **delete**.
- **RuntimeView** → gate behind Developer Mode; most queries are chat questions.
- **AppsView** dead `searchQuery` plumbing + vestigial "running" sub-tab — **delete**.

### Cross-cutting brand/token issues found
- Blue `primary`/`primary-foreground` tokens in ElizaOsAppsView (374/404/433) — violates orange-only.
- Green `#10b981` hardcoded accent in AppsPageView (73-80) — off-brand.
- Hover-lift `-translate-y-0.5` + box-shadow in AdvancedSection (174) — violates neutral-hover rule.
- Non-token colors: `bg-[var(--card,…)]` (PluginConfigForm:67), `bg-black/10` (plugin-view-modal:407).
- Uppercase `text-[10px]/tracking-[0.1Xem]` micro-typography is pervasive (AppDetailsView, AppsView, ElizaCloudDashboard) — decorative weight to cut.
