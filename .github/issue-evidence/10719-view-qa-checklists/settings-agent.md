# Settings — Agent group — QA Checklist

Scope: `packages/ui/src/components/pages/SettingsView.tsx` (root nav shell) + the six **agent-group** sections — `identity` (IdentitySettingsSection), `ai-model` (ProviderSwitcher / ProviderCard / ProviderPanels / ProviderRoutingPanel), `voice` (per task: VoiceConfigView — but see coverage note: the live `/settings/voice` route actually mounts `VoiceSectionMount`→`VoiceSection`, VoiceConfigView is orphaned), `capabilities` (CapabilitiesSection), `apps` (AppsManagementSection), `connectors` (ConnectorsSection).

Route facts: settings tab route `/settings` (TAB_PATHS.settings); voice deep-link `/settings/voice` (TAB_PATHS.voice) resolves to the `settings` tab (navigation/index.ts:462). Section selection is URL-hash driven (`#<sectionId>`, `readSettingsHashSection`, `replaceSettingsHash`); legacy hashes `#cloud`/`#providers`→`ai-model` (settings-sections.ts:325); legacy `/connectors`→settings tab. Layout is two-pane when `min-width:1024px` OR `min-width:768px + landscape`; else mobile hub→single-column-with-back.

Legend: **[TEST]** committed automated coverage exists (path cited) · **[GAP]** no committed test found.

---

## Settings root nav (SettingsView)

### Entry / Nav
- [ ] `/settings` loads two-pane on desktop (≥1024px) with nav rail + first-visible section auto-selected in detail pane (`desktopSection = activeSectionDef ?? visibleSections[0]`) — **[TEST]** `packages/app/test/ui-smoke/all-views-interaction.spec.ts` (id `settings`) navigates the route
- [ ] `/settings` loads mobile hub (grouped list, no detail) at ≤767px portrait — **[TEST]** `packages/app/test/ui-smoke/settings-mobile-load.spec.ts` opens every section at 390×844
- [ ] `/settings/voice` deep-link lands on settings tab (navigation resolves to `settings`) — **[TEST]** all-views-interaction (id `voice`, path `/settings/voice`); **[GAP]** no assertion that it auto-opens the `voice` section specifically
- [ ] Fresh reload on `/settings#ai-model` restores that section active (initial `readSettingsHashSection()`) — **[GAP]**
- [ ] Reload on `/settings#<unknown-id>` falls back to hub/first-section (hashchange handler clears when `!visibleSectionIds.has`) — **[GAP]**
- [ ] Legacy hash `#cloud` and `#providers` both open `ai-model` (settings-sections.ts:325) — **[GAP]**
- [ ] From chat "open settings / show me settings" via agent-surface (`ShellViewAgentSurface viewId="settings"`; each nav item registered `section-<id>`) opens the section by id — **[GAP]**
- [ ] Widget tap / notification deep-link into a settings section restores hash + selection — **[GAP]**
- [ ] Back button (mobile `SectionBackButton`, agent id `section-back`) returns hub, clears hash to `#` via `history.replaceState` — **[GAP]**
- [ ] Browser back/forward after selecting sections walks hash history and updates active section (hashchange listener) — **[GAP]**

### Primary interactions
- [ ] Each nav row (`SettingsNavItem`) click sets active section + replaces hash; desktop rail row shows `aria-current="page"` + accent when active — **[GAP]**
- [ ] `wallet-rpc` row shows "On" chip when `walletEnabled` true, no chevron; else hidden entirely when `walletEnabled === false` (`visibleSections` filter) — **[GAP]**
- [ ] Section body renders header icon + title; a section that throws renders inline `SettingsSectionFallback` (`data-testid="settings-section-error"`) NOT a blank shell, and rail stays interactive — **[GAP]** (fallback path untested)
- [ ] Fallback "Retry" button re-mounts the section (ErrorBoundary `reset`, keyed by `section.id`) — **[GAP]**
- [ ] `loadPlugins()` fires once on mount (effect) — **[GAP]**

### State matrix
- [ ] Empty: no extra/cloud groups → only agent/system/security groups render, no empty group headers (`filter(items.length>0)`) — **[GAP]**
- [ ] Populated: cloud settings group interleaves by declared order (`listExtraSettingsGroups`) between System and Security — **[TEST]** settings-mobile-load.spec.ts "cloud settings sections" block
- [ ] Unknown-group section falls into "Other" bucket, never dropped — **[GAP]**
- [ ] Hidden-by-view-kind sections filtered out (`isViewVisible(section, enabledKinds)`) — **[GAP]**
- [ ] Android cloud build hides `hideOnCloud` sections (`isAndroidCloudBuild()`) — **[GAP]**
- [ ] Loading: sections that self-fetch show their own skeleton; nav rail never blocks — **[GAP]**

### Repeated / rapid-fire
- [ ] Rapid-click same nav row N× → single stable selection, no duplicate hash entries — **[GAP]**
- [ ] Mash Back button on mobile → hub shown once, hash `#` idempotent — **[GAP]**
- [ ] Spam-switch between two sections A→B→A→B fast → last-clicked wins, no stuck detail pane — **[GAP]**

