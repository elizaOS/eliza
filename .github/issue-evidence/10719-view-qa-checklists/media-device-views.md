# Media & Device Views — QA Checklist

Scope: Camera (`/camera`), Phone (`/phone`), Messages (`/messages`), Contacts (`/contacts`) — the ElizaOsAppsView phone surface + permission gating — Stream (`/stream` + popout), and Browser (`/browser`, `BrowserWorkspaceView`).

Source files: `packages/ui/src/components/pages/CameraPageView.tsx`, `packages/ui/src/components/pages/ElizaOsAppsView.tsx` (`PhonePageView` L647 / `MessagesPageView` L1533 / `ContactsPageView` L1836), `packages/ui/src/components/pages/StreamView.tsx`, `packages/ui/src/components/pages/BrowserWorkspaceView.tsx`.

Coverage legend: **COVERED** = a committed test exercises it (spec cited); **PARTIAL** = touched only by a generic nav/screenshot walk; **GAP** = no committed test.

---

## Camera (`/camera`)

### Entry / Nav
- [ ] Reach via `camera` TAB_PATHS route `/camera`; renders `data-testid="camera-view"`. — PARTIAL (`builtin-views-visual.spec.ts`, `all-views-interaction.spec.ts`, `all-pages-clicksafe.spec.ts` navigate only)
- [ ] Fresh reload directly on `/camera` re-runs the mount `startPreview` effect and lands on `starting`→`live`. — GAP
- [ ] Reach from HomeScreen AOSP `nativeOs` camera tile (see HomeScreen tiles). — GAP
- [ ] Reach via chat "open the camera" intent (view-switch). — GAP
- [ ] Back-button out of `/camera` fires the unmount cleanup `Camera.stopPreview()` (camera released). — COVERED (`CameraPageView.test.tsx` "stops the preview on unmount")

### Primary Interactions
- [ ] Mount requests permission (`Camera.requestPermissions`) exactly once then `startPreview({direction:"back"})`. — COVERED (`CameraPageView.test.tsx` "requests permission and starts…")
- [ ] Capture button (`camera-capture`) calls `capturePhoto({format:"jpeg",quality:90})` and shows `camera-photo` review overlay with the returned image. — COVERED (`CameraPageView.test.tsx` "captures a photo…")
- [ ] Retake button (`camera-retake`) clears `photo` and returns to live controls. — COVERED (same test)
- [ ] Switch button (`camera-switch`) calls `switchCamera` and flips `facing` back↔front without restarting preview. — COVERED (`CameraPageView.test.tsx` "switches between front and back")
- [ ] `camera-switch` / `camera-capture` are no-ops while `busy` or when `status!=="live"` (guard at handler top). — GAP
- [ ] Retry button (`camera-retry` / callout `onRetry`) re-invokes permission+startPreview using current `facing`. — PARTIAL (denied/error states asserted; retry click not driven)

### State Matrix
- [ ] `starting`: `camera-starting` spinner visible, no controls. — GAP (states not asserted individually beyond mount)
- [ ] `live`: preview `<video>` fills, capture + switch controls shown. — COVERED (mount test)
- [ ] `denied`: `camera-denied` + `PermissionRecoveryCallout` (`camera-permission-callout`) shown, `startPreview` never called. — COVERED (`CameraPageView.test.tsx` "shows the permission-denied state and never starts a preview")
- [ ] `error`: `camera-error-state` with `AlertTriangle` + message + retry. — COVERED (`CameraPageView.test.tsx` "surfaces an unavailable camera as the error state")
- [ ] Non-fatal live error (switch/capture throws while live): `camera-error` toast (`role="alert"`) over live preview, preview stays. — GAP
- [ ] Permission-denied error string variants ("permission"/"notallowed"/"denied", case-insensitive) all route to `denied` not `error` (`isPermissionDeniedError`). — GAP
- [ ] Offline / no-camera hardware degrades to `error` state (not blank/dead-end). — PARTIAL

