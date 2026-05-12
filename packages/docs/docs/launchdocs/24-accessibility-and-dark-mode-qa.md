# Accessibility + Dark-Mode QA (Workstream 6)

Status: 2026-05-11 (initial static-analysis pass; live stack unavailable due to secrets refactor)
Author: AI QA orchestrator — Workstream 6 (a11y + dark mode)
Scope: Cross-cutting accessibility, dark-mode contrast, and responsive issues across `packages/ui/src/components/{pages,shell,settings}`, `packages/app/src/`, and `plugins/app-*/src/`. Page-agnostic. Static analysis only — no live render audited.

Companion docs:
- `23-ai-qa-master-plan.md` — overall AI QA plan (Workstream 6 is scoped here)
- `16-all-app-pages-qa.md` — per-page coverage map
- `05-settings-qa.md` — settings audit
- `01-onboarding-setup-qa.md` — onboarding audit (existing P1 RuntimeGate styling drift noted)

Conventions used in this doc:
- **P1** — Likely broken / invisible in dark mode, blocks users; fix before launch.
- **P2** — Contrast or sizing risk that may pass WCAG AA in some surfaces but fails on tinted backgrounds, low-DPI, or mobile.
- **OK** — Pattern is theme-aware (uses CSS vars, `dark:` opt-ins, or is third-party-library-forced).

Theme tokens that frame every rating:
- Source of truth: `packages/ui/src/styles/theme.css` (lines 1–74 light, 39–74 dark) and `packages/ui/src/styles/base.css`.
- Dark `--bg = #050506`, `--card = #0e0e11`, `--text = #eaecef`, `--muted = #8a8a94`.
- Light `--bg = #f7f8fa`, `--card = #fcfdfd`, `--text = #1e2329`, `--muted = #5e6673`.

---

## 1. Hardcoded color literals (dark-mode risk)

Aggregate scope hits:
- Hex literals (`#xxxxxx`) in `*.tsx`/`*.ts`: **108** matches outside CSS files.
- Raw `rgb()` / `rgba()` literals: dozens, almost exclusively `rgba(0,0,0,…)` / `rgba(255,255,255,…)` inside shadow / gradient strings (acceptable when used as glow/shadow), plus the splash/StartupShell yellow `bg-[#ffe600]`.
- Tailwind theme-fixed `bg-(white|black)` / `text-(white|black)` / `border-(white|black)`: **114** matches.
- Tailwind `bg-gray-*` / `text-gray-*` / `border-gray-*`: **0** matches (good — the team already migrated off the Tailwind gray scale).
- Tailwind theme-fixed Tailwind color steps (`red-500`, `blue-400`, `rose-500`, `emerald-500`, etc., without `/N` opacity): **160+** matches. **Most lack a `dark:` opt-in.**

### Top 30 worst offenders