### Back-and-forth / switching & recovery
- [ ] Select section, edit a draft, switch section, return → per-section state (unsaved drafts) behavior is defined (note: components unmount on switch → drafts in local state are LOST unless in app store) — **[GAP]**
- [ ] Background app on a section, resume → active section + hash preserved — **[GAP]**
- [ ] Resize desktop→mobile mid-view (crossing 1024px) → layout swaps, active section preserved (`activeSection` state survives) — **[GAP]**
- [ ] Orientation change on tablet (portrait↔landscape) flips two-pane vs single-column correctly (`isWideLandscape`) — **[GAP]**

### Fuzz / adversarial
- [ ] `window.location.hash = "#"+huge/emoji/injection string` → no crash, falls back cleanly — **[GAP]**
- [ ] Rapid programmatic hash changes (hashchange storm) → listener debounces to a valid section or hub, never throws — **[GAP]**
- [ ] Invariant: `activeSectionDef` is always `null` or a member of `visibleSections` (never a filtered/hidden id) — **[GAP]**

### Input modalities
- [ ] Tab order walks nav groups top-to-bottom; Enter/Space activates a nav row — **[GAP]**
- [ ] Touch tap on mobile list row (44px min via `SettingsRow`) opens section — **[GAP]**
- [ ] Rail item keyboard `aria-current` announced by SR when active — **[GAP]**

### A11y / geometry
- [ ] `<nav aria-label="Settings sections">` present; group `<h2>` labels present — **[GAP]**
- [ ] Active rail item = accent text/icon (never blue); hover neutral row = `hover:bg-surface` (neutral, not orange→black) — **[TEST-partial]** `packages/app/test/ui-smoke/settings-theme-audit.spec.ts` (per-element color audit dark+light) + `settings-spacing-audit.spec.ts`
- [ ] 44px min tap targets on mobile rows — **[GAP]**
- [ ] axe pass on hub + on an open section — **[GAP]**

### Concurrency / races
- [ ] `loadPlugins()` in flight while user selects a section → section renders, no stale plugin list flash — **[GAP]**
- [ ] hashchange fires while a section is mid-fetch → active section updates without leaking the prior fetch into the new section — **[GAP]**

---

## identity — IdentitySettingsSection

### Entry / Nav
- [ ] Reachable via `/settings#identity` (first agent-group section) — **[TEST]** settings-mobile-load.spec.ts (`identity`)
- [ ] Agent-surface "open Basics / identity" opens it (nav id `section-identity`) — **[GAP]**
- [ ] Fresh reload on `#identity` bootstraps character load once (`attemptedInitialCharacterLoadRef`) — **[GAP]**

### Primary interactions
- [ ] Name input (`identity-name`) round-trips to `characterDraft.name`; marks dirty when ≠ `characterData.name` — **[GAP]**
- [ ] Voice select (`identity-voice`) picks preset → mutates `voiceConfig.elevenlabs.voiceId` (cloud) or `voiceConfig.edge.voice` (edge), stops any preview first — **[GAP]**
- [ ] Voice options source flips on `useElevenLabs` (= `elizaCloudConnected || elizaCloudVoiceProxyAvailable`): PREMADE/ELEVENLABS groups vs EDGE groups — **[GAP]**
- [ ] Preview button (`identity-voice-preview`) plays `activeVoicePreset.previewUrl`; toggles to Stop (VolumeX, destructive variant) while playing; disabled when no preview URL or `voiceLoading` — **[GAP]**
- [ ] System-prompt textarea (`identity-system-prompt`) round-trips `characterDraft.system`; `replaceNameTokens` applied to saved value for dirty compare — **[GAP]**
- [ ] Save (`SaveFooter`) only enabled when `dirty` (characterDirty || voiceDirty); saves character then voice config; dispatches `VOICE_CONFIG_UPDATED_EVENT`; sets `savedVoiceConfig` — **[GAP]**
- [ ] After save, dirty clears and SaveFooter hides (`dirty` false → returns null) — **[GAP]**

### State matrix
- [ ] Bootstrapping: shows "Loading identity settings…" when `!characterData && !hasCharacterDraft && (loading || !attempted)` — **[GAP]**
- [ ] `client.getConfig()` throws → voiceConfig/savedVoiceConfig reset to `{}`, `voiceLoading` cleared (catch path) — **[GAP]**
- [ ] Character save failure surfaces `saveError` ("Failed to save identity settings.") in SaveFooter — **[GAP]**
- [ ] Preview URL 404/`onerror` → `voiceTesting` cleared, no stuck Stop button — **[GAP]**
- [ ] Long system prompt (10k chars) → textarea scrolls (`min-h-[14rem]`), no layout break — **[GAP]**

### Repeated / rapid-fire
- [ ] Spam Preview toggle → single Audio element at a time (prior `audioRef.pause()`), no overlapping playback — **[GAP]**
- [ ] Double-click Save while saving → `useSettingsSave` guards concurrent save (no double PUT of character + config) — **[GAP]**
- [ ] Rapid voice-preset switching cancels prior preview each time — **[GAP]**

### Back-and-forth / switching & recovery
- [ ] Edit name (dirty), switch to another section, return → draft persistence behavior defined (draft lives in app store `characterDraft` so survives; voiceConfig is LOCAL state → resets on remount) — **[GAP]**
- [ ] Leave view while preview audio playing → cleanup effect pauses + nulls `audioRef` (no orphan audio) — **[GAP]**
- [ ] Save in flight, navigate away, return → no torn state — **[GAP]**