### Repeated / Rapid-fire
- [ ] Mash capture button rapidly → only one `capturePhoto` in flight (busy guard); no duplicate photos. — GAP
- [ ] Spam switch button → single `switchCamera`, `facing` toggles deterministically, no orphaned streams. — GAP
- [ ] Double-tap retry in error state → single permission request, no stacked spinners. — GAP

### Back-and-forth / Switching & Recovery
- [ ] Navigate away mid-capture then back → new mount restarts preview cleanly, prior photo not resurrected. — GAP
- [ ] `/camera`→`/chat`→`/camera` rapidly → each unmount calls `stopPreview`, each mount starts fresh (no leaked camera). — PARTIAL (unmount stop covered once)
- [ ] Background the app on a live preview then resume → preview resumes or shows a recoverable state (not a black frozen frame). — GAP
- [ ] Reload while photo review is open → returns to live (photo state is not persisted). — GAP

### Fuzz / Adversarial
- [ ] `capturePhoto` returns base64 already prefixed `data:` vs bare base64 → `photoDataUrl` builds a valid src both ways. — GAP
- [ ] `photo.format` missing / non-mime (`"jpeg"` vs `"image/png"`) → src still valid. — GAP
- [ ] Permission promise rejects (bridge unavailable) → `error` state, no unhandled rejection. — PARTIAL

### Input Modalities
- [ ] Keyboard: Tab reaches switch + capture; Enter/Space triggers capture; focus ring visible. — GAP
- [ ] Touch: capture button ≥44px (72px), switch button 44px; `active:scale-95` press feedback (disabled under reduced-motion via `motion-reduce:active:scale-100`). — GAP
- [ ] Reduced-motion honored on capture press + spinner. — GAP

### A11y / Geometry
- [ ] `camera-switch` has `aria-label`, `camera-capture` has `aria-label`; captured `<img>` has alt. — GAP (present in source; not asserted)
- [ ] axe pass in `live`, `denied`, `error`, `photo` states. — GAP
- [ ] Hover on switch/capture = white/opacity (neutral), never blue; no orange→black. — GAP

### Concurrency / Races
- [ ] Cancelled-mount guard: rapid mount→unmount before `startPreview` resolves calls `stopPreview` and never sets `live` on a dead component (`cancelled` flag). — GAP
- [ ] Switch while a capture is in flight → busy guard serializes; no interleaved bridge calls. — GAP

---

## Phone (`/phone` — `PhonePageView`)

### Entry / Nav
- [ ] Reach via `phone` TAB_PATHS `/phone`. — PARTIAL (generic view walks; the deterministic `apps-comms-device-interactions.spec.ts` targets the separate `/apps/phone` native shell `phone-shell`, NOT this `elizaos-apps` surface)
- [ ] Reach from HomeScreen AOSP phone tile (navigation/index.ts L148, group tabs `["phone","messages","contacts"]`). — GAP
- [ ] Deep-link with launch params seeds `number` (`useLaunchParams`/`readLaunchParams` from hash). — GAP
- [ ] Fresh reload on `/phone` runs `refresh()` (getStatus + gated call-log + gated contacts). — GAP

### Primary Interactions
- [ ] Panel tabs (`phone-tab-dialer|recents|contacts|import|transcripts`) switch `activePanel`; only one active. — GAP
- [ ] Dialpad buttons append digit to `number` (`appendDialpadKey`). — GAP
- [ ] Place Call → `plugins.phone.plugin.placeCall({number})`, notice "handed to Android Telecom", auto-switches to `recents`. — GAP
- [ ] Empty `number` on Place Call throws "number is required" → error notice, no plugin call. — GAP
- [ ] Open Dialer → `openDialer({number|undefined})`. — GAP
- [ ] Recents rows (`RecentCallButton`) select a call → sets `selectedCallId`, reveals transcript editor. — GAP
- [ ] Contacts panel search submit (`phone-contacts-search-submit`) re-lists with `contactListOptions`. — GAP
- [ ] Contact row Dial (`phone-contact-dial-*`) / SMS (`phone-contact-sms-*`) → dial number / `openMessagesForNumber` sets `#messages?recipient=`. — GAP
- [ ] Create-contact form (name/phone/email) → `createContact`, clears fields, refreshes, switches to `contacts`. — GAP
- [ ] Create with empty displayName throws "displayName is required". — GAP
- [ ] Import: vCard textarea → `importVCardText` → notice "Imported N contact(s)", clears, switch to contacts. — GAP
- [ ] Import file picker (`importSelectedFile`) reads file text, resets input value, imports; picking nothing is a no-op. — GAP
- [ ] Role rows (`phone-role-request-*`) → `onRequest(role)` request. — GAP
- [ ] Save transcript (`saveTranscript`) persists `transcriptDraft`/`summaryDraft` for `selectedCall`. — GAP