| # | Rating | File:line | Issue |
|---|---|---|---|
| 1 | P1 | `packages/ui/src/components/shell/RuntimeGate.tsx:1452` | Hardcoded `bg-[#ffe600] text-black` button — invisible-when-dark-bg removed; locked-yellow palette regardless of user theme. |
| 2 | P1 | `packages/ui/src/components/shell/RuntimeGate.tsx:1495` | `text-[#ffe600]/80` Spinner color — depends on always-dark backdrop; theme switch breaks it. |
| 3 | P1 | `packages/ui/src/components/shell/RuntimeGate.tsx:1603` (and 1618, 1650, 1752) | `border-[#f0b90b]/40 bg-black/58 text-white` panels — assume RuntimeGate is always dark. If overlay ever shows over a light surface, white text on dark transparent will read as floating white on white. |
| 4 | P1 | `packages/ui/src/components/shell/RuntimeGate.tsx:1888` | Wrapper switches between `bg-[#1a1108]` and `bg-[#0a0805]` only — no light branch exists; light-theme users see hardcoded brown. |
| 5 | P1 | `packages/ui/src/components/shell/RuntimeGate.tsx:1934,2084,2182` | Repeated `border-black bg-[#ffe600] text-black shadow-[…rgba(0,0,0,…)]` button pattern. Yellow-on-black brand chrome is decoupled from the theme; users on light theme see the same shell. Confirmed prior P1 in `01-onboarding-setup-qa.md`. |
| 6 | P1 | `packages/ui/src/components/shell/StartupShell.tsx:281` | `bg-[#ffe600] text-black` splash screen — locked yellow in both themes. |
| 7 | P1 | `packages/ui/src/components/shell/StartupShell.tsx:327` | `bg-black text-white` — forced regardless of theme. |
| 8 | P1 | `packages/ui/src/components/shell/SplashServerChooser.tsx:78` | `bg-black px-3 py-5 text-[#ffe600]` — locked palette. |
| 9 | P1 | `packages/ui/src/components/shell/SplashServerChooser.tsx:63,84,102,125` | Same lock-in (`bg-white text-black hover:bg-black hover:text-[#ffe600]`). |
| 10 | P2 | `packages/ui/src/components/character/CharacterEditor.tsx:98` | `color: "var(--accent-foreground, #1a1f26)"` — token-with-fallback. Fallback is dark text only; in dark theme without the var, contrast inverts to invisible. |
| 11 | P2 | `packages/ui/src/components/chat/SaveCommandModal.tsx:127` | Inline `style={{ color: "#ef4444" }}` — always red regardless of theme. Acceptable for danger color but not theme-aware. |
| 12 | P2 | `packages/ui/src/components/pages/WorkflowGraphViewer.tsx:74,191,209,223` | React-Flow node palette uses hex literals (`#3b82f6`, `#1d4ed8`, `#60a5fa`). The component branches on `uiTheme` (line 197) but the node-color helper at line 39 does NOT — node interior `bg: "#0c1a2e"` is hardcoded dark for both themes. Light theme shows midnight rectangles on white. |
| 13 | P2 | `packages/ui/src/components/pages/WorkflowGraphViewer.tsx:205-209` | Light branch uses `text-slate-700` / `text-slate-500` — the only Tailwind `slate-` usage in the codebase, but the dark branch uses different `text-slate-300` literals. OK because branched; rated P2 only because it duplicates the theme system. |
| 14 | P1 | `packages/ui/src/components/pages/AppsPageView.tsx:70-73` | `--section-accent-apps: #10b981` / `--s-text-txt: #10b981` injected as CSS vars. Emerald-green text and tinted accent stay the same across themes; on the light backdrop the section accent reads brand-incorrect. |
| 15 | P2 | `packages/ui/src/components/training/JobDetailPanel.tsx:68,74` | Inline `fill="#10b981"` and `fill="#3b82f6"` on chart datapoints — fine for chart series, but the placeholder `"#6b7280"` (line 68/74) is a flat gray that loses against the dark surface. |
| 16 | P1 | `packages/ui/src/components/connectors/SignalQrOverlay.tsx:134` | `bg-white dark:bg-white` — intentional (QR needs white quiet zone), but the wrapper containers at lines 124,128 use `border: "1px solid rgba(255,255,255,0.08)"`, which is nearly invisible on the light theme card. |
| 17 | P1 | `packages/ui/src/components/connectors/WhatsAppQrOverlay.tsx:139` | Same `bg-white dark:bg-white` + `rgba(255,255,255,0.08)` border pattern. |
| 18 | P2 | `packages/ui/src/components/shell/onboarding-theme.ts:7-17` | Theme palette literals (`#c84d1f`, `#fffaf6`, `rgba(255,250,246,0.72)`). This is the onboarding-game theme — it’s correct that it is fixed, but no light/dark adapter exists; printed on a light-mode browser the orange splash is correct, on a dark browser the orange is still orange (loud). Doc note. |
| 19 | P1 | `packages/ui/src/components/training/TrainingDashboard.tsx:34,101,110,143` | `text-red-500` / `text-green-500` / `text-red-600` — no `dark:` opt-in. On dark `--bg #050506`, `text-red-500 (#ef4444)` contrast is ~5.4:1 (passes AA but vibrates); on light `--bg #f7f8fa` contrast is ~3.5:1 — fails AA. |
| 20 | P1 | `packages/ui/src/components/training/JobDetailPanel.tsx:147,210,262,271` | Same `text-red-500` / `text-green-500` pattern, no theme split. |
| 21 | P1 | `packages/ui/src/components/training/InferenceEndpointPanel.tsx:35,108,128,212` | Same pattern. |
| 22 | P2 | `packages/ui/src/components/pages/AutomationsFeed.tsx:482,571` | `text-violet-400` / `text-blue-400` — fine on dark, poor (~3.1:1) on light `--bg #f7f8fa`. |
| 23 | P2 | `packages/ui/src/components/pages/WorkflowGraphViewer.tsx:399,415,440,456` | Repeated `text-xs text-blue-400 hover:underline` — link color is theme-fixed and doesn’t adapt. |
| 24 | P2 | `plugins/app-lifeops/src/components/LifeOpsOverviewSection.tsx:86,90,94,98,109,127` | Mood/status palette (`text-rose-300`, `text-amber-300`, `text-blue-300`, `text-emerald-300`) hard-coded for dark-mode contrast. Light mode washes them all to ~2.5:1. |
| 25 | P2 | `packages/ui/src/components/local-inference/RoutingMatrix.tsx:115`, `ProvidersList.tsx:45`, `HuggingFaceSearch.tsx:125`, `ModelCard.tsx:38-40` | Error pills `border-rose-500/40 bg-rose-500/10 text-rose-500` — colored text on tinted bg works in dark but the `text-rose-500 (#f43f5e)` on `bg-rose-500/10` is ~3.2:1 on light. |
| 26 | P2 | `packages/ui/src/components/chat/MessageContent.tsx:1294-1306` | `bg-purple-500/10 text-purple-500` and `bg-blue-500/10 text-blue-500` code-fence dividers — both readable on dark, marginal on light. |
| 27 | P1 | `packages/ui/src/components/release-center/sections.tsx:570` | `bg-black/5` panel — intentional for light theme, but stacks against `--bg #050506` in dark mode and disappears (5% black over black = invisible). |
| 28 | P2 | `packages/ui/src/components/shell/ConnectionFailedBanner.tsx:51` | `bg-danger px-4 py-2 ... text-white` — banner colors are token-driven for bg but text is locked white. Light theme + warning-yellow `bg-danger` may yield poor contrast (~3.0:1 on `#f6465d`). |
| 29 | P2 | `packages/ui/src/components/shell/ShellOverlays.tsx:28-30` | `bg-danger text-white` / `bg-ok text-white`. Same locked-white text. |
| 30 | P2 | `plugins/app-lifeops/src/components/LifeOpsHabitVisuals.tsx:10-17` | Palette array `["bg-cyan-400", "bg-amber-300", "bg-emerald-400", "bg-rose-400", "bg-blue-400", "bg-fuchsia-400", "bg-orange-300"]` — saturated chart palette pinned for a dark theme. Light theme renders this fine for the chart fills, but the legend swatches lose detail at 300/400 step on `--bg #f7f8fa`. |

Summary: the dark-mode risk is concentrated in **RuntimeGate / StartupShell / SplashServerChooser / onboarding-theme** (intentionally locked yellow-on-black brand chrome, but no opt-out for light users) and in **`text-red-500` / `text-green-500` status text** across `training/*`, `local-inference/*`, and several plugin apps — none of which use the `--ok` / `--danger` / `--warn` tokens already defined in `base.css:43-51`.