### Fuzz / adversarial
- [ ] Paste 100k chars into system prompt → dirty compare + save don't hang — **[GAP]**
- [ ] Emoji/RTL/IME in name field → round-trips, save persists exact bytes — **[GAP]**
- [ ] Whitespace-only name → dirty vs saved compare (draft `""` vs saved) behaves; save allowed/blocked as designed — **[GAP]**
- [ ] Injection-ish system prompt (`</script>`, `{{name}}` token) → `replaceNameTokens` handled, no XSS in render — **[GAP]**

### Input modalities
- [ ] Tab: name → voice select → preview → system prompt → Save; Enter in name does not submit-and-lose focus — **[GAP]**
- [ ] Voice `Select` opens with keyboard, Escape closes, arrow keys move options — **[GAP]**
- [ ] Touch: preview icon button ≥44px (`h-11 w-11`) — **[GAP]**

### A11y / geometry
- [ ] Voice select labelled by `settings-identity-voice-label` (`aria-labelledby`) — **[GAP]**
- [ ] Preview button `aria-label` toggles preview/stop text — **[GAP]**
- [ ] Save footer color states (error=warn, success=ok, never blue) — **[GAP]**

### Concurrency / races
- [ ] getConfig() (voice load) resolving after unmount → `cancelled` guard prevents setState — **[GAP]** (guard exists, untested)
- [ ] Character load + voice load resolve out of order → both apply without clobbering each other — **[GAP]**

---

## ai-model — ProviderSwitcher (Models & Providers)

### Entry / Nav
- [ ] Reachable via `/settings#ai-model` and legacy `#cloud`/`#providers` — **[TEST]** settings-mobile-load.spec.ts (`ai-model`); legacy-hash mapping **[GAP]**
- [ ] Agent-surface provider cards addressable (`provider-<id>`, group `provider-cards`) — **[GAP]**

### Primary interactions
- [ ] Intelligence chips (Local + Cloud, `category cloud|local`) render as `ProviderCard`s; selecting one sets `visibleProviderPanelId` and reveals its panel — **[GAP]**
- [ ] `ActiveProviderSummary` row shows the currently-routing provider (entry.current) with "Active" — **[GAP]**
- [ ] Local panel "Local only" button (`local-use-local-only`) sets local-only routing (`handleSelectLocalOnly`), disabled while `routingModeSaving`; active state = filled — **[GAP]**
- [ ] Cloud panel "Use Cloud" (`cloud-use-cloud`) selects cloud routing; `cloudActive = !cloudCallsDisabled && isCloudSelected` drives filled/active label — **[GAP]**
- [ ] Cloud panel routing (`ProviderRoutingPanel`): large-model select changes `currentLargeModel` via `onModelFieldChange`, model save state (`modelSaving`/`modelSaveSuccess`) reflected — **[GAP]**
- [ ] Subscription chips group ("Code orchestrator & workflows") only shown when `subscriptionEntries.length>0`; "Use subscription" (`sub-use-<id>`) calls `handleSelectSubscription`; shows only when `cloudCallsDisabled || resolvedSelectedId !== visibleProviderPanelId` — **[GAP]**
- [ ] Subscription panel: Anthropic/OpenAI connect state (`anthropicConnected`, `anthropicCliDetected`, `openaiConnected`) + `AccountList` render; `loadSubscriptionStatus` refresh — **[GAP]**
- [ ] Advanced disclosure ("Custom providers & model overrides", `lazy`) expands to show key chips + `ApiKeyPanel` + `ProvidersList` + `RoutingMatrix` — **[GAP]**
- [ ] API-key panel "Use provider" (`apikey-use-<id>`) switches provider (`onSwitchProvider`→`handleSwitchProvider` + `resolveProviderIdForSwitch`); `ApiKeyConfig` save (`handlePluginConfigSave`) with `pluginSaving`/`pluginSaveSuccess` — **[GAP]**
- [ ] Local-only banner ("remote routing is paused") appears in subscription + api-key panels when `cloudCallsDisabled` — **[GAP]**

### State matrix
- [ ] Empty providers (`plugins=[]`) → `allAiProviders=[]`, no crash, intelligence chips still show Local/Cloud built-ins — **[GAP]**
- [ ] Provider ordering: mobile surfaces Local right after Cloud (before subscriptions); desktop keeps Local after subscriptions — **[TEST]** `packages/ui/src/components/settings/useProviderEntries.order.test.tsx`
- [ ] `elizaCloudConnected` false vs true changes cloud panel connect affordance — **[GAP]**
- [ ] Subscription status fetch failure → panel degrades, chips still render — **[GAP]**
- [ ] Model schema null (`cloudModelSchema`) → routing panel handles absent schema — **[GAP]**
- [ ] Selection failure surfaces `setActionNotice(message,"error",6000)` (`notifySelectionFailure`) — **[GAP]**

### Repeated / rapid-fire
- [ ] Mash "Use Cloud"/"Use Local only" alternately → routing settles to last choice, no duplicate mode writes (`routingModeSaving` gating) — **[GAP]**
- [ ] Rapid provider-chip selection → single visible panel, `visibleProviderPanelId` consistent — **[GAP]**
- [ ] Double-submit API key save → single write, `pluginSaving` guards — **[GAP]**

### Back-and-forth / switching & recovery
- [ ] Expand Advanced, select a key provider, leave section, return → disclosure collapses (lazy remount), selection reset to routing default — **[GAP]**
- [ ] Switch provider while a save is in flight → in-flight save not lost, UI reflects new selection — **[GAP]**
- [ ] Background/resume during routing-mode save → final state consistent with server — **[GAP]**