### State Matrix
- [ ] Call-log permission denied → `ensureNativeReadGranted` false → calls list stays `[]` (no raw Capacitor console.error). — COVERED at unit level (`ElizaOsAppsView.permission-gate.test.ts` decision table) — GAP at component level
- [ ] Contacts permission denied → contacts `[]`, no native read attempted. — COVERED unit / GAP component
- [ ] Web / null permission model → reads proceed (`ensureNativeReadGranted(null,null)===true`). — COVERED (`permission-gate.test.ts`)
- [ ] Plugin unavailable (`getStatus`/`listRecentCalls`/`listContacts` not a function) → thrown "…is unavailable" surfaces in error. — GAP
- [ ] Empty recents / empty contacts → `EmptyState` copy. — GAP
- [ ] `busy` disables all action buttons during in-flight ops. — GAP
- [ ] Many contacts / many calls (100 limit) → list scrolls, no overflow break. — GAP

### Repeated / Rapid-fire
- [ ] Mash Place Call → single `placeCall` (busy guard), one panel switch. — GAP
- [ ] Spam dialpad → `number` grows deterministically, no dropped/duplicated digits. — GAP
- [ ] Submit create-contact twice fast → no duplicate contact rows. — GAP
- [ ] Rapid panel-tab clicks → `activePanel` lands on last click, no stuck tab. — GAP

### Back-and-forth / Switching & Recovery
- [ ] Switch dialer↔contacts↔import repeatedly → per-panel drafts (`number`, `vcardText`, create fields) preserved until submit clears them. — GAP
- [ ] Leave mid-`refresh` and return → in-flight read settles without setting state on unmounted view. — GAP
- [ ] SMS deep-link from contact row round-trips to Messages view with `recipient` prefilled. — GAP

### Fuzz / Adversarial
- [ ] Paste huge/emoji/RTL/whitespace into `number` → trimmed; whitespace-only rejected as "number is required". — GAP
- [ ] Malformed vCard text → import error surfaced, not a crash. — GAP
- [ ] Injection-ish contact name/number stored+rendered as text (no HTML/hash-nav injection via `openMessagesForNumber` encodeURIComponent). — GAP
- [ ] Non-numeric digits appended to dialer handled by native, UI never NaNs. — GAP

### Input Modalities
- [ ] Keyboard tab order across dialpad → call → panels; Enter on dialpad appends. — GAP
- [ ] Touch tap targets ≥44px for dialpad + row actions. — GAP
- [ ] File-picker keyboard-accessible for vCard import. — GAP

### A11y / Geometry
- [ ] `output` region announces dialed number; role/status notices via `StatusNotice`. — GAP
- [ ] axe pass on each panel. — GAP
- [ ] Hover on `PrimaryButton`/`SecondaryButton`/tabs = orange→darker-orange (primary) / neutral-opacity (secondary), no blue. — GAP

### Concurrency / Races
- [ ] `Promise.all([getStatus, gated-calls, gated-contacts, roles])` — one leg failing surfaces error without corrupting the others. — GAP
- [ ] Place-call while `refresh` pending → busy guard serializes; `activePanel` not thrashed. — GAP

---

## Messages (`/messages` — `MessagesPageView`)