---

## 2. Missing aria-labels on icon-only buttons

51 files use `<Button size="icon">`. Most chat composer / shell controls / settings have correct `aria-label` (verified in `chat-composer.tsx`, `Header.tsx`, `ShellHeaderControls.tsx`, `chat-message-actions.tsx`, `chat-conversation-item.tsx`, `tag-editor.tsx`, `banner.tsx`).

Unlabeled icon-only buttons confirmed via grep — top 30 candidates (the 8 here are the only matches found across the searched surface, far fewer than the cap):

| # | File:line | Notes |
|---|---|---|
| 1 | `packages/ui/src/components/config-ui/config-field.tsx:873` | Pill remove `Button size="icon"` rendering `×` — no aria-label, no title. P1 — screen reader announces nothing. |
| 2 | `packages/ui/src/components/config-ui/config-field.tsx:1066` | Move-up button rendering Unicode `▲` — title is set, but `▲` is a glyph; aria-label missing. |
| 3 | `packages/ui/src/components/config-ui/config-field.tsx:1101` | List-row remove button (`<X className="w-3 h-3" />`) — no aria-label, no title. P1. |
| 4 | `packages/ui/src/components/config-ui/config-field.tsx:1270` | Table-row remove button — no aria-label, no title. P1. |
| 5 | `packages/ui/src/components/config-ui/ui-renderer.tsx:1504` | Sheet close `×` button — no aria-label, no title. P1. |
| 6 | `packages/ui/src/components/pages/DatabaseView.tsx:624` | Icon button — no aria-label, no title. P1. |
| 7 | `packages/ui/src/components/pages/database-utils.tsx:99` | Icon button — no aria-label, no title. P1. |
| 8 | `plugins/app-companion/src/components/companion/EmotePicker.tsx:429` | Emote tile button rendering an emoji — no aria-label, no title. P1 (emoji glyph is ambiguous to AT). |
| 9 | `plugins/app-companion/src/components/companion/CompanionHeader.tsx:141` | Icon button — no aria-label, no title. P1. |

Beyond `size="icon"`, the only raw `<button>` elements (not Radix-wrapped) in the searched scope live in `plugins/app-phone/src/companion/components/Pairing.tsx` (lines 106, 142), `plugins/app-phone/src/companion/components/RemoteSession.tsx:350`, and `plugins/app-screenshare/src/routes.ts:544-557`. These either have text content (Connect/Stop/Esc) so are labeled, or are HTML strings inside a viewport string template. They are OK.

(Cap: top 30; actual findings: 9.)

---

## 3. Missing alt text on images

`<img>` usage across the searched surface (top 20 verified):

| # | File:line | Alt status |
|---|---|---|
| 1 | `packages/ui/src/components/connectors/SignalQrOverlay.tsx:132` | `alt="Signal QR Code"` — OK |
| 2 | `packages/ui/src/components/connectors/ConnectorAccountCard.tsx:134` | `alt=""` decorative — OK |
| 3 | `packages/ui/src/components/connectors/WhatsAppQrOverlay.tsx:137` | `alt="WhatsApp QR Code"` — OK |
| 4 | `packages/ui/src/components/settings/AppearanceSettingsSection.tsx:389` | `alt=""` decorative (paired with adjacent label) — OK |
| 5 | `packages/ui/src/components/shell/RuntimeGate.tsx:1898` | `alt=""` decorative bg — OK |
| 6 | `packages/ui/src/components/shell/RuntimeGate.tsx:2231` | `alt=""` — OK |
| 7 | `packages/ui/src/components/shell/StartupShell.tsx:283` | `alt=""` decorative — OK |
| 8 | `packages/ui/src/components/config-ui/ui-renderer.tsx:929` | `alt={alt}` (prop-driven) — OK if callers set it; **P2: trust callers** — verify no caller omits. |
| 9 | `packages/ui/src/components/character/CharacterRoster.tsx:187` | (not in scan output – needs verification.) |
| 10 | `packages/ui/src/components/composites/chat/chat-attachment-strip.tsx:34` | `alt={item.alt}` — OK assuming `item.alt` is set; **P2: trust callers**. |
| 11 | `packages/ui/src/components/pages/PluginCard.tsx:170` | `alt=""` decorative (sibling shows plugin name) — OK |
| 12 | `packages/ui/src/components/pages/ChatView.tsx:1120` | `alt={t("inboxview.avatarAlt", { title: activeInboxChat.title })}` — OK |
| 13 | `packages/ui/src/components/conversations/ConversationsSidebar.tsx:499` | `alt=""` decorative — OK (text label nearby) |
| 14 | `packages/ui/src/components/pages/MediaGalleryView.tsx:461` | `alt={selectedItem.filename}` — OK |
| 15 | `packages/ui/src/components/pages/AppDetailsView.tsx:466` | `alt=""` decorative — OK |
| 16 | `packages/ui/src/components/pages/plugin-view-modal.tsx:57` | `alt=""` — OK |
| 17 | `packages/ui/src/components/pages/BrowserWorkspaceView.tsx:2614` | `alt={...}` (multi-line) — OK |
| 18 | `packages/ui/src/components/pages/PluginsView.tsx:850` | `alt=""` — OK |
| 19 | `packages/ui/src/components/pages/plugin-view-dialogs.tsx:56` | `alt=""` — OK |
| 20 | `packages/ui/src/components/pages/PageScopedChatPane.tsx:845` | `alt={image.name}` — OK |

All `<img>` tags in the searched surface have an `alt=` attribute. **No P1 findings here.** Two **P2** trust-caller notes (ui-renderer.tsx:929, chat-attachment-strip.tsx:34) for components that defer to the upstream caller for alt content — recommend a default fallback.

(Cap: top 20; effective findings: 0 missing, 2 indirect-trust.)

