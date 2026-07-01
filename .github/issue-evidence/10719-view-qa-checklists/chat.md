# Chat Surfaces — QA Checklist

Scope: ContinuousChatOverlay (pill/input/half/full detents), ChatSurface, AssistantOverlay, composer, message list + streaming/thinking, message actions (copy/edit/regenerate/delete), attachments, voice pill / mic, slash commands, new-chat/clear, conversation swipe, useShellController + useChatSend.

Coverage legend: `[unit]` co-located `*.test.tsx` · `[fuzz]` `*.fuzz.test.tsx` · `[slash]` `*.slash.test.tsx` · `[e2e-ui]` `packages/ui/src/**/__e2e__` · `[e2e-app]` `packages/app/test/ui-smoke/*.spec.ts` · **GAP** = no committed test found.

---

## ContinuousChatOverlay (the ambient chat — `/chat` + floats over every view)

### Entry / Nav
- [ ] Fresh reload on `/chat` (TAB_PATHS chat) renders overlay resting at `input` detent, composer focusable — [e2e-app] chat-overlay-controls-interactions.spec.ts
- [ ] Overlay is present (pointer-events-none container) over every other TAB route, not just `/chat`; controls behind stay live — [unit] "keeps the ambient layer non-blocking"
- [ ] `CHAT_PREFILL_EVENT` ("show me X" from a view/widget) prefills + focuses composer without auto-sending — [unit] "prefills and focuses the composer from the shared chat prefill event"
- [ ] `TUTORIAL_CHAT_CONTROL_EVENT` start/stop drives the overlay from the tutorial flow — GAP (event wired, no committed test on overlay side)
- [ ] Back/nav away mid-open then return: `data-conversation-id` / detent restore correctly — partial [unit] swipe/nav; **GAP** for background→resume restore
- [ ] Deep-link that opens Settings from the `no_provider` gate lands on `/settings` ai-model section — [unit] "renders the no_provider failure as a recovery gate"

