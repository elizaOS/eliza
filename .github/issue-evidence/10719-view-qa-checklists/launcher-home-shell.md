# Launcher & Home Shell — QA Checklist

Scope: `packages/ui/src/components/shell/{HomeScreen,HomeLauncherSurface,HomePill,NotificationCenter,KioskViewCanvas}.tsx`, `packages/ui/src/components/pages/{LauncherSurface,Launcher}.tsx`, `packages/ui/src/hooks/useHorizontalPager.ts`, and the `ShellMode` router in `packages/ui/src/App.tsx` (`readShellMode`, KioskShell, TrayPopoverShell, ChatOverlayShell, OnboardingOverlayShell, HomeScreenMount).

Legend: **[COVERED: path]** an existing committed test exercises it · **[GAP]** no committed test found · **[PARTIAL]** adjacent behavior tested but the exact assertion below is missing.

---

## HomeScreen (`/chat` home dashboard)

### Entry / Nav
- [ ] Reach via `/chat` (TAB_PATHS `chat`) fresh reload → `data-testid="home-screen"` renders the `home` WidgetHost + DefaultHomeWidgets. **[COVERED: components/shell/HomeScreen.test.tsx]**
- [ ] Reach via HomeScreenMount from the shell (App.tsx `initialPage="home"`) → home half of the rail shows first. **[COVERED: components/shell/HomeLauncherSurface.test.tsx "honors initialPage"]**
- [ ] Back-button from a launched view returns to the home half, not a blank. **[GAP]**
- [ ] "show me my home / dashboard" chat intent lands on `/chat` home. **[GAP]**
- [ ] Fresh reload directly on `/chat` restores scroll to top (no persisted scroll leak). **[GAP]**

### Primary interactions
- [ ] AOSP native-OS tile tap (messages/phone/contacts/camera) calls `onOpenTile` with the exact `{kind:"tab",tab}` target — observable nav, not just click. **[COVERED: HomeScreen.test.tsx "opens an AOSP native-OS tile with the right target"]**
- [ ] Off-AOSP (`showNativeOsTiles=false`) renders ZERO tiles and no `home-tiles` nav element. **[COVERED: HomeScreen.test.tsx + run-home-screen-e2e.mjs desktop assertion]**
- [ ] AOSP build (`showNativeOsTiles=true`) renders exactly the 4 native tiles, none else. **[COVERED: HomeScreen.test.tsx "shows only the 4 native-OS tiles"]**
- [ ] `clockAccessory` host slot renders when provided and is absent (no default clock) when omitted. **[PARTIAL: HomeScreen.test.tsx asserts "no clock" but not the accessory render path]**
- [ ] Each per-plugin attention widget (finances/goals/notifications/relationships/calendar/health/inbox) self-hides when empty, renders populated content when fed. **[COVERED: run-home-screen-e2e.mjs widget matrix]**

### State matrix
- [ ] Empty: no widgets attention-worthy → only DefaultHomeWidgets base visible, never a blank screen. **[COVERED: e2e base-widget assertion]**
- [ ] Loading/skeleton for widget host while activity events hydrate. **[GAP]**
- [ ] Populated with many widgets → grid layout does not overflow the max-w-2xl column; scroll works with bottom composer clearance. **[GAP]**
- [ ] Failed activity fetch (`useActivityEvents` errors) → home still renders base, no crash. **[GAP]**
- [ ] Offline → widgets render last-known/empty, no latched spinner. **[GAP]**
- [ ] Guest/unauthenticated → home renders without private widget data leaking. **[GAP]**