### Entry / Nav
- [ ] Reach via `messages` TAB_PATHS `/messages`. — PARTIAL (generic walk; deterministic spec targets separate `/apps/messages` `messages-shell`)
- [ ] Deep-link `#messages?recipient=…` / `?sender=…` seeds `address`; `?body=` seeds body (`initialMessageBody`). — GAP
- [ ] Deep-link incoming-SMS context params → `readIncomingSmsContext` shows the incoming card. — GAP
- [ ] Deep-link `?event=…` (+ `?unsupported`) seeds the `notice`/MMS-WAP-push warning. — GAP
- [ ] `params` change re-syncs address/body/incoming/notice (the `useEffect([params])`). — GAP

### Primary Interactions
- [ ] Send (`messages-send`) → validates non-empty address+body (trims), calls `sendSms({address,body})`, notice "SMS sent and saved as message {id}", then `refresh`. — PARTIAL (the deterministic spec asserts a `messages-send`/"Message sent." on the OTHER shell, not this surface)
- [ ] Empty address → "address is required"; empty body → "body is required" (thrown → error notice), no plugin call. — GAP
- [ ] Refresh (`messages-refresh`) → gated `listMessages({limit:100})`. — GAP
- [ ] Address/body TextInput/TextArea round-trip value → state. — GAP
- [ ] Incoming-SMS auto-forward (when `ANDROID_SMS_GATEWAY_ENABLED`) POSTs webhook once per message key, sends cloud reply via `sendSms`, dedupes via `forwardedIncomingIds`. — GAP

### State Matrix
- [ ] SMS permission denied → `messages=[]` + error "SMS permission is required…". — COVERED unit (`permission-gate.test.ts`) / GAP component
- [ ] Plugin `listMessages`/`sendSms` not a function → "ElizaMessages plugin is unavailable" error. — GAP
- [ ] Empty list → `EmptyState` "No messages returned by Android." — GAP
- [ ] Gateway secret missing while incoming present → error "Android SMS gateway secret is not configured." — GAP
- [ ] Gateway webhook non-OK response → error with status+payload. — GAP
- [ ] `busy` disables Send + Refresh. — GAP
- [ ] Many messages (100) with long bodies → `max-h-[60vh]` scroll, `whitespace-pre-wrap` no overflow break. — GAP

### Repeated / Rapid-fire
- [ ] Double-click Send → one `sendSms`, one saved message (busy guard). — GAP
- [ ] Same incoming SMS delivered twice (same key) → forwarded once only (`forwardedIncomingIds` set). — GAP
- [ ] Mash Refresh → no overlapping `listMessages` duplicating rows. — GAP

### Back-and-forth / Switching & Recovery
- [ ] Leave with a composed draft and return → address/body retained (or re-seeded from params, not silently lost). — GAP
- [ ] Incoming-forward in flight when navigating away → `cancelled` flag prevents setState after unmount. — GAP
- [ ] Reload mid-send → no partial/dup message; list reflects server truth on next refresh. — GAP

### Fuzz / Adversarial
- [ ] Paste huge body / emoji / RTL / newline-only → trim rejects whitespace-only; large body sends or errors cleanly. — GAP
- [ ] Address with spaces / `+`/letters → trimmed; native validates; UI never crashes. — GAP
- [ ] Injection-ish body stored + rendered as text (no HTML). — GAP
- [ ] Malformed incoming-SMS params (missing sender/timestamp/body) → card falls back to "unknown sender"/"Unknown time"/"Empty SMS body". — GAP

### Input Modalities
- [ ] Keyboard: Tab address→body→Send; Enter in single-line address does not accidentally submit-and-clear. — GAP
- [ ] Touch tap targets ≥44px. — GAP

### A11y / Geometry
- [ ] `StatusNotice` announced (role="status"/alert). — GAP
- [ ] axe pass compose + list. — GAP
- [ ] Hover on Send = orange→darker-orange, Refresh neutral; no blue. — GAP