### Fuzz / adversarial
- [ ] Paste huge/whitespace/emoji API key into `ApiKeyConfig` → sanitized, save rejects blank — **[GAP]**
- [ ] Provider id with special chars in `resolveProviderIdForSwitch` → no injection into request — **[GAP]**
- [ ] Invariant: exactly one `entry.current` at a time; `visibleProviderPanelId` always resolves to a rendered chip or built-in sentinel (`__cloud__`/`__local__`) — **[GAP]**

### Input modalities
- [ ] Tab through chips (all mounted for agent-surface) then into active panel controls — **[GAP]**
- [ ] Keyboard select model dropdown in routing panel — **[GAP]**
- [ ] Touch: chip ≥44px (`min-h-[2.25rem]` = 36px — FLAG: below 44px tap target) — **[GAP]** (potential a11y geometry bug)

### A11y / geometry
- [ ] ProviderCard `aria-label="<label>, <Active|status>"`, `aria-current` when selected; selected=accent border/bg (never blue) — **[GAP]**
- [ ] Active/current chip uses accent, resting hover `hover:bg-surface`/`hover:bg-accent/12` (orange→darker, not orange→black) — **[GAP]**
- [ ] axe pass with Advanced expanded — **[GAP]**

### Concurrency / races
- [ ] `useProviderBootstrap` status fetch + selection change overlap → no stale `resolvedSelectedId` — **[GAP]**
- [ ] Model config save + provider switch concurrently → both persist independently — **[GAP]**

---

## voice — VoiceConfigView (⚠ live route mounts VoiceSection; see Coverage note)

### Entry / Nav
- [ ] `/settings/voice` deep-link + `/settings#voice` reach the voice section — **[TEST]** all-views-interaction.spec.ts (`voice`) + settings-mobile-load.spec.ts (`voice`) — but these exercise `VoiceSectionMount`/`VoiceSection`, NOT VoiceConfigView
- [ ] Agent-surface groups addressable: `voice-tts`, `voice-asr`, `voice-wakeword`, `voice-talkmode` — **[GAP]**
- [ ] Fresh reload loads config once (`client.getConfig()` → `messages.tts` + `messages.swabble`) — **[GAP]**