### Detents / open-close state machine (pill → input → half → full → maximized)
- [ ] Pull-up drag on grabber opens sheet input→half→full stepwise; pull-down reverses — [unit] "steps COLLAPSED→HALF→FULL"
- [ ] Fast flick up/down crosses detents by velocity even below distance threshold — [unit] "opens on a fast flick even below the distance threshold"
- [ ] Free-drag release rests at finger position unless within `SHEET_DETENT_MAGNET` (64px) of a detent — [unit] slow-drift tests
- [ ] `data-detent` label always matches rendered height (pill/collapsed/half/full) — [unit] detent tests + [fuzz] invariants
- [ ] Maximize toggle drops inset to full-bleed at FULL only; leaving FULL resets `maximized` — [unit] "renders only the Launcher"; [fuzz] "double-clicking the maximize toggle returns to the inset full detent"
- [ ] One pill tap opens to half on the very next tap (no blink-back, no double-open) — [fuzz] "ONE tap on the pill opens the chat to half"
- [ ] Focus composer auto-opens sheet (type-to-open); pill-open focus only raises keyboard (suppressExpandOnFocus) — [unit] "opens the sheet when the composer input is focused"
- [ ] Escape closes sheet; Escape while collapsed is a no-op — [unit] "closes the sheet on Escape"; [fuzz] "Escape while collapsed does not open or break"
- [ ] Backdrop click collapses when keyboard down; first tap with keyboard up only drops keyboard (2-tap-to-close) — [fuzz] scrim-tap tests
- [ ] Collapsed→pill via slow downward drag past pill threshold; pill handle then inert to input taps — [unit] "pulls DOWN from the input to collapse into a recoverable pill" + "keeps the collapsed pill handle non-interactive"
- [ ] Grabber + pill bars are anti-phase (never both visible — the #9142 "two pills" bug); bars paint at full opacity off-iOS — [unit] "paints a visible grabber bar off-iOS"

### Composer / send
- [ ] Empty draft shows mic (no send button); typing swaps mic→send in place (no remount pop) — [unit] "shows the mic and no send button" / "swaps mic → send"
- [ ] Enter sends + clears input; Shift+Enter inserts newline; textarea auto-grows to max-h — [unit] "submits the draft on Enter" / "composes multi-line"
- [ ] Send disabled + no-op when `canSend` false (agent stopped) — [unit] "shows a disabled, no-op send control"
- [ ] Sending opens sheet to HALF (not full takeover) — [unit] "opens to HALF when sending"
- [ ] Waking/booting placeholder shows "Ask X — waking up…", typing still allowed, `aria-describedby` hint present — [unit] "shows a waking-up placeholder while booting"
- [ ] onPointerDown preventDefault keeps textarea focus on send tap (keyboard stays up for next message) — behavior in code; **GAP** explicit test
- [ ] Double/triple-click send with same draft sends exactly once, clears, no dup rows — [fuzz] random-walk covers; **GAP** dedicated dup-send assertion
- [ ] Mash send while `responding` fires "send another" (queued) not dropped — [unit] "reverts the trailing control to send"; **GAP** dup-request assertion under mash

### Streaming / thinking / status
- [ ] In-flight assistant bubble shows dots-only inside bubble; standalone status row shows phase label — [unit] "shows dots-only status inside the empty in-flight assistant bubble"
- [ ] Phase labels humanize action/tool names (running_action → "Running send message") — [unit] "humanizes the action name"
- [ ] Status label min-dwell (320ms) prevents strobe on fast thinking→action→streaming — [unit] "holds the first label through a fast phase change"
- [ ] Reasoning/ThinkingBlock hidden while streaming, revealed once settled — [unit] "hides reasoning disclosure while streaming" / "shows reasoning disclosure after settled"
- [ ] Stop control appears while streaming with empty draft; wired to `stop()`; aborts by latest room id — [unit] "shows a stop control while a reply streams"; [unit] useChatSend "aborts the backend turn using the latest conversation room id"
- [ ] `speaking` phase is the ONLY orange status; all others neutral white; no blue — [unit] status tests (assert color class)
- [ ] Scroll follows latest line on new message while open; stays put when user scrolled up — [unit] "scrolls to the latest line"; **GAP** user-scroll-lock assertion

### Attachments
- [ ] Attach (+) opens native picker; disabled at MAX_CHAT_IMAGES — [unit] "shows the attach (+) control"; [e2e-app] chat-overlay-controls-interactions
- [ ] Attaching image renders pending thumbnail, enables image-only send, ships in stream body — [unit] "attaches an image and enables an image-only send"; [e2e-app] chat-attachment.spec.ts
- [ ] Remove-image (×) button drops the tile; 44px hit zone via before-overlay — [unit] partial; **GAP** remove-button click test
- [ ] Paste image/file attaches; large text paste → `pasted-text.md` attachment chip — [e2e-app] chat-large-paste.spec.ts
- [ ] Non-image (audio/video/pdf/text) tiles render correct icon + truncated name — **GAP**
- [ ] `imageError` renders `role=alert` on rejected/oversized file — **GAP**

### Voice / mic
- [ ] Tap mic toggles hands-free conversation; active state styles the button — [unit] "toggles hands-free conversation when the mic is tapped"
- [ ] Push-to-talk: hold arms pending→holding, release sends; a quick tap (< hold) does not start capture — [fuzz]/[unit] ptt tests
- [ ] Long-press does NOT enter PTT while transcribing — [unit] "does not enter push-to-talk on a long press while transcribing"
- [ ] Live interim transcript renders above composer while recording (aria-live) — [unit] "renders the live interim transcript while recording"
- [ ] Finished transcript drops into composer as attachment, not auto-sent — [unit] "drops the finished transcript into the composer as an attachment"
- [ ] Transcribing badge shows in header; "exit transcription mode" phrase; audio-unlock button (autoplay-blocked) fires `unlockAudio` — [unit] transcribe/unlock states; **GAP** unlock-button click assertion
- [ ] Mic → stop-generating swap while responding+empty draft — [unit] stop tests

### Message copy / actions (overlay path)
- [ ] Press-and-hold assistant bubble copies text + flashes "Copied" + haptic; finger travel cancels — [unit] "press-and-hold copies an assistant message"
- [ ] Quick tap (released before hold threshold) does NOT copy — [unit] "a quick tap ... does NOT copy"
- [ ] Message text stays selectable for native highlight/copy — [unit] "keeps chat message text selectable"
- [ ] Header copy-conversation button copies full transcript, flashes Check — [unit] handleCopyConversation path; **GAP** header-copy click test
- [ ] Sent `/command` renders bold token in transcript; assistant leading-slash NOT bolded — [slash] "renders a sent slash command bold" / "does not bold a leading slash in an assistant turn"
- [ ] Overlay has no edit/regenerate/delete per-message row (that lives in desktop `chat-message`) — N/A for overlay

### Clear / new-chat / swipe
- [ ] Header clear (RotateCcw) resets to fresh greeted thread (resets, not deletes) — [unit] chat-full-clear; [e2e-app] chat-clear-swipe.spec.ts
- [ ] Clearing an empty draft replaces conversation instead of piling orphan rows — [e2e-app] "clearing an empty draft replaces it instead of piling up orphan conversations"
- [ ] Clear lands on greeted chat with no undo toast; backfills greeting without frozen spinner — [e2e-app] "clearing activates a fast, greeting-less conversation and backfills"
- [ ] Left swipe → next(older) conversation; right swipe → previous(newer); edge hint lights with drag — [unit] swipe tests
- [ ] Axis-lock: mostly-vertical drag does NOT switch conversations (scroll wins) — [unit] "does NOT switch conversations on a mostly-vertical drag"
- [ ] Swipe not bound while sheet collapsed; collapsed grabber horizontal swipe routes to launcher rail — [unit] "does not bind the swipe gesture while collapsed"; [e2e-app] chat-clear-swipe
- [ ] Swipe while thread loading/empty navigates without crash, shows spinner not broken box — [unit] "still navigates (no crash) when swiping while loading"

### State matrix
- [ ] Empty thread (fresh) — greeting only, no chrome — [unit] empty-thread tests
- [ ] Loading (swipe past prefetch / cleared) — centered spinner `chat-thread-loading` — [unit] "keeps the thread mounted ... shows the loading spinner"
- [ ] Populated long thread scrolls inside log, latest at bottom — [e2e-app] chat-overlay-controls-interactions "long transcript scrolls"
- [ ] Error/failed send — notice surfaced, user message kept, resend possible — [unit] useChatSend "surfaces a notice + keeps the user message on a transient send failure"
- [ ] Auth-failure send — notifies, does NOT reload/re-fail — [unit] useChatSend "does not reload ... on an auth-failure"
- [ ] no_provider — recovery gate + Settings jump (not raw error) — [unit] no_provider test
- [ ] Local-model downloading/loading — `overlay-model-download-status` strip, send NOT gated — [unit] modelStatus render; **GAP** send-not-gated assertion during download
- [ ] Zero vs many items — visibleMessages windowing filters whitespace-only turns — [unit] "filters whitespace-only messages"

### Repeated / rapid-fire · races (invariants)
- [ ] Hammer grabber tap 40× ends valid — [fuzz]
- [ ] Pill flick-up + grabber flick-down 30× never sticks — [fuzz]
- [ ] Escape spam 25× while toggling never throws/sticks-open — [fuzz]
- [ ] Focus/blur storm 50× leaves composer reachable — [fuzz]
- [ ] pointerUp with no prior pointerDown = no-op; double pointerDown + single pointerUp doesn't double-fire — [fuzz]
- [ ] pointerCancel / lostPointerCapture mid-drag settles cleanly (rotation) — [fuzz]
- [ ] Interleaved pointer ids + random-target pointer flood never corrupts state — [fuzz]
- [ ] 60-step seeded random walk holds all invariants — [fuzz] "survives a 60-step random walk"
- [ ] Reaches every named ChatState and each satisfies invariants — [fuzz] "reaches every named state"
- [ ] Nav while a send is in-flight cancels/aborts by room id (no orphan stream) — [unit] useChatSend abort tests
- [ ] Send during agent handoff window queues + delivers to dedicated agent, not shared — [unit] useChatSend handoff-queue tests

### Fuzz / adversarial
- [ ] Huge paste, emoji/RTL/IME, whitespace-only draft — Enter with whitespace-only never sends — [fuzz] "Enter with an empty draft never sends"; **GAP** RTL/IME-specific
- [ ] Typing while pilled (synthetic, bypasses inert) never lands broken — [fuzz]
- [ ] `overflow-wrap:anywhere` breaks long URLs/hashes so bubble can't blow out width — code; **GAP** visual assertion

### Input modalities / A11y / geometry
- [ ] SoftButtons are 44×44 (h-11 w-11) hit targets; header buttons 36px w/ generous zone — code; **GAP** tap-target audit
- [ ] Grabber keyboard-operable: Enter/Space toggle, ArrowUp open, ArrowDown/Escape close (WCAG 2.1.1) — code; **GAP** grabber-keyboard test
- [ ] Thread `role=log` aria-live polite; status `role=status` aria-live polite — [unit] status a11y
- [ ] Reduced-motion collapses animations to fade, no positional movement — [fuzz] matchMedia reduce stub; **GAP** explicit reduced-motion render assertion
- [ ] Hover states neutral→neutral-with-opacity (no orange→black, no blue) — code; **GAP** hover color audit
- [ ] Real touch: tap/long-press/swipe/pinch on mobile viewport — [e2e-ui] chat-sheet + chatux-gesture runners (drag gestures); **GAP** pinch
- [ ] axe pass after open/send/attach interaction — **GAP** (no axe in overlay unit tests)

---

## ChatSurface (`shell/ChatSurface.tsx` — the in-view glass composer surface)

- [ ] Renders greeting when no messages; branded appName interpolated — [unit] "renders the greeting when there are no messages"
- [ ] Renders user/assistant bubbles for prior messages, user right / assistant left — [unit] "renders bubbles for prior messages"
- [ ] Send disabled when input empty; enabled + fires onSend + clears on submit — [unit] disable/enable/clear tests
- [ ] Enter submits, Shift+Enter does not — [unit] "submits on Enter" / "does not submit on Shift+Enter"
- [ ] Input + send disabled when `canSend=false` — [unit] "disables the input + send when canSend=false"
- [ ] Voice toggle disabled when no handler; toggles capture + reflects `recording` active state when wired — [unit] voice-toggle tests
- [ ] VISION button hidden without `onVision`; enabled fires onVision; disabled while `visionActive` or `!canSend` — [unit] VISION tests
- [ ] Empty-assistant placeholder renders typing indicator (role=status, "X is typing") — [unit] "renders a typing indicator"
- [ ] Conversation `<ul>` is aria-live polite / aria-atomic false for streaming announcements — [unit] "marks the conversation list as a polite aria-live region"
- [ ] Auto-scroll to bottom on new message (rAF-deferred, no sync reflow) — code; **GAP** scroll assertion
- [ ] Rapid double-submit sends once, clears once — **GAP**
- [ ] Long/overflow message wraps within max-w-[80%] bubble — **GAP**
- [ ] Fuzz: whitespace-only draft blocked (trim guard) — code; **GAP** explicit test

---

## AssistantOverlay (`shell/AssistantOverlay.tsx` — focus-trapping dialog, legacy tray/summon path)

- [ ] Renders nothing for phase idle/booting; renders children for summoned/listening/responding — [unit] phase tests
- [ ] Escape while open calls onClose; Escape while idle does not — [unit] Escape tests
- [ ] Visible close (X) button fires onClose — [unit] "offers a visible close button"
- [ ] role=dialog + aria-modal=true + aria-label "{appName} assistant" when open — [unit] "exposes role=dialog and aria-modal=true"
- [ ] Escape listener removed on unmount (no leak) — [unit] "removes the Escape listener on unmount"
- [ ] Initial focus moves into dialog (first focusable or dialog itself) on open — [unit] "moves focus into the dialog"
- [ ] Focus restored to previously focused trigger (HomePill) on close/unmount — [unit] "restores focus to the previously focused element"
- [ ] Tab / Shift+Tab trap cycles within dialog only — [unit] "traps Tab inside the dialog"
- [ ] Bottom-sheet on mobile, centered drawer ≥sm; enter motion skipped under reduced-motion — code; **GAP** geometry/reduced-motion render test
- [ ] Rapid open/close (phase flip) does not double-bind listeners or strand focus — **GAP**

---

## Composer (desktop `composites/chat/chat-composer.tsx`)

- [ ] Attach-image button fires onAttachImage — [unit] chat-composer.test.tsx; **GAP** (only 3 tests)
- [ ] Mic button (`chat-composer-mic`) fires handleMicClick; voice title reflects state — **GAP**
- [ ] Send/Stop/StopSpeaking action button (`chat-composer-action`) swaps by state, correct aria-label — [unit] chat-composer.stop.test.tsx (stop path)
- [ ] Toggle-agent-voice button state round-trips — **GAP**
- [ ] Textarea placeholder default vs override; auto-grow to max-h; pointer-coarse 16px (no iOS zoom) — **GAP**
- [ ] Composer shell (`chat-composer-shell.tsx`) draft/state wiring — [unit] chat-composer-shell.test.tsx
- [ ] Disabled composer dims + blocks input when send unavailable — **GAP**
- [ ] Rapid send double-fire idempotency — **GAP**

---

## Message list + bubbles + streaming (`composites/chat/chat-transcript.tsx`, `chat-message.tsx`, `chat-bubble.tsx`, `ThinkingBlock.tsx`)

- [ ] Transcript memoization: a parent re-render (drag) does not re-render every ThreadLine — [unit] chat-transcript.memoization.test.tsx + render-count.test.tsx
- [ ] Inline widgets (task/choice/form/followups) render instead of leaking raw `[TASK:…]`/`[CHOICE]` markers — [unit] InlineWidgetText.test.tsx, MessageContent.*.test.tsx (task-widget/slash-command/sensitive-request/config/code-block)
- [ ] Streaming parser handles partial markers mid-stream — [unit] message-parser-streaming.test.ts
- [ ] Parser parity contract: overlay + desktop paths agree — [unit] parser-parity.contract.test.ts
- [ ] ThinkingBlock reasoning disclosure expand/collapse — **GAP** (no ThinkingBlock.test)
- [ ] MessageAttachments preview kind (image/pdf/text-code) derived from mime — [unit] MessageAttachments.test.tsx
- [ ] Voice-speaker inline play on assistant bubble — [unit] chat-message.voice-speaker.test.tsx
- [ ] Suggestion/followup chips render + fire — [unit] chat-message.suggestion.test.tsx
- [ ] Long code block scrolls / wraps, copy button on code — [unit] MessageContent.code-block.test.tsx
- [ ] Fuzz: malformed/adversarial marker strings don't break render — [unit] message-parser-helpers.fuzz.test.ts, message-parser-edge.test.ts

---

## Message actions row (`composites/chat/chat-message-actions.tsx`)

- [ ] Copy button fires onCopy + reflects copied state in label/aria — [unit] "invokes onCopy" / "reflects the copied state"
- [ ] Custom copy labels honored when supplied — [unit] "uses provided copy labels"
- [ ] Play button fires onPlay (assistant TTS) — **GAP**
- [ ] Edit button fires onEdit — **GAP** (component has onEdit; no test)
- [ ] Delete button fires onDelete when enabled — [unit] "invokes onDelete when enabled and clicked"
- [ ] Regenerate: NOT a per-message action — the analog is useChatSend truncate-and-resend — [unit] useChatSend "truncates from the user message (inclusive) and resends" + "falls back to in-memory resend for optimistic turn"
- [ ] Disabled action buttons are inert (no fire) — **GAP**
- [ ] 44px tap targets + focus-visible on each action — **GAP**

---

## Slash commands (`shell/SlashCommandMenu.tsx` + `chat/slash-menu.ts`)

- [ ] `/` at draft start opens listbox (`slash-command-menu`, role=listbox) — [slash] "opens the menu listing commands"
- [ ] Typed token filters commands; multiline draft does NOT open menu — [slash] filter + multiline tests
- [ ] ArrowDown/Up move active option (role=option) — [slash] "ArrowDown moves the active option"
- [ ] Tab completes command to drill into args — [slash] "Tab completes a command"
- [ ] Enter on navigate command runs nav (not send); settings section resolved from arg — [slash] navigate/settings tests
- [ ] Enter on client command runs client action; on agent command sends slash text — [slash] client/agent tests
- [ ] Natural-language navigation inert when flag off; runs client path when flag on — [slash] feature-flag tests
- [ ] Escape dismisses menu but keeps draft; typing reopens — [slash] "Escape dismisses the menu but keeps the draft"
- [ ] Clicking an option executes it — [slash] "clicking an option executes it"
- [ ] No menu rendered when no slash controller provided — [slash] "renders no menu when no slash controller"
- [ ] Loading state shows `slash-menu-loading` (role=status) while catalog loads — code; **GAP** loading-state test
- [ ] Combobox aria (role/aria-expanded/aria-activedescendant) applied only when catalog wired — code; **GAP** aria assertion
- [ ] Fuzz: `/` + huge/garbage token, rapid open/close never sticks menu open — **GAP**

---

## useShellController + useChatSend (state layer)

- [ ] Streaming endpoint used on happy path, never the non-streaming one — [unit] useChatSend "uses the streaming endpoint on the happy path"
- [ ] Stop aborts by latest room id, incl. newly-created conversation room id — [unit] abort tests
- [ ] User-aborted send surfaces NO error notice — [unit] "does NOT surface an error notice when aborted"
- [ ] Cloud-base createConversation 404 keeps user message + notifies (agent gone) — [unit] cloud-404 test
- [ ] Non-cloud base 404 preserves prior behaviour (no notify) — [unit] non-cloud-404 test
- [ ] Deleted-conversation-only 404 recreates + replays — [unit] "recreates the conversation and replays"
- [ ] Handoff freeze/queue: mid-drain re-check does not drain a snapshot-frozen message to shared — [unit] handoff tests
- [ ] Flag-off parity: sends dispatch inline when no handoff — [unit] "does not freeze when no handoff is in flight"
- [ ] clearConversation resets thread + conversationNav — [unit] shell-state.test.ts + [e2e-app] chat-clear-swipe
- [ ] conversationNav hasPrev/hasNext/goPrev/goNext bounds correct at edges — [unit] conversation-nav.test.ts
- [ ] transcriptionMode enter/exit via voice command + metadata suppresses reply gate — [unit] useShellController transcription refs; **GAP** dedicated toggle test
- [ ] visibleMessages windowing (empty-turn filter, most-recent cap, streaming exception) — [unit] shell-state.test.ts

---

## Coverage summary

| View / Surface | Existing test path(s) | Biggest gap |
| --- | --- | --- |
| ContinuousChatOverlay | ContinuousChatOverlay.test.tsx (100+), .fuzz.test.tsx (31), .slash.test.tsx (16); __e2e__ chat-sheet/chatux-gesture/chat-ambient; app chat-*.spec.ts | No axe/a11y-after-interaction, no tap-target/hover-color audit, grabber-keyboard + remove-image + header-copy clicks untested |
| ChatSurface | __tests__/ChatSurface.test.tsx (16) | Auto-scroll + rapid double-submit + overflow untested |
| AssistantOverlay | __tests__/AssistantOverlay.test.tsx (13) | Geometry (sheet vs drawer) + reduced-motion + rapid open/close untested |
| Composer (desktop) | chat-composer.test.tsx (3), .stop.test.tsx (2), chat-composer-shell.test.tsx | Mic/voice-toggle/placeholder/attach paths largely untested (only 5 cases total) |
| Message list / streaming | chat-transcript.*, MessageContent.*, message-parser-*, InlineWidgetText, MessageAttachments | ThinkingBlock has no test |
| Message actions row | chat-message-actions.test.tsx (4) | Play + **Edit** buttons have no test; disabled-inert untested |
| Slash commands | ContinuousChatOverlay.slash.test.tsx (16) | Loading state + combobox-aria + slash fuzz untested |
| useShellController / useChatSend | useChatSend.test.tsx (15), shell-state/conversation-nav/topic-grouping *.test.ts | transcriptionMode toggle has no dedicated test |

**Single biggest gap for the group:** the ContinuousChatOverlay is exceptionally well covered at the jsdom unit/fuzz level (state machine, gestures, slash, streaming) but has **almost no real-browser a11y or geometry verification** — there is no axe pass after open/send/attach, no 44px tap-target audit, no hover-color (orange→darker, no-blue) check, and reduced-motion/pinch/grabber-keyboard operability are asserted only indirectly; the `[e2e-app]` specs cover happy-path flows (send, attach, paste, clear/swipe) but not adversarial input, offline/error banners, or accessibility, so the accessibility+visual-invariant layer is the weakest link.