### Concurrency / Races
- [ ] Send while Refresh pending → serialized by `busy`; final list includes the sent message once. — GAP
- [ ] Incoming auto-forward + manual send overlap → no interleaved corrupt state. — GAP

---

## Contacts (`/contacts` — `ContactsPageView`)

### Entry / Nav
- [ ] Reach via `contacts` TAB_PATHS `/contacts`. — PARTIAL (generic walk; deterministic spec targets separate `/apps/contacts` `contacts-shell`)
- [ ] Fresh reload runs `refresh()` (gated `listContacts`). — GAP
- [ ] Reach from Phone view "switch to contacts" panel/deep-link. — GAP

### Primary Interactions
- [ ] Create form (`contacts-create-display-name/phone-number/email`) → `createContact`, notice "Created contact {id}", clears all three fields, refreshes list. — GAP
- [ ] Empty displayName → "displayName is required" error, no plugin call. — GAP
- [ ] Optional phone/email omitted → passed as `undefined` (not empty string). — GAP
- [ ] Search (`contacts-search`) updates `query`; `listOptions` memo re-lists on Refresh with trimmed query (`undefined` when blank). — GAP
- [ ] Refresh (`contacts-refresh`) → gated `listContacts({limit:100,query})`. — GAP

### State Matrix
- [ ] Contacts permission denied → `contacts=[]` + error "Contacts permission is required…". — COVERED unit (`permission-gate.test.ts`) / GAP component
- [ ] Plugin `listContacts`/`createContact` not a function → "ElizaContacts plugin is unavailable". — GAP
- [ ] Empty list → `EmptyState` "No contacts returned by Android." — GAP
- [ ] Contact with no numbers → "No phone numbers"; with emails → email line shown. — GAP
- [ ] `busy` disables Create + Refresh. — GAP
- [ ] Many contacts (100) → `max-h-[60vh]` scroll. — GAP

### Repeated / Rapid-fire
- [ ] Double-click Create → one contact created (busy guard), fields cleared once. — GAP
- [ ] Mash Refresh with a query → single `listContacts`, no dup rows. — GAP
- [ ] Rapid query typing → only Refresh (not each keystroke) re-lists (memo dependency). — GAP

### Back-and-forth / Switching & Recovery
- [ ] Leave with a half-filled create form and return → fields state (retained or cleanly reset, documented). — GAP
- [ ] `/contacts`→`/phone`→`/contacts` → list re-fetches, selection/query state consistent. — GAP

### Fuzz / Adversarial
- [ ] Huge/emoji/RTL/whitespace displayName → trimmed; whitespace-only rejected. — GAP
- [ ] Injection-ish name/email rendered as text (no HTML). — GAP
- [ ] Query with special chars (`%`, quotes) → passed to native safely, no crash/empty-hang. — GAP

### Input Modalities
- [ ] Keyboard tab order name→phone→email→Create; Enter submits from a field intentionally (not accidental). — GAP
- [ ] Search + Refresh reachable by keyboard; ≥44px targets. — GAP

### A11y / Geometry
- [ ] axe pass create + list. — GAP
- [ ] Hover Create = orange→darker-orange; Refresh neutral; no blue. — GAP

### Concurrency / Races
- [ ] Create while a Refresh is pending → serialized; new contact appears exactly once. — GAP

---

## Stream (`/stream` + popout)

### Entry / Nav
- [ ] Reach via `stream` TAB_PATHS `/stream`; tab hidden in nav unless streaming enabled but route stays addressable (navigation/index.ts L37). — PARTIAL (`builtin-views-visual.spec.ts`, `all-views-interaction.spec.ts` list `{id:"stream",path:"/stream"}` — nav/screenshot only)
- [ ] Fresh reload on `/stream` fires one `client.streamStatus()` then polls every 5s while document visible (`useIntervalWhenDocumentVisible`). — GAP
- [ ] Popout URL (`?popout`) → `IS_POPOUT` true → toggling live does NOT re-open a second popout. — GAP
- [ ] `StreamView` rendered inside a modal (`inModal`) → transparent bg variant. — GAP