### Primary interactions
- [ ] TTS provider buttons (`voice-tts-provider-<id>`, VOICE_PROVIDERS) select provider → `handleProviderChange`, marks dirty; active=filled — **[GAP]**
- [ ] "Configured/Needs setup" footer badge derives from provider+mode+key (`isConfigured`) — edge/robot-voice always configured (no key) — **[GAP]**
- [ ] ElevenLabs: API-source toggle (`CloudSourceModeToggle`) flips `cloud` vs `own-key`; cloud shows `CloudConnectionStatus`, own-key shows API-key input (`voice-tts-elevenlabs-key`, type=password) — **[GAP]**
- [ ] API key round-trips to `voiceConfig.elevenlabs.apiKey`, dirty set; placeholder differs when key already set ("leave blank") — **[GAP]**
- [ ] Premade voice buttons (`voice-tts-voice-<voiceId>`) select `elevenlabs.voiceId`, active state — **[GAP]**
- [ ] Test-voice button plays `selectedPreset.previewUrl`; shows "Playing"/Stop; Stop pauses `audioRef` — **[GAP]**
- [ ] Edge/robot-voice provider shows explanatory copy, no key UI — **[GAP]**
- [ ] Advanced toggle reveals ASR section (`AsrAdvancedSection`): ASR provider buttons (`voice-asr-provider-<id>`, ASR_PROVIDERS) set `voiceConfig.asr.provider`; local-inference shows "downloading" when hub has active downloads; openai shows "uses your OpenAI key" hint — **[GAP]**
- [ ] Wake word (`WakeWordSection`): enable Switch (`voice-wakeword-enable`) start/stop swabble; trigger chips add via input Enter/comma (`voice-wakeword-add-trigger`), remove chip (`voice-wakeword-remove-<t>`, min 1 trigger enforced); post-trigger-gap slider (`voice-wakeword-post-trigger-gap`, 0.1–2.0); model-size buttons (`voice-wakeword-model-<id>`); mic meter animates via `scaleX` — **[GAP]**
- [ ] Wake trigger auto-tracks character rename only when trigger is still name-derived default (issue #9880) — **[GAP]** (logic present, untested here)
- [ ] Desktop Talk Mode panel (`DesktopTalkModePanel`): desktop-only (else "desktop only" card); Refresh, Start/Stop, Speak phrase, Stop-speaking bridge calls; state/enabled/speaking readout — **[TEST-partial]** `packages/app/test/ui-smoke/voice-desktop-selftest.spec.ts`
- [ ] Save (`SaveFooter`) persists `messages.tts` (+swabble) via `updateConfig`, dispatches `VOICE_CONFIG_UPDATED_EVENT`, clears dirty — **[GAP]**

### State matrix
- [ ] Loading: "LoadingVoiceConfig" placeholder before first config resolves — **[GAP]**
- [ ] getConfig() throws → silently ignored, defaults used (empty `voiceConfig`) — **[GAP]**
- [ ] Non-desktop runtime → Talk Mode shows desktop-only card, no bridge calls — **[GAP]**
- [ ] Swabble plugin unavailable on platform → wake-word section still renders, toggles no-op silently — **[GAP]**
- [ ] Cloud voice unavailable + no key → own-key forced, "Needs setup" badge — **[GAP]**

### Repeated / rapid-fire
- [ ] Spam Test-voice → single audio (prior paused), no overlap — **[GAP]**
- [ ] Mash wake-word enable/disable → single listener, `enabled` reflects final swabble state — **[GAP]**
- [ ] Add duplicate trigger → deduped (`triggers.includes(val)` guard) — **[GAP]**
- [ ] Remove last trigger blocked (`triggers.length<=1` guard) — **[GAP]**
- [ ] Double-save → `useSettingsSave` single write — **[GAP]**

### Back-and-forth / switching & recovery
- [ ] Edit key (dirty), switch section, return → local `voiceConfig` resets (not persisted until save) — draft LOSS is expected; verify no partial persist — **[GAP]**
- [ ] Leave view while test-voice / talk-mode speaking → cleanup effect pauses audio, no orphan — **[GAP]**
- [ ] Talk-mode Start then navigate away → bridge state (running) persists in native, panel re-reads on return via `refresh()` — **[GAP]**

### Fuzz / adversarial
- [ ] Paste huge/emoji/RTL wake trigger → lowercased, commas stripped (`replace(/,/g,"")`), added once — **[GAP]**
- [ ] Slider fuzz: drag to NaN/out-of-range via agent `onFill` → clamped 0.1–2.0 (`Math.min(2,Math.max(0.1,n))`) — **[GAP]**
- [ ] Whitespace-only test phrase → Speak disabled (`!phrase.trim()`) — **[GAP]**
- [ ] Injection string as API key → `sanitizeApiKey` on save, blank deleted not persisted — **[GAP]**

### Input modalities
- [ ] Enter or comma in trigger input adds chip + clears input — **[GAP]** (keydown handler present)
- [ ] Range slider keyboard arrows adjust gap; announced value `.toFixed(2)s` — **[GAP]**
- [ ] Touch: provider/voice/model buttons ≥44px (`min-h-14`/`min-h-12`) — **[GAP]**

### A11y / geometry
- [ ] Wake-word Switch `aria-label` toggles enable/disable; range `aria-label` present — **[GAP]**
- [ ] Configured/needs-setup badge color = ok/warn (never blue) — **[GAP]**
- [ ] Talk-mode error=danger, success=ok banners — **[GAP]**
- [ ] axe pass with Advanced + wake-word expanded — **[GAP]**

### Concurrency / races
- [ ] Config load resolving after unmount → no setState (loading toggled in async IIFE without cancel guard — FLAG: `setLoading(false)` runs post-unmount) — **[GAP]** (potential unmount-setState warning)
- [ ] swabble `getConfig` + `isListening` Promise.all + audioLevel listener overlap → meter writes to detached DOM guarded by `meterRef.current` — **[GAP]**
- [ ] Save reads fresh `getConfig()` then merges — concurrent external config write could be clobbered — **[GAP]**

---

## capabilities — CapabilitiesSection

### Entry / Nav
- [ ] Reachable via `/settings#capabilities` — **[TEST]** settings-mobile-load.spec.ts (`capabilities`)
- [ ] Agent-surface toggles addressable (`capability-wallet`, `capability-browser`, `capability-computer-use`, `capability-auto-training`, `capability-proactive-suggestions`) group `capabilities` — **[GAP]**

### Primary interactions
- [ ] Wallet switch (`capability-wallet`) → `setState("walletEnabled",…)`; toggling off hides `wallet-rpc` settings section — **[GAP]**
- [ ] Browser switch (`capability-browser`) → `setState("browserEnabled",…)` — **[GAP]**
- [ ] Computer-use switch (`capability-computer-use`) → `setState`; when on shows permissions-required hint — **[GAP]**
- [ ] Auto-training switch (`capability-auto-training`) POSTs `/api/training/auto/config` with `{autoTrain}`; disabled when loading/saving/unavailable; status icon shows loading/unavailable(AlertTriangle) — **[GAP]**
- [ ] Proactive-suggestions segmented (`off`/`subtle`/`chatty`) persists via `updateConfig({env:{ELIZA_PROACTIVE_INTERACTIONS}})`; reverts on failure — **[TEST]** `packages/ui/src/components/settings/CapabilitiesSection.test.tsx` (reflects persisted value; defaults subtle + persists)
- [ ] Advanced toggle reveals Capability Router form; mode tabs Endpoint/Cloud (`cap-mode-endpoint`/`cap-mode-cloud`, role=tab) switch fields — **[GAP]**
- [ ] Endpoint mode: provider select (direct/e2b/home-machine/mobile-companion/desktop-companion), URL/ID/token/modules inputs; Connect POSTs `/api/capability-router/connect` with endpoint payload — **[GAP]**
- [ ] Cloud mode: apiBase/token/name/bio inputs; Connect POSTs cloud payload; validation errors for missing URL/base/token/name shown via `role="alert"` — **[GAP]**
- [ ] Connect success footer (`role="status"`) shows registered modules or baseUrl — **[GAP]**

### State matrix
- [ ] Auto-training config fetch fails → `autoTrainingAvailable=false`, switch disabled + AlertTriangle — **[GAP]**
- [ ] Auto-training loading → spinner status, switch disabled — **[GAP]**
- [ ] Proactive config fetch fails → keeps `subtle` default (catch swallows) — **[GAP]**
- [ ] Advanced off → router form not rendered (`advancedEnabled` gate) — **[GAP]**
- [ ] Connect endpoint with empty URL → "Endpoint URL is required." (no request sent) — **[GAP]**

### Repeated / rapid-fire
- [ ] Spam wallet/browser/computer-use switches → each is `setState` (idempotent local), final = last — **[GAP]**
- [ ] Rapid proactive segment changes → each awaits `updateConfig`; `proactiveSaving` disables during write; no dup writes for same value (`value===previous` early return) — **[GAP]**
- [ ] Double-submit Connect → `capabilityConnectLoading` disables submit, single POST — **[GAP]**
- [ ] Toggle auto-training on/off fast → optimistic set then server response reconciles; failure reverts to prior config — **[GAP]**

### Back-and-forth / switching & recovery
- [ ] Fill router form, switch section, return → advanced state + form fields reset (local state, remount) — **[GAP]**
- [ ] Connect in flight, navigate away → no setState-after-unmount crash (no cancel guard on connect — FLAG) — **[GAP]**
- [ ] Switch Endpoint↔Cloud mid-typing → per-mode fields retained in their own state (not shared) — **[GAP]**

### Fuzz / adversarial
- [ ] Modules field `"a, , b, a"` → deduped + trimmed + empties filtered (`new Set(...filter(Boolean))`) — **[GAP]**
- [ ] Bio multiline → split on `\n`, trimmed, empties filtered — **[GAP]**
- [ ] Injection/huge URL in endpoint → server-validated; client sends as-is (no client math) — **[GAP]**
- [ ] Invariant: proactive value always ∈ {off,subtle,chatty} (`PROACTIVE_CHATTINESS_VALUES` guard on change) — **[TEST-partial]** CapabilitiesSection.test.tsx

### Input modalities
- [ ] Mode tabs keyboard-selectable (`role=tab`, `aria-pressed`) — **[GAP]**
- [ ] Segmented control keyboard/touch selects a level — **[GAP]**
- [ ] Password fields (token) masked; Tab order through form — **[GAP]**

### A11y / geometry
- [ ] Switch rows have `agentLabel` aria; status icons have `role=status`/`role=img` + label — **[GAP]**
- [ ] Connect error=warn text, success=ok text (never blue) — **[GAP]**
- [ ] Connect button ≥44px (`h-11 w-full`); spinner during load — **[GAP]**

### Concurrency / races
- [ ] Auto-training config+status Promise.all resolve → both applied; a POST-in-flight toggle overlapping the initial fetch reconciles to server config — **[GAP]**
- [ ] Proactive change while a prior change is saving → `proactiveSaving` disables control, preventing overlap — **[GAP]**

---

## apps — AppsManagementSection

### Entry / Nav
- [ ] Reachable via `/settings#apps` — **[TEST]** settings-mobile-load.spec.ts (`apps`)
- [ ] Agent-surface addressable: `apps-create-toggle`, `apps-load-toggle`, `apps-verify-on-relaunch`, `apps-create-intent/submit/cancel`, `apps-load-directory/submit/cancel`, per-row `apps-launch/relaunch/edit/stop-<name>` — **[GAP]**

### Primary interactions
- [ ] On mount `refresh()` calls `listInstalledApps()` + `listAppRuns()`; populates table + runs count — **[GAP]**
- [ ] "Create new app" toggle (`apps-create-toggle`) opens create form, closes Load; "Load from directory" (`apps-load-toggle`) opens load, closes Create (mutually exclusive) — **[GAP]**
- [ ] Create form: intent textarea (`apps-create-intent`) required (submit disabled when empty/trimmed); Advanced shows "based on existing app" select (`__scratch__` sentinel maps to ""); submit POSTs `/api/apps/create`; success clears form, closes, notices, refreshes — **[GAP]**
- [ ] Load form: directory input required; submit POSTs `/api/apps/load-from-directory`; success message "Loaded N app(s)" (singular/plural), refreshes — **[GAP]**
- [ ] Verify-on-relaunch checkbox (Advanced only) toggles `verifyOnRelaunch`, sent in relaunch payload — **[GAP]**
- [ ] Row Launch (`apps-launch-<name>`) → `launchApp(name)`, success notice, refresh; sets `busyApp` (disables row buttons) — **[GAP]**
- [ ] Row Relaunch → POST `/api/apps/relaunch` with `{name,verify}`; notice from `response.message`, error tone if `ok===false` — **[GAP]**
- [ ] Row Edit → POST `/api/apps/create` `{intent:"edit",editTarget}`; info notice — **[GAP]**
- [ ] Row Stop (only when running) → `stopApp(name)`; danger-styled button — **[GAP]**
- [ ] Runs badge shows `N run(s)` (ok chip) when `runsByName.get(name).length>0`, else `—` — **[GAP]**

### State matrix
- [ ] Loading: spinner "Loading apps…" (`listStatus.loading`) — **[GAP]**
- [ ] Error: `listStatus.error` shows warn message (fetch failure) — **[GAP]**
- [ ] Empty: "No apps installed yet." when `installed.length===0` — **[GAP]**
- [ ] Populated: table with name/id/version/runs/actions; `data-testid="apps-mgmt-row-<name>"` — **[GAP]**
- [ ] Version missing → shows `—` — **[GAP]**
- [ ] Create failure → `createStatus.error` footer warn, form stays open — **[GAP]**
- [ ] Many apps (50+) → table scrolls horizontally (`overflow-x-auto`, `min-w-[34rem]`) — **[GAP]**

### Repeated / rapid-fire
- [ ] Mash Create/Load toggles → mutually exclusive, no both-open state — **[GAP]**
- [ ] Double-submit Create → single POST (submit disabled while `isCreating`) — **[GAP]**
- [ ] Spam Launch on one row → `busyApp` gates all its buttons, single launch — **[GAP]**
- [ ] Launch app A then app B rapidly → `busyApp` is a single string so A's spinner clears when B starts; verify no cross-row stuck disabled state — **[GAP]** (design edge: single busyApp)

### Back-and-forth / switching & recovery
- [ ] Open create form, type intent, switch section, return → form + draft reset (local state remount) — **[GAP]**
- [ ] Create in flight, unmount → `mountedRef` guard prevents setState (guard present) — **[GAP]**
- [ ] Launch in flight, unmount → `mountedRef` guard on `setBusyApp(null)` — **[GAP]**

### Fuzz / adversarial
- [ ] Paste huge/emoji intent → posts as-is, textarea resizes (`resize-y`) — **[GAP]**
- [ ] Directory path with spaces/`../`/injection → sent as JSON, server validates — **[GAP]**
- [ ] Whitespace-only intent/directory → submit blocked (`.trim()` guards) — **[GAP]**
- [ ] Invariant: only one of create/load form open at a time — **[GAP]**

### Input modalities
- [ ] Enter in intent textarea inserts newline (not submit); explicit Create button submits — **[GAP]**
- [ ] Tab order: toggles → form fields → submit/cancel → table row actions — **[GAP]**
- [ ] Touch: row action icon buttons `h-7` (28px — FLAG: below 44px tap target) — **[GAP]** (a11y geometry)

### A11y / geometry
- [ ] Row action buttons have `aria-label`/`title` (Launch/Relaunch/Edit/Stop `<name>`) — **[GAP]**
- [ ] Checkbox has `aria-label`; `aria-current` when checked — **[GAP]**
- [ ] Stop button danger color; running badge ok color (never blue) — **[GAP]**
- [ ] axe pass with create form open — **[GAP]**

### Concurrency / races
- [ ] Refresh (list+runs) resolving after a launch's own refresh → latest wins, `mountedRef` guards — **[GAP]**
- [ ] Create success refresh overlapping a manual relaunch → table reconciles — **[GAP]**

---

## connectors — ConnectorsSection

### Entry / Nav
- [ ] Reachable via `/settings#connectors` and legacy `/connectors`→settings — **[TEST]** settings-mobile-load.spec.ts (`connectors`); legacy redirect **[GAP]**
- [ ] `FOCUS_CONNECTOR_EVENT` / pending-focus (chat "set up Discord") opens + scrolls + focuses that connector's `<details>` (`data-connector=<id>`) — **[GAP]**
- [ ] Agent-surface toggles addressable (`connector-<id>-enable`, group `connectors`) — **[GAP]**

### Primary interactions
- [ ] Connector list = plugins filtered `category==="connector" && !ALWAYS_ON && visible!==false` — **[GAP]**
- [ ] Enable Switch (`connector-<id>-enable`) → `handlePluginToggle(id,enabled)`; busy disables switch; `stopPropagation` so toggle doesn't open `<details>` — **[GAP]**
- [ ] Status dot: off=muted (disabled), warn (validationErrors>0 or !configured), ok (enabled+configured) — **[GAP]**
- [ ] Expanding `<details>` reveals `ConnectorBody`: mode selector (only if `modes.length>1`), then env-config form OR dedicated setup panel OR "uses its own setup surface" — **[GAP]**
- [ ] Config form shown ONLY for `local-config` mode with parameters + setup targets plugin (`shouldRenderConnectorConfigForm`) — **[TEST]** `packages/ui/src/components/settings/ConnectorsSection.routing.test.ts` (4 routing cases incl iMessage→BlueBubbles regression)
- [ ] Telegram uses `TelegramPluginConfig`; others use `PluginConfigForm` — **[GAP]**
- [ ] Save settings button POSTs via `handlePluginConfigSave(id, pendingConfig)`; disabled when `!hasPendingConfig || isSaving`; shows Saving.../Saved states — **[GAP]**
- [ ] Discord shows app-ID-optional hint — **[GAP]**

### State matrix
- [ ] Empty: "No connectors available." when `connectorPlugins.length===0` — **[GAP]**
- [ ] Icon fallback: brand SVG → plugin image → Puzzle (no raw emoji) — **[TEST]** `packages/ui/src/components/settings/ConnectorsSection.test.tsx` ("falls back to icon components instead of raw emoji")
- [ ] Disabled connector (off) → warn/muted dot, still expandable — **[GAP]**
- [ ] Connector with validationErrors → warn dot even when enabled — **[GAP]**
- [ ] Save failure → error surfaces (via `handlePluginConfigSave` store), pending config retained — **[GAP]**
- [ ] Many connectors (20+) → list scrolls, all `<details>` collapsed by default — **[GAP]**

### Repeated / rapid-fire
- [ ] Spam enable Switch → `togglingPlugins` Set gates re-toggle (busy), single toggle request per settle — **[GAP]**
- [ ] Rapid expand/collapse `<details>` → body mounts/unmounts cleanly, no leaked listeners — **[GAP]**
- [ ] Double-click Save → disabled while `isSaving`, single write — **[GAP]**
- [ ] Toggle two connectors simultaneously → independent `togglingPlugins` entries, both complete — **[GAP]**

### Back-and-forth / switching & recovery
- [ ] Type partial credentials, collapse `<details>`, re-expand → `pluginConfigs` is section-level state so PENDING survives collapse (verify) but resets on section switch (remount) — **[GAP]**
- [ ] Save in flight, switch section, return → pending cleared for saved plugin (`delete next[plugin.id]` on success) — **[GAP]**
- [ ] FOCUS_CONNECTOR fires while list still loading → 80ms retry opens it once loaded — **[GAP]** (retry present)

### Fuzz / adversarial
- [ ] connectorId with quotes/backslashes in focus target → escaped for `querySelector` (`replace(/\\/…)`) — **[GAP]** (escaping present, untested)
- [ ] Paste huge/emoji/injection into a credential param → stored in `pendingConfig`, sent on save, no client transform — **[GAP]**
- [ ] Whitespace-only param → `hasPendingConfig` true (keys exist) but server validates — **[GAP]**
- [ ] Invariant: config form NEVER overwrites a dedicated setup panel for `local-setup` modes — **[TEST]** ConnectorsSection.routing.test.ts (regression guard)

### Input modalities
- [ ] `<summary>` keyboard-toggles `<details>`; Switch inside summary keyboard-toggles without also toggling details (`onKeyDown stopPropagation`) — **[GAP]**
- [ ] Touch: Switch ≥44px; summary row tappable — **[GAP]**
- [ ] Mode selector keyboard-navigable — **[GAP]**

### A11y / geometry
- [ ] Enable Switch `aria-label` = Enable/Disable `<name>`; status dot `aria-hidden` — **[GAP]**
- [ ] Save button ok/muted states (never blue); status dots ok/warn/muted tones — **[GAP]**
- [ ] Focus-connector moves focus to `<summary>` with `preventScroll` after smooth scroll — **[GAP]**
- [ ] axe pass with a connector expanded + config form shown — **[GAP]**

### Concurrency / races
- [ ] Toggle request in flight while `plugins` store refreshes → switch reflects server truth, `togglingPlugins` cleans up in `finally` — **[GAP]**
- [ ] Two saves on different connectors concurrently → `pluginSaving` Set tracks each independently — **[GAP]**

---

## Coverage summary

| view | existing test path(s) | biggest gap |
| --- | --- | --- |
| Settings root nav (SettingsView) | `packages/app/test/ui-smoke/settings-mobile-load.spec.ts` (every section mounts at 390px, no crash/boundary/console-error), `settings-theme-audit.spec.ts` + `settings-spacing-audit.spec.ts` (per-element color/spacing), `all-views-interaction.spec.ts`, `settings-section-registry.test.ts` (registry order/replace) | No test drives hash routing, back-button, legacy `#cloud`/`#providers`→`ai-model`, the `SettingsSectionFallback` ErrorBoundary path, or two-pane↔mobile layout crossover |
| identity (IdentitySettingsSection) | none co-located (only smoke mount via settings-mobile-load) | Zero behavioral coverage: name/system dirty tracking, voice preset select + preview audio lifecycle, dual character+voice save via SaveFooter all untested |
| ai-model (ProviderSwitcher) | `useProviderEntries.order.test.tsx` (mobile/desktop provider ordering only) | Routing-mode selection (Local-only / Cloud / subscription / API-key switch), `cloudCallsDisabled` banners, and model-config save are entirely untested; chip tap target `min-h-[2.25rem]`=36px may fail 44px rule |
| voice (VoiceConfigView) | `voice-desktop-selftest.spec.ts` (talk-mode desktop panel, partial); `VoiceSection.test.tsx`/`VoiceProfileSection.test.tsx`/`VoiceTierBanner.test.tsx` cover the *actually-mounted* VoiceSection, **not** VoiceConfigView | **VoiceConfigView appears orphaned** — the live `/settings#voice` route mounts `VoiceSectionMount`→`VoiceSection`; VoiceConfigView (TTS provider/wake-word/ASR/save) has no route and no behavioral test. Confirm whether it is dead code or a missing wiring |
| capabilities (CapabilitiesSection) | `CapabilitiesSection.test.tsx` (proactive-suggestions: reflects persisted env value, defaults subtle, persists via updateConfig) | Capability-router connect form (endpoint + cloud modes, validation, modules/bio parsing), auto-training toggle + availability states, and wallet/browser/computer-use switches are untested; connect has no unmount cancel-guard |
| apps (AppsManagementSection) | none co-located (smoke mount only) | All CRUD flows untested: create/load forms, launch/relaunch/edit/stop row actions, single-`busyApp` cross-row edge; row action buttons `h-7`=28px fail 44px tap target |
| connectors (ConnectorsSection) | `ConnectorsSection.routing.test.ts` (4 mode-routing cases incl regression), `ConnectorsSection.test.tsx` (icon fallback) | Enable-toggle idempotency (`togglingPlugins`), credential-form save lifecycle, and `FOCUS_CONNECTOR_EVENT` deep-link open/scroll/focus are untested |
</content>
</invoke>