### Repeated / rapid-fire
- [ ] Double/triple-tap a native tile fires `onOpenTile` once per intended nav, no duplicate view stack push. **[GAP]**
- [ ] Rapid re-render / resize never replays the `home-enter` fade (no card flash) — entrance plays exactly once. **[COVERED: HomeScreen.flicker.test.tsx (#9304)]**

### Back-and-forth / switching
- [ ] Home → launched view → back preserves widget scroll position. **[GAP]**
- [ ] Background app then resume → home does NOT re-fire the entrance animation. **[PARTIAL: flicker test covers re-render, not visibilitychange resume]**
- [ ] Reload mid activity-stream → home re-hydrates cleanly. **[GAP]**

### Fuzz / adversarial
- [ ] Long/emoji/RTL widget titles truncate (`truncate` on tile label) without breaking the 4-col grid. **[GAP]**
- [ ] A flood of activity events does not unbounded-grow the DOM (ranker caps rendered cards). **[GAP]**

### Input modalities
- [ ] Keyboard: Tab reaches each native tile button in DOM order; Enter/Space activates. **[GAP]**
- [ ] Touch: tap tile has `active:scale-[0.96]` press feedback; stilled under reduce-motion. **[GAP]**

### A11y / geometry
- [ ] `home-tiles` nav has `aria-label="Apps"`; each tile icon `aria-hidden`, label is the accessible name. **[PARTIAL: structure present, not asserted]**
- [ ] Tile tap target ≥44px (py-3.5 + icon) on mobile viewport. **[GAP]**
- [ ] `prefers-reduced-motion` stills the entrance fade (`.home-enter { animation:none }`). **[PARTIAL: CSS present; flicker test asserts single-run not reduce-motion]**
- [ ] Hover wash is `hover:bg-white/8` (neutral, no blue, no orange→black). **[GAP]**
- [ ] Layout-shift observer reports no CLS on card pop-in (dev telemetry channel). **[PARTIAL: observer installed; no committed assertion]**

### Concurrency / races
- [ ] `clearEvents` while new events stream in does not drop the just-arrived event or double-clear. **[GAP]**

---

## HomeLauncherSurface (home ↔ launcher rail)

### Entry / Nav
- [ ] Mount with `initialPage="home"` shows home first; `initialPage="launcher"` shows launcher first (route decides). **[COVERED: HomeLauncherSurface.test.tsx "honors initialPage"]**
- [ ] Both halves stay mounted at all times (no unmount on page flip). **[COVERED: HomeLauncherSurface.test.tsx "keeps both pages mounted"]**
- [ ] `data-page` attr reflects the shell-surface store (`home`/`launcher`) — single source of truth. **[COVERED: composed.test.tsx]**

### Primary interactions
- [ ] Left flick on home → `goLauncher()` store intent → page becomes `launcher`. **[COVERED: HomeLauncherSurface.test.tsx "flips to Launcher on a left flick"]**
- [ ] Right flick on launcher (page 0 / editing) → `goHome()`. **[COVERED: composed.test.tsx "swiping back from the launcher returns HOME"]**
- [ ] Launcher edge-swipe-right callback wired to `goHome` (via cloneElement `onNavigateHomeFromEdge`). **[COVERED: HomeLauncherSurface.test.tsx "lets Launcher edge-swipe back home"]**
- [ ] Rail tracks the finger continuously before commit (real translate3d, not post-release swap). **[COVERED: composed.test.tsx "tracks the rail with the finger"]**
- [ ] A committed flick suppresses the synthesized click so the tile underneath does not also launch. **[PARTIAL: suppressCommittedSwipeClick present; composed tests cover ghost-edit not ghost-launch click]**

### State matrix
- [ ] Vertical scroll of home widget list does NOT flip pages (dy dominates → axis=vertical). **[COVERED: HomeLauncherSurface.test.tsx "does NOT flip on a vertical scroll"]**
- [ ] Short left drag below distance threshold snaps back to home (no flip). **[COVERED: "does NOT flip on a short left drag"]**
- [ ] Rightward drag from home (page 0) rubber-bands, never navigates left past home. **[COVERED: "does NOT flip on a rightward drag"]**
- [ ] Launcher on inner page >0: parent pager `enabled=false` so inner launcher owns the swipe. **[PARTIAL: enabled logic present; assert inner-page ownership is a GAP]**

### Repeated / rapid-fire
- [ ] Spam left/right flicks A→B→A rapidly → store settles to one page, no oscillation/torn transform. **[GAP]**
- [ ] Non-primary pointer (secondary button / 2nd touch) is ignored mid-drag. **[COVERED: HomeLauncherSurface.test.tsx "ignores a non-primary pointer"]**

### Back-and-forth / switching
- [ ] Swipe to launcher then back home is NOT left in edit mode (store auto-resets edit on leave). **[COVERED: composed.test.tsx "returns HOME and is NOT in edit mode"]**
- [ ] In-session swipe not clobbered when parent re-renders (initialPage effect deps stable). **[PARTIAL: comment/logic present, no explicit test]**

### Fuzz / adversarial
- [ ] Decisive mostly-horizontal fast flick commits even if short (velocity path). **[COVERED: "flips on a decisive, mostly-horizontal left flick"]**
- [ ] Diagonal drag near the axis-dominance ratio resolves to a single axis, never both. **[GAP]**
- [ ] `pointercancel` mid-flick snaps back cleanly (Android WebView path). **[PARTIAL: covered in Launcher.gestures.test.tsx touch guard, not the rail]**

### A11y / geometry
- [ ] `aria-hidden` toggles correctly between the two half-pages by active `page`. **[PARTIAL: attr present, not asserted]**
- [ ] No competing page-dot strips (only one/zero indicator; #4). **[COVERED: composed.test.tsx "renders no page-indicator strips"]**
- [ ] `select-none` prevents text selection of tile labels during horizontal drag. **[GAP]**
- [ ] `touch-pan-y` reserves vertical browser scroll while claiming horizontal for the rail. **[GAP]**

### Concurrency / races
- [ ] A flick while a prior settle transition is still animating cancels/re-targets, no stuck offset. **[GAP]**

---

## HomePill (persistent bottom pill)

### Entry / Nav
- [ ] Mounted in every full-shell surface (via ShellFoundationMount) at `Z_SHELL_OVERLAY`; `data-testid="shell-home-pill"`. **[COVERED: __tests__/HomePill.test.tsx "renders a button labelled for the assistant"]**
- [ ] Also present in kiosk + chat-overlay shells (ShellFoundationMount). **[GAP]**

### Primary interactions
- [ ] Tap from `idle`/closed → `onOpen()` (opens AssistantOverlay). **[COVERED: HomePill.test.tsx "calls onOpen when clicked from idle"]**
- [ ] Tap while open (`summoned`/`listening`/`responding`) → `onClose()`. **[COVERED: HomePill.test.tsx "calls onClose when clicked from summoned"]**
- [ ] End-to-end: pill opens chat input, sends a message, closes from pill. **[COVERED: __tests__/shell-assistant-flow.test.tsx]**

### State matrix
- [ ] `booting`: disabled, `opacity-60 cursor-not-allowed`, click does nothing. **[COVERED: HomePill.test.tsx "is disabled while booting" + "does not call onOpen during booting"]**
- [ ] Mark color: `listening`→`bg-warn/70` animate-pulse; `responding`→`bg-accent/70`; `summoned`→`bg-foreground/40`; default→`bg-foreground/25`. **[PARTIAL: phase classes present; only aria-pressed asserted]**
- [ ] `aria-label` swaps Open/Close `${appName}` with branding. **[COVERED: HomePill.test.tsx label test]**
- [ ] `aria-pressed` true for summoned/listening/responding, false for idle/booting. **[COVERED: HomePill.test.tsx "is aria-pressed=…"]**

### Repeated / rapid-fire
- [ ] Mash the pill (open/close/open/close) → phase-derived isOpen keeps toggle consistent, no desync. **[GAP]**
- [ ] Rapid clicks during booting never queue a deferred open. **[PARTIAL: single disabled-click covered]**

### Input modalities
- [ ] Keyboard focus + Enter/Space toggles; focus ring visible. **[GAP]**
- [ ] Overlay shell owns native-window positioning (pill does not self-position). **[COVERED: HomePill.test.tsx "lets the overlay shell own native-window positioning"]**

### A11y / geometry
- [ ] Tap target `h-8 w-32` ≥44px effective width; mark is `aria-hidden`. **[PARTIAL]**
- [ ] Mark transition stilled under reduce-motion (pulse). **[GAP]**
- [ ] No blue; accent/warn tokens only. **[GAP]**

---

## NotificationCenter (bell popover)

### Entry / Nav
- [ ] Bell button renders in shell overlay region; `headless=true` renders no bell but keeps store/toast sink live. **[PARTIAL: NotificationCenter.test.tsx mounts non-headless; headless path not asserted]**
- [ ] Notification deep-link row navigates via `navigateDeepLink` and closes popover. **[GAP]**

### Primary interactions
- [ ] Bell click opens PopoverContent listing notifications. **[PARTIAL: test opens content implicitly via filter test]**
- [ ] Unread badge shows `unreadCount`, `99+` when >99, `BellRing` vs `Bell` icon by `hasUnread`. **[GAP]**
- [ ] Row click marks read (`markNotificationRead`) and, if `deepLink`, navigates. **[GAP]**
- [ ] Per-row dismiss (X) calls `removeNotification`, stops propagation (does not also open). **[GAP]**
- [ ] "Mark all read" (`markAllNotificationsRead`) clears unread badge + dots. **[GAP]**
- [ ] "Clear all" (`clearNotifications`) empties list → "You're all caught up" empty state. **[GAP]**
- [ ] Category filter chips filter rows; "All" resets. **[COVERED: NotificationCenter.test.tsx "filters notification rows by category without losing the all view"]**
- [ ] Active category drained → auto falls back to "All" (never empty filtered view). **[COVERED: NotificationCenter.test.tsx "falls back to all notifications"]**
- [ ] Filter bar only renders when >1 category present. **[PARTIAL: presentCategories logic present; single-category hide not asserted]**

### State matrix
- [ ] Empty inbox → Inbox icon + "You're all caught up", no filter bar, no mark/clear buttons. **[PARTIAL: covered indirectly]**
- [ ] Loading/hydrating store → no crash, no premature empty flash. **[GAP]**
- [ ] Many notifications → list scrolls within `max-h-[min(440px,60vh)]`, popover width clamps to `min(360px,100vw-1.5rem)`. **[GAP]**
- [ ] Failed store init / stream error → bell still renders. **[GAP]**
- [ ] Priority styling: urgent→error tint, high→accent tint, else muted. **[GAP]**

### Repeated / rapid-fire
- [ ] Double-click a row → single mark-read + single navigation (idempotent). **[GAP]**
- [ ] Spam dismiss on same row → `removeNotification` idempotent, no duplicate removals/errors. **[GAP]**
- [ ] Mash "Mark all read" → no duplicate network writes. **[GAP]**
- [ ] Rapid open/close popover → store re-init is idempotent (guarded), toast sink re-pointed not duplicated. **[PARTIAL: effect guards present, not asserted]**

### Back-and-forth / switching
- [ ] Open popover, navigate via deep-link, reopen → selection/scroll reset cleanly. **[GAP]**
- [ ] Toast sink unregistered on unmount (`registerNotificationToastSink(null)`). **[GAP]**

### Fuzz / adversarial
- [ ] Huge/emoji/RTL title + body → `truncate`/`line-clamp-2` hold layout. **[GAP]**
- [ ] Unknown category value falls back to `general` icon. **[PARTIAL: categoryIcon fallback present]**
- [ ] `deepLink` with injection-ish/malformed URL is handled safely by `navigateDeepLink`. **[GAP]**

### Input modalities
- [ ] Filter chips are `role=tab` with `aria-selected`; arrow/Tab navigation works. **[PARTIAL: roles present, keyboard not asserted]**
- [ ] Dismiss X hover-reveals (`opacity-0 group-hover:opacity-100`) but stays keyboard-reachable. **[GAP]**
- [ ] Escape closes popover, restores focus to bell. **[GAP]**

### A11y / geometry
- [ ] Bell `aria-label` announces unread count. **[PARTIAL: present, not asserted]**
- [ ] axe pass on open popover with populated + filtered list. **[GAP]**
- [ ] Chip hover: active `bg-accent hover:bg-accent/85` (orange→darker), inactive neutral. **[GAP]**

### Concurrency / races
- [ ] A live incoming notification while the popover is open updates the list without closing it. **[GAP]**
- [ ] Mark-all in flight while a new unread arrives → new one stays unread. **[GAP]**

---

## KioskViewCanvas (kiosk in-window view surfaces)

### Entry / Nav
- [ ] `?shellMode=kiosk` (or `ELIZAOS_SHELL_MODE`) boots KioskShell → `data-testid="kiosk-shell"` with the canvas + bottom pill. **[GAP]**
- [ ] Agent-spawned dynamic view session appears as an in-canvas surface. **[GAP]**

### Primary interactions
- [ ] Zero surfaces → empty prompt "Ask Eliza below to open something." **[GAP]**
- [ ] Full-bleed view mounts as an absolute-inset iframe with locked sandbox (`allow-scripts allow-same-origin allow-forms`, no top-navigation). **[GAP]**
- [ ] Floating (`alwaysOnTop`) view renders a draggable FloatingViewWindow with title bar. **[GAP]**
- [ ] Drag the floating window title bar → position follows pointer (pointer capture set/released). **[GAP]**
- [ ] Only ONE surface mounted at a time (newest full-bleed, or floating wins over full-bleed). **[GAP]**

### State matrix
- [ ] Empty / single full-bleed / single floating / floating+full-bleed (floating shown) selection matrix. **[GAP]**
- [ ] Iframe `src` failing to load does not crash the shell. **[GAP]**

### Repeated / rapid-fire
- [ ] Rapidly opening/closing surfaces re-selects the correct active one, unmounts the rest (RAF/WebGL stop). **[GAP]**
- [ ] Mashing the floating drag start/stop leaves no stuck pointer capture. **[GAP]**

### Back-and-forth / switching
- [ ] Switching active surface unmounts the previous iframe (key by windowId → full remount, no leaked RAF). **[GAP]**
- [ ] Floating window position resets on remount (local state), does not persist stale offset. **[GAP]**

### Fuzz / adversarial
- [ ] A view attempting top-navigation cannot replace the kiosk shell (sandbox omits allow-top-navigation). **[GAP]**
- [ ] Non-local (`http(s)`) entrypoint is rejected/never mounted (only file://loopback). **[GAP]**
- [ ] Drag beyond viewport bounds keeps the window partially reachable. **[GAP]**

### Input modalities
- [ ] Title bar `cursor-grab`/`active:cursor-grabbing`, `select-none`; pointer drag only (no keyboard reposition needed). **[GAP]**

### A11y / geometry
- [ ] iframe has a `title` = surface title. **[GAP]**
- [ ] Floating window respects width/height from surface, stays within canvas. **[GAP]**

### Concurrency / races
- [ ] Two surfaces arriving in the same tick → deterministic active-surface pick (last floating else last full-bleed). **[GAP]**

---

## LauncherSurface (`/apps`-derived launcher page)

### Entry / Nav
- [ ] Reach via launcher mode / left-swipe from home; renders `Launcher` with dedup'd view+catalog entries. **[COVERED: LauncherSurface.test.tsx]**
- [ ] `?shellMode=launcher` mounts HomeScreenMount `initialPage="launcher"`. **[PARTIAL: App wiring present; readShellMode has no committed test]**
- [ ] Hidden views (chat/views/apps/character/voice/background) never appear in the launcher grid. **[COVERED: LauncherSurface.test.tsx "hides Home/Launcher self-links"]**

### Primary interactions
- [ ] Tap a loaded view → browser route push (`pushState`+popstate) or hash on file://; records recent. **[COVERED: LauncherSurface.test.tsx "navigates loaded views through the browser route"]**
- [ ] Tap an un-loaded catalog app → `getCatalogEntry` fetch (lazy load), not a route push. **[COVERED: LauncherSurface.test.tsx "uses the catalog get action for available apps"]**
- [ ] Entry ordering: stable first-party views before developer/QA before catalog apps, then label-sort. **[COVERED: LauncherSurface.test.tsx "orders stable first-party views ahead of…"]**
- [ ] Settings appears in the favorites dock. **[COVERED: LauncherSurface.test.tsx "shows Settings as a favorite"]**

### Dynamic-view dev controls (developerMode + bridge available)
- [ ] Controls hidden when not developer or bridge unavailable. **[PARTIAL: `showDynamicViewControls` gate present; only-visible path not asserted]**
- [ ] Save form with id+title+entrypoint → `registerDynamicView({update:true})`, status "Saved …", refreshes. **[GAP]**
- [ ] Save with missing id/title/entrypoint → validation status "ID, title, and entrypoint are required." **[GAP]**
- [ ] Edit tile populates the form from the entry; Delete → `unregisterDynamicView`, status reflects removed/not-registered. **[GAP]**
- [ ] Clear button resets form + status. **[GAP]**
- [ ] `canManageView` only true for loaded, non-builtin `view` entries. **[GAP]**

### State matrix
- [ ] Loading with zero entries → skeleton tiles render. **[PARTIAL: Launcher.tsx skeleton path; LauncherSurface not asserted]**
- [ ] Empty catalog → grid renders nothing but dock/Settings still present. **[GAP]**
- [ ] Save/register bridge error → status shows the error message (not swallowed). **[GAP]**
- [ ] Modality filter: only entries matching `getActiveViewModality()` shown. **[PARTIAL: filter present, not asserted]**

### Repeated / rapid-fire
- [ ] Double-submit the dynamic-view form → single register call (idempotent update). **[GAP]**
- [ ] Spam launch of an un-loaded app → single in-flight `getCatalogEntry`, no duplicate loads. **[GAP]**

### Fuzz / adversarial
- [ ] Whitespace-only id/title/entrypoint → trimmed → validation rejects. **[PARTIAL: trims present; not asserted]**
- [ ] Huge/emoji entrypoint URL handled; malformed entrypoint surfaces bridge error. **[GAP]**

### Concurrency / races
- [ ] `refreshDynamicViews` after save races a concurrent catalog refresh → list converges, no duplicate tiles (dedupe by modality:id). **[PARTIAL: dedupeEntries covered logically via ordering test]**

---

## Launcher (icon grid + dock + edit mode)  — inner component

### Entry / Nav
- [ ] Renders every available view as a names-only icon tile. **[COVERED: Launcher.test.tsx "renders every view as a names-only icon tile"]**
- [ ] Preserves migrated Springboard manual order. **[COVERED: Launcher.test.tsx "preserves the manual order"]**

### Primary interactions
- [ ] Tap tile (not editing) launches; tap while editing does NOT launch. **[COVERED: Launcher.test.tsx "launches a view on tap" + "does not launch while editing"]**
- [ ] Long-press (450ms, stationary) enters edit mode; early release does not; pointercancel aborts. **[COVERED: Launcher.test.tsx long-press suite]**
- [ ] Favorite (+/★) toggles dock membership, persists layout, emits favorite/unfavorite telemetry. **[COVERED: Launcher.test.tsx + Launcher.gestures.test.tsx telemetry]**
- [ ] Unpin from dock; dock evicts oldest when full (LAUNCHER_DOCK_LIMIT). **[COVERED: Launcher.test.tsx "unpins…" + "evicts the oldest favorite"]**
- [ ] Controlled favorites clamp to LAUNCHER_DOCK_LIMIT even if caller supplies more. **[COVERED: Launcher.test.tsx "clamps the dock to LAUNCHER_DOCK_LIMIT"]**
- [ ] Edit-mode drag-reorder persists via moveIcon + emits reorder. **[COVERED: Launcher.gestures.test.tsx "persists a reordered page"]**
- [ ] Edit + manageable tile shows Edit/Delete affordances calling onEditView/onDeleteView. **[PARTIAL: buttons present; LauncherSurface handlers untested]**
- [ ] Preview/Dev kind badges shown without altering release tiles. **[COVERED: Launcher.test.tsx "marks preview and developer tiles"]**

### Paging (useHorizontalPager)
- [ ] Page dots shown when >1 page (standalone); hidden when `showPageDots=false` (nested rail). **[COVERED: Launcher.test.tsx "shows page dots" + composed.test.tsx no-strips]**
- [ ] Navigate pages via dots (standalone). **[COVERED: Launcher.test.tsx "navigates pages via the page dots"]**
- [ ] Adjacent pages slide with finger before commit; advance past threshold emits page-swipe. **[COVERED: Launcher.test.tsx "slides adjacent pages" + gestures "advances a page past the swipe threshold"]**
- [ ] Drag below threshold ignored; clamp at first page (no underflow); no paging while editing. **[COVERED: Launcher.gestures.test.tsx suite]**
- [ ] Rubber-band at last-page edge. **[COVERED: Launcher.test.tsx "rubber-bands at the last page edge"]**
- [ ] Touch swipe advances WITHOUT taking pointer capture (Android WebView guard). **[COVERED: Launcher.gestures.test.tsx "advances a page on a touch swipe without taking pointer capture"]**

### State matrix
- [ ] Loading + zero entries → skeleton grid (8 placeholders). **[PARTIAL: rendered path exists; assertion GAP]**
- [ ] View removed on re-render → tile dropped + page clamps in range. **[COVERED: Launcher.test.tsx "drops views that are no longer available" + local-page clamp]**
- [ ] New view added on re-render → appended as tile. **[COVERED: Launcher.test.tsx "appends a newly-available view"]**
- [ ] Image tile: renders imageUrl over glyph; glyph fallback when absent; glyph for dedicated cloud agents. **[COVERED: Launcher.test.tsx image-tile suite]**

### Repeated / rapid-fire
- [ ] Mash favorite toggle → dock converges, no duplicate ids, telemetry paired enter/exit. **[COVERED: Launcher.gestures.test.tsx "emits favorite then unfavorite"]**
- [ ] Long-press toggle spam enter/exit → edit state consistent, emits enter/exit. **[COVERED: Launcher.gestures.test.tsx "emits edit-mode enter/exit via long-press toggle"]**
- [ ] Double-tap tile → single launch. **[GAP]**

### Fuzz / adversarial
- [ ] Long/emoji/RTL view labels truncate (`max-w-[4.5rem] truncate`). **[GAP]**
- [ ] Horizontal swipe starting ON a tile never ghost-fires edit mode (move-slop cancels long-press). **[COVERED: composed.test.tsx "swipe that starts ON a tile never ghost-fires edit mode"]**
- [ ] Reorder to an out-of-range page index clamps, no crash. **[GAP]**

### A11y / geometry
- [ ] Each tile button `aria-label`=label; fav/edit/delete have descriptive labels (Pin/Unpin/Edit/Delete). **[PARTIAL: labels present, axe not asserted]**
- [ ] Icon tile ≥44px (`h-16 w-16`); inactive pages `inert`+`aria-hidden`+pointer-events-none. **[PARTIAL: attrs present]**
- [ ] Tile hover `hover:bg-black/45` (neutral darken, no blue/orange→black). **[GAP]**
- [ ] Reduce-motion: rail transition + edit-mode `animate-pulse` stilled. **[GAP]**

### Concurrency / races
- [ ] Layout reconcile (install/uninstall) during an in-flight page swipe keeps page index valid. **[GAP]**

---

## useHorizontalPager (shared gesture hook)

### Primary behavior
- [ ] Axis lock: horizontal only when `|dx| > |dy| * 1.15` past 6px slop; else vertical (no paging). **[PARTIAL: covered via Launcher/HomeLauncher, no dedicated hook test]**
- [ ] Commit thresholds: distance ≥max(64, 24% width) OR flick (≥48px & velocity ≥0.45 & axis-dominant). **[PARTIAL: via callers]**
- [ ] Edge resistance (0.35) at page 0 rightward and last-page leftward. **[COVERED via Launcher rubber-band + HomeLauncher rightward tests]**
- [ ] `edgeSwipeRightEnabled` fires `onEdgeSwipeRight` from page 0 right-flick. **[COVERED: HomeLauncherSurface edge-swipe test]**
- [ ] Non-primary pointer ignored; `enabled=false` disables all gestures. **[COVERED: HomeLauncherSurface non-primary + Launcher edit-mode disable]**
- [ ] Touch pointers not explicitly captured (implicit); mouse/pen captured. **[COVERED: Launcher.gestures.test.tsx touch guard]**

### State / recovery
- [ ] ResizeObserver re-writes offset to current page on resize (not mid-drag). **[GAP]**
- [ ] Layout effect settles to clamped page on page/pageCount change; no transition on first mount. **[PARTIAL: via callers]**
- [ ] `pointercancel`/`lostpointercapture` snaps back without committing. **[PARTIAL: via Launcher]**

### Concurrency / races
- [ ] rAF-scheduled offset flush coalesces multiple pointermoves into one write. **[GAP]**
- [ ] cancelScheduledOffset on unmount prevents post-unmount rail write. **[GAP]**

### Fuzz
- [ ] pageCount ≤0 or page out of range clamps safely (clampPage). **[GAP]**
- [ ] Zero-width viewport falls back to window width / min 1 (no divide/NaN offset). **[GAP]**

---

## Shell mode router (`readShellMode` / App.tsx)

### Entry / Nav
- [ ] `?shellMode=` and `?shell-mode=` and `window.ELIZAOS_SHELL_MODE` all resolve; hash-query fallback parsed. **[GAP]**
- [ ] Unknown/empty value → `"full"`. **[GAP]**
- [ ] Each mode mounts its shell: chat-overlay→`chat-overlay-shell`, onboarding→`onboarding-overlay-shell`, tray-popover→`tray-popover-shell`, kiosk→`kiosk-shell`, launcher→launcher HomeScreenMount, full→app. **[GAP]**

### Per-mode surface
- [ ] TrayPopoverShell renders only `WidgetHost slot="home" layout="stack"` (no chrome). **[GAP]**
- [ ] ChatOverlayShell is pointer-events-none except the pill/overlay (click-through). **[GAP]**
- [ ] OnboardingOverlayShell is click-through with an interactive CompactOnboarding card. **[GAP]**
- [ ] KioskShell has no header/tabs/desktop chrome; always-visible bottom pill. **[GAP]**

### State / recovery
- [ ] Mode is read once at mount (`useState(readShellMode)`) — does not thrash on later URL changes. **[GAP]**
- [ ] Reload on a mode URL restores the same shell. **[GAP]**

---

## Coverage summary

| View / surface | Existing test path(s) | Biggest gap |
| --- | --- | --- |
| HomeScreen | `components/shell/HomeScreen.test.tsx`, `HomeScreen.flicker.test.tsx`, `__e2e__/run-home-screen-e2e.mjs` | No a11y/keyboard, overflow, or offline/error-state assertions |
| HomeLauncherSurface | `components/shell/HomeLauncherSurface.test.tsx`, `HomeLauncherSurface.composed.test.tsx` | Rapid A→B→A flick + mid-settle re-flick races untested |
| HomePill | `components/shell/__tests__/HomePill.test.tsx`, `__tests__/shell-assistant-flow.test.tsx` | Phase→mark-color mapping + rapid toggle desync untested |
| NotificationCenter | `components/shell/NotificationCenter.test.tsx` (filter only) | **Mark-all / clear / dismiss / row-open+deep-link / badge / empty-state are all untested — the core actions have zero coverage** |
| KioskViewCanvas | none | **Entire component untested — active-surface selection, sandbox lock, floating-window drag, single-mount all GAP** |
| LauncherSurface | `components/pages/LauncherSurface.test.tsx` | Dynamic-view dev CRUD form (save/validate/edit/delete/clear) untested |
| Launcher | `components/pages/Launcher.test.tsx`, `Launcher.gestures.test.tsx` | Manageable Edit/Delete affordance handlers + double-tap idempotency |
| useHorizontalPager | none (tested only via callers) | No direct hook test: resize, rAF coalescing, clamp/NaN edge inputs |
| Shell mode router | none | **`readShellMode` + all 5 non-full shells (kiosk/tray/overlay/onboarding/launcher) have no committed test** |

**Biggest single gap in the group:** `KioskViewCanvas` and the entire shell-mode router (`readShellMode` → KioskShell/TrayPopoverShell/ChatOverlayShell/OnboardingOverlayShell) have **zero committed tests** — active-surface selection, the iframe sandbox lock that prevents a view from replacing the kiosk shell, floating-window drag, and which shell each `?shellMode=` value boots are entirely unverified. Closely tied for worst is `NotificationCenter`, whose destructive/mutating actions (mark-all-read, clear-all, per-row dismiss, row-open + deep-link navigation, unread badge) are all untested while only the category filter is covered.