### Primary Interactions
- [ ] Go Live button (`StatusBar` `onToggleStream`) when offline → `client.streamGoLive()`, sets live from `result.live`; if live && !popout && !electrobun → `openStreamPopout(apiBase)`. — GAP
- [ ] Go Live when already live → `client.streamGoOffline()`, sets `streamLive=false`. — GAP
- [ ] Button disabled while `!streamAvailable || streamLoading`. — GAP
- [ ] Status panel shows uptime (`formatUptime`) + frameCount (`toLocaleString`) when live; "Press Go Live" hint when ready. — GAP
- [ ] Live dot animates (`animate-pulse` on `bg-danger`) only when live. — GAP

### State Matrix
- [ ] Initial load (no cache) → `DetailSkeleton` while `initialLoading && streamAvailable && !statusError`. — GAP
- [ ] Cache-seeded revisit → paints last-known status instantly, no skeleton flash (`getCached(STREAM_STATUS_CACHE_KEY)`). — GAP
- [ ] `streamStatus` 404 → `streamAvailable=false` → "Streaming unavailable / enable the streaming plugin" panel; polling stops. — GAP
- [ ] `streamStatus` non-404 error → `statusError` alert panel (not a fake healthy idle). — GAP
- [ ] Ready (available, not live) vs Live panels render distinct copy. — GAP
- [ ] Offline (network down) → status read fails → error surfaced, recovers on next poll. — GAP

### Repeated / Rapid-fire
- [ ] Mash Go Live → `loadingRef` guard prevents overlapping `streamGoLive`/`streamGoOffline`; single toggle. — GAP
- [ ] Toggle live→offline→live rapidly → no stuck `streamLoading` spinner; final state matches last action. — GAP
- [ ] Toggle failure → catch re-reads `streamStatus` to reconcile (no latched wrong state). — GAP

### Back-and-forth / Switching & Recovery
- [ ] Leave `/stream` (tab hidden) → polling pauses (document-visibility interval), resumes on return. — GAP
- [ ] Background app while live → poll pauses, resumes and reconciles uptime/frameCount on foreground. — GAP
- [ ] Reload mid-toggle → status poll within 5s reconciles live/offline truth. — GAP
- [ ] `pollStatus` in-flight (`loadingRef`) skips setState after a toggle to avoid clobbering (guards at L49). — GAP

### Fuzz / Adversarial
- [ ] `streamStatus` returns `running:true, ffmpegAlive:false` → treated as NOT live (both required). — GAP
- [ ] Huge frameCount → `toLocaleString("en-US")` formats, no overflow. — GAP
- [ ] Rapid visibility toggles → no runaway interval stacking. — GAP

### Input Modalities
- [ ] Keyboard: Go Live focusable, Enter/Space toggles; disabled state not focus-trappable into a dead click. — GAP
- [ ] Touch tap target ≥44px. — GAP

### A11y / Geometry
- [ ] `statusError` panel `role="alert"`. — GAP
- [ ] axe pass ready/live/unavailable/error states. — GAP
- [ ] Live dot uses `bg-danger` (red), not orange/blue; Go Live hover orange→darker-orange. — GAP

### Concurrency / Races
- [ ] Poll fires while a toggle is in flight → `loadingRef` skip prevents state clobber. — GAP
- [ ] `streamGoLive` resolves after user navigated away → no popout opened / no setState on unmounted view. — GAP

---

## Browser (`/browser` — `BrowserWorkspaceView`)

### Entry / Nav
- [ ] Reach via `browser` TAB_PATHS `/browser`; renders `data-testid="browser-workspace-view"` (`AppWorkspaceChrome`). — COVERED (`browser-workspace.spec.ts` waits for `browser-workspace-view`)
- [ ] Fresh reload on `/browser` restores tab set from `/api/browser-workspace` snapshot. — PARTIAL (spec resets+recreates tabs; restore-on-reload not asserted)
- [ ] Reach from chat "open a browser / go to <url>" (agent bridge). — COVERED-ish (`browser-skills-agent-bridge.spec.ts`, 2 tests)