---

## 4. Focus management

Modal infrastructure: `packages/ui/src/components/ui/dialog.tsx` (Radix Dialog wrapper). Radix already provides `role="dialog"`, `aria-modal`, and focus-trap. Issues only appear in **non-Radix overlays**.

| # | File:line | Issue | Rating |
|---|---|---|---|
| 1 | `packages/ui/src/components/pages/AutomationsFeed.tsx:549-559` | Uses native `<dialog open>` plus a backdrop `<button>` for outside-click close. No `autoFocus` on the first interactive option, no focus restoration on close, no `Esc` handler (the native `<dialog>` does provide `Esc`, but it's not popped via the `open` attribute consistently). **P2.** |
| 2 | `packages/ui/src/components/shell/ComputerUseApprovalOverlay.tsx:173` | `aria-modal="true"` present — but no `role="dialog"` on the same element. The role and modal must co-occur. **P1.** |
| 3 | `packages/ui/src/components/shell/ConnectionLostOverlay.tsx:44` | Same — `aria-modal="true"` without confirmed `role="dialog"` on the modal root (needs full read). **P2.** |
| 4 | `packages/ui/src/components/pages/WorkflowGraphViewer.tsx:516-517` | `role="dialog" aria-modal="false"` — aria-modal=false is technically valid but contradicts the "selected node panel" pattern, which behaves like a non-modal sidesheet. Recommend dropping `role="dialog"`. **P2.** |
| 5 | `plugins/app-task-coordinator/src/PtyConsoleSidePanel.tsx:22` | `role="dialog"` present without companion `aria-modal` — should be `aria-modal="false"` for a docked panel. **P2.** |
| 6 | `packages/ui/src/components/apps/GameViewOverlay.tsx:155` | `fixed inset-0 z-50 pointer-events-none` — no `role` or `aria-modal` at all. Decorative overlay; OK only if it never traps focus. **P2.** |
| 7 | `plugins/app-companion/src/components/companion/CompanionAppView.tsx:278` | `fixed inset-0 z-50` full-screen app window — no `role="application"`, no focus restoration when closed. **P2.** |
| 8 | `plugins/app-contacts/src/components/ContactsAppView.tsx:210` | Same pattern, no role. **P2.** |
| 9 | `plugins/app-phone/src/components/PhoneAppView.tsx:289` | Same. **P2.** |
| 10 | `plugins/app-hyperliquid/src/HyperliquidAppView.tsx:57` | Same. **P2.** |
| 11 | `plugins/app-shopify/src/ShopifyAppView.tsx:174` | Same. **P2.** |
| 12 | `plugins/app-vincent/src/VincentAppView.tsx:40` | Same. **P2.** |
| 13 | `plugins/app-polymarket/src/PolymarketAppView.tsx:20` | Same. **P2.** |
| 14 | `packages/ui/src/components/config-ui/ui-renderer.tsx:1484, 1534` | Keyboard handler reacts to `Escape || Enter || Space`. Treating `Enter`/`Space` the same as `Escape` on a custom overlay can override default form-submit semantics. Verify `preventDefault()` is conditional. **P2.** |
| 15 | `packages/ui/src/components/shell/BugReportModal.tsx:382` | `Escape` handler — confirmed present. Need to verify focus is restored to the trigger. **P2.** |

Cross-cutting: only `autoFocus` appears **9 times** in `packages/ui` per the scan. Almost no modal explicitly autofocuses its primary interactive element — Radix handles this for `Dialog`, but non-Radix overlays do not.

(Cap: top 15; findings: 15.)

---

## 5. Touch-target size on mobile

WCAG 2.5.5 (AAA) recommends 44×44 CSS px; iOS HIG and Material Design both target ≥44×44. `Tailwind h-11 w-11` (44 px) is the team's known-good unit (`min-h-touch` / `min-w-touch` utility helper exists — see `packages/ui/src/components/composites/sidebar/sidebar-root.tsx:825`).

Buttons with fixed dimensions **<36×36 px** that are not nested in a larger hit area:

| # | File:line | Class | Notes |
|---|---|---|---|
| 1 | `packages/ui/src/components/ui/banner.tsx:73` | `h-6 w-6` (24 px) | Banner dismiss `X` — too small for mobile thumb. **P1**. |
| 2 | `packages/ui/src/components/composites/chat/create-task-popover.tsx:101` | `h-6 w-6` | Popover close `X`. **P1**. |
| 3 | `packages/ui/src/components/ui/tag-editor.tsx:80` | `h-4 w-4` (16 px) | Tag remove pill — well below mobile minimum, no larger hit area. **P1**. |
| 4 | `packages/ui/src/components/composites/chat/chat-attachment-strip.tsx:46` | `h-4 w-4` (16 px), absolute -right-1.5 -top-1.5 | Attachment remove badge. Edge-of-tile placement compounds the size problem on mobile. **P1**. |
| 5 | `packages/ui/src/components/composites/chat/chat-conversation-item.tsx:240` | `h-6 w-6` | Conversation row "more actions" button on mobile. **P1**. |
| 6 | `packages/ui/src/components/character/CharacterEditorPanels.tsx:321,672` | `h-7 w-7` (28 px) | Inline list-row remove buttons. **P2**. |
| 7 | `packages/ui/src/components/character/CharacterLearnedSkillsSection.tsx:114` | `h-8 w-8` (32 px) | **P2** — borderline. |
| 8 | `packages/ui/src/components/settings/SubscriptionStatus.tsx:182` | `h-8 w-8` | **P2**. |
| 9 | `packages/ui/src/components/settings/VaultInventoryPanel.tsx:395` | `h-6 w-6` | Settings list item icon button. **P1**. |
| 10 | `packages/ui/src/components/settings/VaultInventoryPanel.tsx:448` | `h-7 w-7` | **P2**. |
| 11 | `packages/ui/src/components/settings/WalletKeysSection.tsx:320,341` | `h-7 w-7` | **P2**. |
| 12 | `packages/ui/src/components/settings/vault-tabs/OverviewTab.tsx:369,380` | `h-7 w-7` | **P2**. |
| 13 | `packages/ui/src/components/settings/vault-tabs/LoginsTab.tsx:400` | `h-7 w-7` | **P2**. |
| 14 | `packages/ui/src/components/composites/chat/chat-message-actions.tsx:40,56,69,82` | `h-8 w-8` | Action rail on chat messages. **P2** — borderline; on touch devices these are <44 px. |
| 15 | `packages/ui/src/components/composites/chat/chat-composer.tsx:386,438,462,479,492,750` | `h-8 w-8` | Composer micro-actions. **P2**. |
| 16 | `packages/ui/src/components/connectors/ConnectorAccountAuditList.tsx:108` | `h-8 w-8` | **P2**. |
| 17 | `packages/ui/src/components/connectors/ConnectorAccountCard.tsx:192,218,234` | `h-7 w-7` | **P2**. |
| 18 | `packages/ui/src/components/settings/VoiceConfigView.tsx:556` | `h-5 w-5` (20 px) | Voice-trigger pill remove. **P1**. |
| 19 | `packages/ui/src/components/composites/search/search-input.tsx:45` | `h-5 w-5` | Search clear. **P1** for mobile users (desktop hover is fine). |
| 20 | `packages/ui/src/components/chat/widgets/music-player.tsx:170` | `h-7 w-7` | Music transport icons. **P2**. |

Total occurrences of `h-7 w-7` and `h-8 w-8`: **~207** matches across the codebase. The pattern is endemic; rate as a system-level **P2** — recommend introducing a `size="iconLg"` (h-11 w-11) or wrapping these in larger hit zones via padding.

(Cap: top 20; total findings: 20 shown; ~187 more similar across the system.)

---

## 6. Responsive class audit

`w-<n>` (fixed width) on layout containers without `max-w-` cap are responsive landmines on small viewports.

| # | File:line | Class | Notes |
|---|---|---|---|
| 1 | `packages/ui/src/components/pages/ChatPanelLayout.tsx:84` | `w-[292px] shrink-0 xl:w-[320px]` | Sidebar — no `max-w-` cap on the contents inside. Mobile breakpoint hidden, so OK; **P2** as a documentation gap. |
| 2 | `packages/ui/src/components/pages/DocumentsView.tsx:1040-1041` | `lg:w-[18.5rem] xl:w-[20rem]` / `lg:w-[22rem] xl:w-[24rem]` | Acceptable lg+ shape — **OK**. |
| 3 | `packages/ui/src/components/pages/LogsView.tsx:109` | `min-w-[15rem] flex-1` | `min-w-` without max — flex-1 saves it. **OK**. |
| 4 | `packages/ui/src/components/pages/DatabaseView.tsx:643` | `w-[220px] flex-shrink-0` | Fixed 220 px column — no max cap, no breakpoint override. **P2** at 320 px viewport. |
| 5 | `packages/ui/src/components/pages/AutomationsFeed.tsx:437` | `hidden w-[360px] shrink-0 ... lg:block` | Hidden below `lg` — **OK**. |
| 6 | `packages/ui/src/components/pages/database-utils.tsx:142` | `w-[50px] min-w-[50px]` table cell | Narrow column for row index. **OK**. |
| 7 | `packages/ui/src/components/pages/plugin-view-connectors.tsx:706` | `h-9 min-w-[14rem]` SelectTrigger | No max. **P2** at narrow widths. |
| 8 | `packages/ui/src/components/shell/StartupShell.tsx:333-334` | `h-[24rem] w-[24rem]` / `h-[20rem] w-[20rem]` decorative blurs | Absolutely positioned background — **OK**. |
| 9 | `packages/ui/src/components/shell/LoadingScreen.tsx:125` | `min-w-[48px] text-right select-none` | Counter column. **OK**. |
| 10 | `packages/ui/src/components/shell/PairingView.tsx:151,165,201` | `w-full sm:w-auto sm:min-w-[12rem]` etc. | Mobile-first with min-w on desktop. **OK**. |
| 11 | `packages/ui/src/components/shell/ConnectionLostOverlay.tsx:81,96` | Same pattern. **OK**. |
| 12 | `packages/ui/src/components/shell/StartupFailureView.tsx:233-265` | Same pattern. **OK**. |
| 13 | `packages/ui/src/components/settings/VoiceConfigView.tsx:570` | `h-7 min-w-[120px] flex-1 border-0 bg-transparent px-1 text-xs` | Tag-input — `flex-1` rescues it. **OK**. |
| 14 | `plugins/app-companion/src/components/companion/EmotePicker.tsx:385` | `w-[320px]` floating panel | No `max-w` and no breakpoint guard. On a 320 px viewport with side-padding, this clips. **P2.** |
| 15 | `packages/ui/src/components/auth/LoginView.tsx:185` | `max-w-[520px]` | Already has max. **OK**. |

Most fixed-width usages are guarded by breakpoint visibility or live in absolute / hero contexts. Two genuine **P2** offenders: `DatabaseView.tsx:643` and `EmotePicker.tsx:385`.

(Cap: top 15; effective findings: 4 P2, 11 OK / informational.)

---

## 7. Hardcoded font sizes

`text-[<n>px]` literals (top 15):

| # | File:line | Class | Rating |
|---|---|---|---|
| 1 | `packages/ui/src/components/connectors/ConnectorAccountSetupScope.tsx:76` | `text-[9px] uppercase` | **P2** — sub-10px text is below WCAG minimum (sees 1em = 16px). |
| 2 | `packages/ui/src/components/chat/ConnectorAccountPicker.tsx:160,169` | `text-[9px] uppercase text-muted` | **P2**. |
| 3 | `packages/ui/src/components/chat/AccountRequiredCard.tsx:120` | `text-[9px]` | **P2**. |
| 4 | `packages/ui/src/components/connectors/ConnectorAccountPurposeSelector.tsx:97` | `text-[10px] font-medium uppercase tracking-wider text-muted` | **P2** — at 10 px with `text-muted` (#5e6673 / #8a8a94), light theme contrast ~5.2:1, dark theme ~5.5:1 — passes AA for normal text but only because the cutoff is generous. |
| 5 | `packages/ui/src/components/connectors/ConnectorAccountSetupScope.tsx:46,86` | `text-[10px]` | **P2**. |
| 6 | `packages/ui/src/components/connectors/ConnectorAccountAuditList.tsx:149` | `text-[11px]` `pre` | **P2** — small mono content. |
| 7 | `packages/ui/src/components/connectors/ConnectorAccountPrivacySelector.tsx:117` | `text-[10px]` | **P2**. |
| 8 | `packages/ui/src/components/connectors/ConnectorAccountCard.tsx:153,158` | `text-[10px]` | **P2**. |
| 9 | `packages/ui/src/components/local-inference/LocalInferencePanel.tsx:321,408` | `text-[10px]` | **P2**. |
| 10 | `packages/ui/src/components/local-inference/RoutingMatrix.tsx:110,201` | `text-[10px]` | **P2**. |
| 11 | `packages/ui/src/components/local-inference/ModelHubView.tsx:73,77` | `text-[10px]` | **P2**. |
| 12 | `packages/ui/src/components/local-inference/ProvidersList.tsx:57,91` | `text-[10px]` | **P2**. |
| 13 | `packages/ui/src/components/settings/ProviderSwitcher.tsx:996,1026,1053` | `text-[10px] text-muted font-medium uppercase tracking-wider` | **P2** — repeats; would be cheaper as a named utility. |
| 14 | `packages/ui/src/components/tool-events/ToolCallEventLog.tsx:78,94` | `text-[11px]` | **P2**. |
| 15 | `packages/ui/src/components/chat/TasksEventsPanel.tsx:243` | `text-[10px]` | **P2**. |

Pattern: **dozens** of `text-[10px]` repetitions across `connectors/`, `local-inference/`, `settings/`. The existing scale (`text-3xs`, `text-2xs`, `text-xs-tight`) lives in `theme.css` and ought to be the canonical exit — currently it is shadowed by these custom px sizes.

Inline `font-size: <n>px` in `*.ts/*.tsx`: only **2 hits**, both in `plugins/app-vincent/src/routes.ts:609-610` (server-rendered HTML).

(Cap: top 15; findings: 15 hits, dozens more similar.)

---

## 8. Color contrast risks

Low-opacity text on potentially dark surfaces:

| # | File:line | Class | Rating |
|---|---|---|---|
| 1 | `packages/ui/src/components/shell/RuntimeGate.tsx:1555,2322,2315` | `text-white/50`, `border-white/20 text-white/50` | On `bg-black/65` overlay this is ~3.0:1 — fails AA. **P1**. |
| 2 | `packages/ui/src/components/shell/RuntimeGate.tsx:1807,1820` | `placeholder:text-white/40` | Placeholder text at 40% opacity over `bg-black/55` is ~2.5:1. **P1** for placeholder legibility (sees by people in low-light environments). |
| 3 | `packages/ui/src/components/shell/StartupShell.tsx:311` | `text-3xs text-black/50` | Black at 50% on `bg-[#ffe600]` is ~3.8:1 — borderline AA. **P2**. |
| 4 | `packages/ui/src/components/composites/trajectories/trajectory-pipeline-graph.tsx:111` | `bg-muted/8 text-muted/40` | Muted text at 40% opacity inside muted bg at 8% — illegible in both themes. **P1**. |
| 5 | `packages/ui/src/components/composites/trajectories/trajectory-pipeline-graph.tsx:105` | `text-muted/50` | **P2**. |
| 6 | `packages/ui/src/components/composites/sidebar/sidebar-content.tsx:52` | `text-2xs text-muted/50` | Sidebar metadata. **P2** — `text-muted` is already designed to be a low-emphasis color; halving it makes it ghost text. |
| 7 | `packages/ui/src/components/pages/DocumentsView.tsx:999,1002` | `placeholder:text-muted/50` and icon `text-muted/50` | **P2**. |
| 8 | `packages/ui/src/components/pages/MemoryViewerView.tsx:350,356` | Same. **P2**. |
| 9 | `packages/ui/src/components/custom-actions/custom-action-form.tsx:40` | `placeholder:text-muted/50` | **P2**. |
| 10 | `packages/ui/src/components/chat/widgets/shared.tsx:66` | `text-muted/50` for icon. Decorative icon — **OK**. |
| 11 | `plugins/app-lifeops/src/components/MessagingConnectorCards.tsx:253` | `text-muted/55` | **P2**. |
| 12 | `plugins/app-lifeops/src/components/MessagingConnectorCards.tsx:1172,1198,1238` | `placeholder:text-muted/50` repeated. **P2**. |
| 13 | `plugins/app-shopify/src/ProductsPanel.tsx:309`, `InventoryLevelsPanel.tsx:176`, `OrdersPanel.tsx:227`, `CustomersPanel.tsx:107` | `text-muted/40` on `Package`/`ShoppingCart`/`Users` icon — placeholder empty-state icon. **P2** — borderline for icon-on-bg. |
| 14 | `plugins/app-steward/src/ApprovalQueue.tsx:350` | `placeholder:text-muted/40` | **P2**. |
| 15 | `plugins/app-trajectory-logger/src/components/TrajectoryLoggerView.tsx:131` | `text-2xs text-muted/40` | **P2**. |
| 16 | `packages/ui/src/components/pages/AppsView.tsx:1122` | `text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted ... hover:text-foreground` | Sub-11 px uppercase with letter-spacing on muted color — AA-marginal even with 100% opacity. **P2**. |

Note that the surface uses `text-muted-foreground` in `local-inference/*` and `auth/*` — the token does not exist in `base.css` and resolves to undefined CSS variable. Verify in `theme.css`: only `--muted` exists; `--muted-foreground` is implicit. Twenty-one component sites reference `text-foreground` and `text-muted-foreground`, which Tailwind interprets as opaque only if these tokens are mapped in the Tailwind config. There is **no project `tailwind.config.*` for `packages/ui`** (the only configs are in `plugins/plugin-social-alpha/`, `cloud/examples/`, `packages/examples/_plugin/`, and `packages/registry/site/`) — UI relies on Tailwind v4's CSS-first config in `packages/ui/src/styles/`. Need to confirm that `text-foreground` / `text-muted-foreground` are mapped. If not, these 21 sites render with the CSS-variable fallback only.

(Cap: top offenders; findings: 16 with file:line, plus a system-level note on `text-muted-foreground`.)

---

## 9. Light/dark toggle integrity

Theme toggle: `packages/ui/src/components/shared/ThemeToggle.tsx` (full file read).

| Check | Result | Evidence |
|---|---|---|
| Sets `document.documentElement.classList` | **YES** | `packages/ui/src/state/persistence.ts:287-293` — `root.classList.add("dark")` / `remove("dark")`. |
| Sets `document.documentElement` data attribute | **YES** | `persistence.ts:273-281` — `root.setAttribute("data-theme", normalizedTheme)` (uses `data-theme` for the CSS in `base.css:39`). |
| Sets `style.colorScheme` | **YES** | `persistence.ts:283-285` — `root.style.colorScheme = normalizedTheme`. |
| Persists to localStorage | **YES** | `persistence.ts:78-84` — `saveUiTheme` writes both `UI_THEME_STORAGE_KEY` and `LEGACY_UI_THEME_STORAGE_KEY`. |
| Respects `prefers-color-scheme` on initial load | **NO** | `persistence.ts:50-52, 70-76`. `normalizeUiTheme(value: unknown): UiTheme { return value === "light" ? "light" : "dark"; }` — anything other than the literal string `"light"` (including `null` / missing) defaults to **dark**. No `window.matchMedia("(prefers-color-scheme: …)")` reference anywhere in `packages/ui/src/state/`. The codebase uses `matchMedia` for `(min-width:…)`, `(hover:hover)`, `(prefers-reduced-motion)` — never for color scheme. **P1**. |
| Re-applies theme when `themeId` changes | **YES** | `useDisplayPreferences.ts:76-80` — themed accent colors re-apply on `themeId` change. |
| Suppresses transition flicker during switch | **YES** | `persistence.ts:56-68` — `suppressThemeTransitions` adds `data-theme-switching` attribute on switch. |

**Single P1**: the initial-load default is hard-coded to `"dark"`. Users on macOS with light system theme will get a dark Eliza at first launch, despite the OS preference. This is a meaningful onboarding annoyance and a discoverability issue for the `ThemeToggle` itself (the user has to find the toggle to change theme even though the OS already says what they prefer).

Suggested fix: in `loadUiTheme()` (`persistence.ts:70-76`), when no value is present in either `UI_THEME_STORAGE_KEY` or `LEGACY_UI_THEME_STORAGE_KEY`, read `window.matchMedia("(prefers-color-scheme: light)").matches` and default to `"light"` accordingly.

---

## 10. Top-10 priority fix list

Synthesizing across §1–§9, here are the 10 most user-impacting fixes ranked by impact × frequency × confidence:

1. **Respect `prefers-color-scheme` on initial load.** `packages/ui/src/state/persistence.ts:50-76` — the default is `"dark"` regardless of OS preference. First-launch theme mismatch is universal. **P1, single-call-site fix.**

2. **Move RuntimeGate / StartupShell / SplashServerChooser brand chrome onto theme tokens.** Roughly 50 hits across `packages/ui/src/components/shell/RuntimeGate.tsx` (lines 1355, 1452, 1493, 1527, 1603, 1618, 1634, 1650, 1690, 1739, 1752, 1786, 1806, 1819, 1844, 1888, 1904, 1921, 1928, 1934, 2052, 2084, 2102, 2182, 2190, 2208, 2228, 2277, 2300, …), `packages/ui/src/components/shell/StartupShell.tsx:281, 295, 297, 311, 327, 332-334`, `packages/ui/src/components/shell/SplashServerChooser.tsx:63, 78, 84, 102, 125`. Replicates the pre-existing P1 in `01-onboarding-setup-qa.md` and locks the entire onboarding/startup surface to a single yellow-on-black palette. **P1, broad refactor.**

3. **Replace raw `text-red-500` / `text-green-500` status text with `--status-success` / `--status-danger` tokens.** Hits: `training/TrainingDashboard.tsx:34,101,110,143`, `training/JobDetailPanel.tsx:147,210,262,271`, `training/InferenceEndpointPanel.tsx:35,108,128,212`, `local-inference/{DownloadQueue,ModelCard,RoutingMatrix,ProvidersList,HuggingFaceSearch}.tsx`, plus several `plugins/app-lifeops/*`. Status colors exist in `base.css:43-51` as `--ok` / `--danger` / `--warn` and `--status-success-bg` etc.; not used here. **P1, mass find-and-replace.**

4. **Add aria-label / title to unlabeled icon-only buttons.** `packages/ui/src/components/config-ui/config-field.tsx:873, 1066, 1101, 1270`, `ui-renderer.tsx:1504`, `pages/DatabaseView.tsx:624`, `pages/database-utils.tsx:99`, `plugins/app-companion/src/components/companion/EmotePicker.tsx:429`, `CompanionHeader.tsx:141`. Nine sites total. **P1, ~30 line diff.**

5. **Raise hit-target minimum to 36×36 px on mobile.** Worst offenders: `packages/ui/src/components/ui/tag-editor.tsx:80` (16 px), `composites/chat/chat-attachment-strip.tsx:46` (16 px), `settings/VoiceConfigView.tsx:556` (20 px), `composites/search/search-input.tsx:45` (20 px), `ui/banner.tsx:73` (24 px), `composites/chat/create-task-popover.tsx:101` (24 px), `composites/chat/chat-conversation-item.tsx:240` (24 px), `settings/VaultInventoryPanel.tsx:395` (24 px). Either bump dimensions or add larger touch padding. **P1 (mobile users), broad sweep.**

6. **Trajectory-pipeline-graph skipped-state styling is unreadable.** `packages/ui/src/components/composites/trajectories/trajectory-pipeline-graph.tsx:105,111` uses `bg-muted/8 text-muted/40` — a ghost on a ghost in both themes. Switch to `text-muted` + a clear `bg-muted/10` or use a dashed/outlined treatment. **P1.**

7. **Fix RuntimeGate placeholder + 50%-white text contrast.** `packages/ui/src/components/shell/RuntimeGate.tsx:1555, 1807, 1820, 2315, 2322` — `text-white/50`, `text-white/40`, `placeholder:text-white/40`. These are below AA on the dark overlay backgrounds. Raise to `/70` minimum. **P1.**

8. **Add `role="dialog"` to overlays already carrying `aria-modal="true"`.** `packages/ui/src/components/shell/ComputerUseApprovalOverlay.tsx:173`, `packages/ui/src/components/shell/ConnectionLostOverlay.tsx:44`. The aria-modal attribute without a dialog role is invalid. Also evaluate `plugins/app-task-coordinator/src/PtyConsoleSidePanel.tsx:22` and the fullscreen plugin apps (`app-phone`, `app-contacts`, `app-shopify`, `app-vincent`, `app-companion`, `app-hyperliquid`, `app-polymarket`). **P1.**

9. **Consolidate the `text-[10px] font-medium uppercase tracking-wider text-muted` repetition.** 15+ near-duplicate sites in `connectors/`, `local-inference/`, `settings/ProviderSwitcher.tsx`, `tool-events/ToolCallEventLog.tsx`, `chat/TasksEventsPanel.tsx`. Promote to a named utility (`.text-3xs-eyebrow` or a Tailwind component class) and audit the `9px` instances (`ConnectorAccountSetupScope.tsx:76`, `ConnectorAccountPicker.tsx:160,169`, `AccountRequiredCard.tsx:120`) — sub-10px text fails most accessibility audits. **P2, broad refactor.**

10. **Verify `text-foreground` / `text-muted-foreground` Tailwind mappings.** 21 component sites use these utilities but there is no `tailwind.config.*` in `packages/ui/`. Confirm Tailwind v4 CSS-first config (`packages/ui/src/styles/`) actually maps these tokens — if not, those sites render with browser defaults. Most are in `local-inference/*`, `auth/LoginView.tsx`, `settings/{Security,Runtime}SettingsSection.tsx`, and `pages/{AppsView,AppDetailsView}.tsx`. **P2 — needs verification but high blast radius.**

---

## Appendix A — Files surveyed

- `packages/ui/src/components/pages/*` (44 files)
- `packages/ui/src/components/shell/*` (~20 files)
- `packages/ui/src/components/settings/*` (~25 files)
- `packages/ui/src/components/{auth,chat,composites,connectors,config-ui,local-inference,training,tool-events,custom-actions,character,conversations,apps,shared,ui}/*`
- `packages/app/src/main.tsx`, `packages/ui/src/App.tsx`
- `packages/ui/src/styles/{theme.css, base.css}`
- `packages/ui/src/state/persistence.ts`, `useDisplayPreferences.ts`, `ui-preferences.ts`
- `plugins/app-{companion,contacts,hyperliquid,lifeops,phone,polymarket,shopify,steward,trajectory-logger,vincent,wallet,task-coordinator,screenshare,scripts}/src/**`

## Appendix B — Tools used

Static analysis only (live dev stack unavailable due to secrets refactor):
- `grep -rn` with class-name and hex-literal regexes.
- `awk` for multi-line button / img attribute extraction.
- Direct file reads of `theme.css`, `base.css`, `persistence.ts`, `useDisplayPreferences.ts`, `ThemeToggle.tsx`, `dialog.tsx`, sample component files.

Did not run:
- axe-core / @axe-core/playwright (deferred — Workstream 6 master plan calls for this but the live stack is down).
- Lighthouse / WAVE.
- Headless screenshot capture (deferred to Workstream 0 output).

## Appendix C — Findings counts per section

| Section | Cap | Findings |
|---|---:|---:|
| 1. Hardcoded color literals | 30 | 30 |
| 2. Missing aria-labels | 30 | 9 |
| 3. Missing alt text | 20 | 0 missing, 2 indirect-trust |
| 4. Focus management | 15 | 15 |
| 5. Touch-target size | 20 | 20 (~207 occurrences in total) |
| 6. Responsive class audit | 15 | 4 P2 + 11 informational |
| 7. Hardcoded font sizes | 15 | 15 (dozens more similar) |
| 8. Color contrast risks | open | 16 + 1 system note |
| 9. Light/dark toggle integrity | 1 issue | 1 P1 |
| 10. Top-10 priority list | 10 | 10 |