### Primary Interactions
- [ ] New tab "+" → creates a live tab (default docs URL), selects it. — COVERED (`browser-workspace.spec.ts` "can create live tabs and switch selection")
- [ ] Tab click (`tab-<id>`, `role="tab"`) → activates tab, toggles native OOPIF paint/hidden (inactive tabs `pointer-events:none`). — PARTIAL (selection switch covered; OOPIF paint/hit-testing not)
- [ ] Tab close (`tab-close-<id>`) → removes tab; internal tabs have no close button. — PARTIAL (spec resets via DELETE API, not the close button)
- [ ] URL/location bar submit → `loadURL(url)` on selected tab; `locationInput`/`locationDirty` round-trip. — GAP
- [ ] Back / Forward / Reload controls → `goBack`/`goForward`/`reload` on selected tab. — GAP
- [ ] Tabs sidebar collapse toggle (`tabsSidebarCollapsed`). — GAP
- [ ] Wallet consent / injection bridge round-trip (approve/reject) → `useBrowserWorkspaceWalletBridge`. — COVERED unit (`browser-workspace-wallet.test.ts` 6, `browser-workspace-wallet-injection.test.ts` 3)
- [ ] Mobile runtime-mode switch (`mobileRuntimeMode`). — GAP

### State Matrix
- [ ] No tabs → empty workspace state / auto-new-tab. — PARTIAL
- [ ] `browserBridgeLoading` skeleton → available vs unavailable (`browserBridgeAvailable`). — GAP
- [ ] Frame-blocked URL (`isBrowserWorkspaceFrameBlockedUrl`, X-Frame-Options hosts) → blocked-frame fallback, not a blank pane. — GAP
- [ ] Internal tab (`kind:"internal"`) vs standard tab rendering + label (`inferBrowserWorkspaceTitle`, provider/status details). — GAP
- [ ] `about:blank` new tab → "New tab" title. — GAP
- [ ] Load error / offline URL → error surfaced in tab, not a hung spinner. — GAP
- [ ] Many tabs → sidebar scrolls, selection persists. — GAP

### Repeated / Rapid-fire
- [ ] Mash "+" → N tabs, no duplicate-id collision (`tabExecCounterRef`/`tabChainIdRef`). — GAP
- [ ] Rapid tab switch A→B→A → only the last-selected tab paints + receives pointer events (no ghost OOPIF intercepting clicks). — GAP
- [ ] Spam Reload → single reload per tab, no stacked navigations. — GAP
- [ ] Close-all rapidly → selection falls back to a valid tab or empty (`resolveSelectedTabId`), no dangling selectedId. — PARTIAL

### Back-and-forth / Switching & Recovery
- [ ] Switch away from `/browser` and back → tab set + selection + snapshots (`tabSnapshots`) restored. — GAP
- [ ] Background/resume → live OOPIF tabs reattach, selected tab repaints. — GAP
- [ ] Reload mid-navigation → tab restores to committed URL from snapshot, not a blank. — GAP
- [ ] `locationDirty` draft in URL bar preserved across tab switch or reset on selection change (documented behavior). — GAP

### Fuzz / Adversarial
- [ ] Paste huge URL / `javascript:` / `data:` / whitespace / non-URL text into location bar → `new URL()` guard, no navigation to unsafe scheme, no crash. — GAP
- [ ] Emoji/IDN/punycode hostname → `inferBrowserWorkspaceTitle` hostname strip handles it. — GAP
- [ ] Wallet injection with malformed consent payload → `browser-wallet-consent-format` rejects, no silent approve. — COVERED (injection test)
- [ ] Rapid interleave: new tab + close + navigate + switch → invariant: exactly one selected tab, selectedId always in tabs set. — GAP

### Input Modalities
- [ ] Keyboard: Tab through tab strip (`role="tablist"`), arrow-key tab nav, Enter activates; URL bar Enter submits, Escape reverts draft. — GAP
- [ ] Right-click / context menu on a tab (if wired) → close/duplicate. — GAP
- [ ] Drag-to-reorder tabs (if wired). — GAP
- [ ] Touch: tab tap ≥44px, close button ≥44px, swipe in sidebar. — GAP

### A11y / Geometry
- [ ] Tabs expose `role="tab"` + aria-selected; close buttons have `aria-label`/`title` (`closeTabLabel {label}`). — PARTIAL (present in source; not asserted)
- [ ] Focus trapped in wallet-consent modal; visible focus ring. — GAP
- [ ] axe pass with tabs + URL bar + a loaded page chrome. — GAP
- [ ] Hover on tab/close/new = neutral-opacity; primary actions orange→darker-orange; no blue. — GAP

### Concurrency / Races
- [ ] Navigate one tab while another is loading → independent OOPIFs, no cross-tab state bleed. — GAP
- [ ] Close the active tab while it is loading → selection moves, in-flight nav cancelled/detached (no orphan OOPIF painting over new selection). — GAP
- [ ] Snapshot write (`setTabSnapshots`) during a rapid tab switch → no stale snapshot painted on the wrong tab. — GAP
- [ ] Wallet consent prompt arriving during a tab switch → bound to the correct originating tab. — GAP

---

## Coverage summary

| View | Existing test path(s) | Biggest gap |
| --- | --- | --- |
| Camera | `packages/ui/src/components/pages/CameraPageView.test.tsx` (6 unit tests: mount/capture/switch/unmount/denied/error); generic `builtin-views-visual` / `all-views-interaction` / `all-pages-clicksafe` walks | No rapid-fire/busy-guard, non-fatal live-error toast, cancelled-mount race, or a11y/axe/keyboard tests; retry-click path undriven |
| Phone (`PhonePageView`) | `ElizaOsAppsView.permission-gate.test.ts` (`ensureNativeReadGranted` decision table, unit-only) | Entire component surface untested — dialpad, placeCall/openDialer, contacts panel, vCard import, roles, transcripts; deterministic e2e targets a DIFFERENT `/apps/phone` `phone-shell`, not this `/phone` elizaos-apps surface |
| Messages (`MessagesPageView`) | `ElizaOsAppsView.permission-gate.test.ts` (unit gate only) | No component test for send/validation/refresh, deep-link seeding, or the incoming-SMS auto-forward+dedupe webhook flow |
| Contacts (`ContactsPageView`) | `ElizaOsAppsView.permission-gate.test.ts` (unit gate only) | No component test for create/validation/search/refresh; `/contacts` tab route only nav-walked |
| Stream | none dedicated — only `{id:"stream"}` nav entries in `builtin-views-visual.spec.ts` / `all-views-interaction.spec.ts` (navigate+screenshot) | Zero behavioral coverage: go-live/offline toggle, `loadingRef` rapid-fire guard, 404→unavailable vs error split, popout-once, visibility-pause polling all untested |
| Browser (`BrowserWorkspaceView`) | `browser-workspace.spec.ts` (1: create+switch tabs), `browser-skills-agent-bridge.spec.ts` (2), `browser-workspace-wallet.test.ts` (6), `browser-workspace-wallet-injection.test.ts` (3) | URL-bar navigation + back/forward/reload untested; rapid tab open/close/switch OOPIF paint & pointer-event races and selectedId invariant uncovered; no a11y/keyboard/axe |

**Single biggest gap across the group:** the `/phone`, `/messages`, `/contacts` ElizaOsAppsView surfaces have **no component/e2e behavioral coverage at all** — only the `ensureNativeReadGranted` unit decision-table. The one deterministic comms e2e (`apps-comms-device-interactions.spec.ts`) exercises a *different* native `/apps/phone|messages|contacts` `*-shell` surface, so every real control (dialpad, place-call, SMS send/validation, incoming-SMS auto-forward+dedupe, contact create/import) on the tab-routed surface is completely untested, including the permission-denied component behavior these views were specifically hardened for in #10196.
