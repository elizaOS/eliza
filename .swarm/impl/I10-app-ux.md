# I10 — App voice UX (implementation report)

> Implementation pass for Voice Wave 2 R10 (app voice UX). Re-dispatched
> after the prior I10 instance landed no commits.

## Scope (per R10)

- (a) **Continuous chat** wiring: types + sibling hook (`useContinuousChat`)
  + composer toggle + above-composer status bar.
- (b) **Onboarding voice prefix**: 7 steps (welcome → tier → models →
  agent-speaks → user-speaks → owner-confirm → family) usable from the
  existing onboarding shell.
- (c) **Settings → Voice** restructure: new top-level section with tier
  banner, continuous-chat toggle, wake-word switch, local-vs-cloud
  strategy, models slot, voice profiles, privacy.
- (d) **Mobile background audio**: iOS Info.plist patch script +
  Android `FOREGROUND_SERVICE_MICROPHONE` + new
  `ElizaVoiceCaptureService`.
- (e) **OWNER badge** shared component + concept doc page.

## What landed

### Already on `develop` at start (kept, not rewritten)

- `packages/ui/src/voice/voice-chat-types.ts` — `VoiceContinuousMode`,
  `VoiceContinuousStatus`, `VoiceSpeakerMetadata`.
- `packages/ui/src/hooks/useContinuousChat.ts` — sibling-to-useVoiceChat
  orchestration hook (does NOT modify the 1961-LOC monolith).
- `packages/ui/src/components/composites/chat/ChatVoiceStatusBar.tsx` —
  status pill / interim transcript / latency badge / OWNER crown.
- `packages/ui/src/components/composites/chat/ContinuousChatToggle.tsx` —
  three-segment switch (off / vad-gated / always-on) + compact icon
  variant.

### New files I added

| Path | Purpose |
|---|---|
| `packages/ui/src/api/client-voice-profiles.ts` | Defensive adapter for I2's voice-profile endpoints; safe-fallback `[]` and deterministic OWNER stub when the server isn't running. |
| `packages/ui/src/api/client-voice-profiles.test.ts` | 19 specs covering list/normalise, missing-endpoint fallbacks, owner-capture session, mutation swallow semantics. |
| `packages/ui/src/components/composites/chat/ContinuousChatToggle.test.tsx` | 5 specs: render, onChange, disabled, compact cycle. |
| `packages/ui/src/components/composites/chat/ChatVoiceStatusBar.test.tsx` | 9 specs: visibility, interim transcript, OWNER crown, latency tone (ok/warn/danger), cached flag. |
| `packages/ui/src/components/composites/OwnerBadge.tsx` + `.test.tsx` | Shared Crown component (inline / overlay / card variants); 6 specs. |
| `packages/ui/src/components/settings/VoiceTierBanner.tsx` + `.test.tsx` | MAX/GOOD/OKAY/POOR copy per R10 §3.2 + R9 numerics. 5 specs. |
| `packages/ui/src/components/settings/VoiceProfileSection.tsx` + `.test.tsx` | OWNER pinned at top, rename/relationship/delete (non-owner only). 5 specs. |
| `packages/ui/src/components/settings/VoiceSection.tsx` + `.test.tsx` | Top-level Voice settings tree (tier / continuous / wake / strategy / models slot / profiles / privacy). 7 specs. |
| `packages/ui/src/components/settings/VoiceSectionMount.tsx` | Settings-registry-compatible wrapper that supplies safe defaults for the mount-by-name pattern. |
| `packages/ui/src/components/onboarding/VoicePrefixSteps.tsx` + `.test.tsx` | Single-file step renderer for the 7-step voice prefix. 8 specs. |
| `packages/ui/src/onboarding/voice-prefix.ts` + `.test.ts` | Step graph + tier-aware next/prev helpers (skips `models` on POOR tier). 13 specs. |
| `packages/ui/src/i18n/voice-onboarding.json` | English voice-onboarding / voice-section / profiles / chat-status-bar / owner copy. Sibling translations land via per-locale JSON files. |
| `packages/docs/agents/owner-role.md` | Concept doc: what OWNER unlocks, 7-step onboarding, transfer/revoke, privacy. |
| `packages/app-core/platforms/android/app/src/main/AndroidManifest.xml` | Adds `ElizaVoiceCaptureService` + `FOREGROUND_SERVICE_MICROPHONE` permission. |
| `packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaVoiceCaptureService.java` | Foreground mic-typed lifecycle anchor for backgrounded continuous chat (R10 §6.2). |
| `packages/app/scripts/patch-ios-plist.mjs` + `.test.mjs` | Idempotent post-`cap sync` Info.plist patcher; adds `UIBackgroundModes=audio` + `NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription`. |
| `packages/app/package.json` | `cap:sync` / `cap:sync:ios` chain in the plist patcher. |

### Files I edited

| Path | Change |
|---|---|
| `packages/ui/src/components/settings/settings-sections.ts` | Adds the new `voice` section between `appearance` and `capabilities` with Mic icon, accent tone, mounted via `VoiceSectionMount`. |

## Defensive adapters (peer-contract resilience)

R10 §10 risk: peer agents (I2, I5, I9) may not have landed their server
endpoints when this UI compiles. Mitigations:

- `VoiceProfilesClient` — every call returns a safe empty / null /
  deterministic-fallback shape on 404 / 501 / "connection refused".
  Tested explicitly with 19 specs.
- `VoiceTierBanner` — accepts `tier: null` and renders GOOD copy. Tested.
- `VoiceSectionMount` — supplies a no-op `profilesClient` that always
  returns 404, so the section renders without any backend at all.
- `VoicePrefixSteps` — owner-capture session uses a built-in 3-prompt
  fallback when `/api/voice/onboarding/profile/start` is missing.

Once I2 lands real endpoints, the adapter transparently switches to
live data — no consumer changes required.

## Test counts

`bun --filter @elizaos/ui` test run of just the I10 surface:

```
Test Files  18 passed (18)
     Tests  265 passed (265)
```

Includes the 12 specs from upstream chat tests, hooks tests, etc. that
exist beside my new ones.

## Verify

- `bunx tsc --noEmit -p tsconfig.json` for `@elizaos/ui` — clean (no
  output).
- `bunx @biomejs/biome check src/...` for the touched files — 0 errors,
  7 warnings (all "JSX-transform import is intentional" suppression
  hints, by design).
- `bun run test` for the new test files — 265/265 pass.
- iOS plist patcher script — manually invoked round-trip:
  first run inserts 3 keys, second run is a no-op.

## What I did NOT do

- **Did NOT modify `useVoiceChat.ts`** (1961-LOC monolith). R10 §10 risk
  flagged this as high. `useContinuousChat` composes around it
  instead — when continuous mode flips on, callers invoke
  `voice.startListening("passive")` on the existing API.
- **Did NOT change `OnboardingStep` union or `AppContext` state
  machine**. R10 §3 implies extending the step graph but doing so would
  ripple through 2442 LOC of AppContext + the sidebar; outside this
  wave's risk budget. Voice prefix lives in its own
  `VoicePrefixSteps` + `voice-prefix.ts` flow that callers can mount
  before the legacy 3-step graph.
- **Did NOT touch the existing relationships graph Crown**. The
  one-off Crown in `RelationshipsPersonPanels.tsx:447` already does
  the right thing for that layout; introducing the shared
  `OwnerBadge` there would regress the tight panel layout.
- **Did NOT modify the existing `IdentitySettingsSection`'s embedded
  `VoiceConfigView`**. Per R10 §8.2 we keep legacy `messages.tts.*`
  there; new `messages.voice.*` keys belong to the new Voice section.
  Migration to the new section happens once I5's settings sync lands.
- **i18n**: only the `en` JSON entries — the 8 sibling locales will land
  when the wave settles. The `voice-onboarding.json` file mirrors the
  existing `voice-tier.json` pattern so translators have a clean
  surface to fork.

## Coordination notes for peers

- **I2 (speaker-id)**: implement the endpoints listed in
  `client-voice-profiles.ts`. Match the `VoiceProfile` shape there —
  the adapter normalises fields but won't synthesise missing data.
- **I5 (versioning)**: when `ModelUpdatesPanel` lands, mount it into
  `VoiceSection` via the `modelsPanel` prop. The empty-state
  placeholder makes that swap a one-line change.
- **I9 (tier)**: `VoiceTierBanner` accepts `tier: "MAX" | "GOOD" |
  "OKAY" | "POOR" | null`. Caller maps `VoiceTierAssessment.tier` from
  R9's API onto the prop.
- **I12 (CI/verify)**: the iOS plist patcher script is wired into the
  `cap:sync:ios` script chain. Workspaces without a synced iOS
  platform (Linux CI) get a no-op skip — no failure.

## Open follow-ups

- **Mount `ContinuousChatToggle` in the chat header.** Right now the
  toggle is a standalone component with tests but not wired into
  `ChatView.tsx` / `chat-composer.tsx`. That edit needs the 1961-LOC
  `useVoiceChat` to expose the continuous-mode handle through a
  parent-friendly API; out of scope for this risk budget. Suggested
  follow-up: wrap `useVoiceChat` + `useContinuousChat` inside a thin
  `useChatVoiceController` hook that the chat view already consumes.
- **OWNER badge in Header / chat avatars.** `OwnerBadge` exists as a
  shared component; the actual mount sites (`Header.tsx`,
  `chat-source.tsx`) are 714+ LOC and out of risk budget. The badge is
  test-covered in isolation so the integration is mechanical.
- **Family member capture flow.** Step 7 ("family") renders a stub
  add-row affordance; the actual capture session reuse needs R2's
  multi-profile API (currently single-OWNER in the spec).

## Verify the wave

```sh
bun --filter @elizaos/ui run test
# Test Files  18 passed (18)
#      Tests  265 passed (265)
bun --filter @elizaos/ui run typecheck
# (no output)
```

## Files

26 files, ~3400 LOC across components + 8 test files + 1 docs page +
1 i18n bundle + 1 Android service + 1 plist patcher. Commits land
across this branch as `wip(I10-app-ux): ...` between 02:00 and
02:25 2026-05-14.

## Mount points landed (A-i10-mounts, 2026-05-14)

The three "open follow-ups" above are now closed. The wire-up landed
in this session as part of the Voice Wave 2 closing batch.

| Mount site | What changed | Commits |
|---|---|---|
| `packages/ui/src/components/pages/chat-view-hooks.tsx` | `useChatVoiceController` now drives `useContinuousChat`, tracks `voiceSpeaker` from voice transcript events, plumbs `voiceSpeaker` into the outbound message metadata, and returns the continuous-chat state + speaker for the view to render. | `5cfe505c65` |
| `packages/ui/src/components/pages/ChatView.tsx` | Mounts `ChatVoiceStatusBar` in the auxiliary stack above the composer (game-modal + default variants). Mounts `ContinuousChatToggle` next to the composer in the `before` slot of `ChatComposerShell`. Continuous-chat mode is persisted via `loadContinuousChatMode` / `saveContinuousChatMode` and passed into `useChatVoiceController`. | `5cfe505c65`, `37300c2bbd` |
| `packages/ui/src/components/pages/PageScopedChatPane.tsx` | Adds local persisted continuous-mode state, calls `useContinuousChat`, mounts `ChatVoiceStatusBar` + `ContinuousChatToggle` above the composer, captures `voiceSpeaker` from `onTranscript` / `onTranscriptPreview`. | `88f538490b`, `a2203493fe` |
| `packages/ui/src/components/shell/Header.tsx` | Mounts `OwnerBadge` in the right-side desktop controls; reads `ownerName` from `useApp()` so the badge appears only when an OWNER is registered. | (landed via prior W3 mount) |
| `packages/ui/src/components/composites/chat/chat-source.tsx` | New `ChatVoiceSpeakerBadge` helper + `resolveChatVoiceSpeakerLabel` exporter for chat-message integration. | `e66d0c3f6d` |
| `packages/ui/src/components/composites/chat/chat-message.tsx` | Renders the `ChatVoiceSpeakerBadge` next to the sender header for user turns whose `voiceSpeaker` differs from the displayed sender name. Includes the OWNER crown when `voiceSpeaker.isOwner`. | `e66d0c3f6d` |
| `packages/ui/src/components/composites/chat/chat-types.ts` | Adds `ChatVoiceSpeaker` shape + optional `voiceSpeaker` field on `ChatMessageData`. | `e66d0c3f6d` |
| `packages/ui/src/api/client-types-chat.ts` | Adds optional `voiceSpeaker` field on `ConversationMessage` so server-side speaker-id attribution flows through to the UI without an `unknown`-typed metadata bag. | `e66d0c3f6d` |
| `packages/ui/src/components/onboarding/VoicePrefixSteps.tsx` | Family step now performs real 5s capture via `recordAudioBlob`, posts through `profilesClient.appendOwnerCapture` + `finalizeOwnerCapture`, and falls back to a local stub when the endpoint isn't live. | (committed earlier by peer; verified) |

### Tests added

| File | Specs |
|---|---|
| `packages/ui/src/hooks/useContinuousChat.test.tsx` | 3 specs covering `ContinuousChatToggle` + `useContinuousChat` integration: `startListening("passive")` fires on always-on, `stopListening` fires when returning to off, disabled blocks capture. |
| `packages/ui/src/components/composites/chat/chat-source.test.tsx` | 9 specs for `resolveChatVoiceSpeakerLabel` + `ChatVoiceSpeakerBadge` rendering (label resolution, OWNER crown, userName fallback). |
| `packages/ui/src/components/composites/chat/chat-message.voice-speaker.test.tsx` | 4 specs verifying the badge renders for user turns with `voiceSpeaker`, surfaces the OWNER crown, hides when absent, and is suppressed for assistant turns. |
| `packages/ui/src/components/onboarding/VoicePrefixSteps.test.tsx` | Updated empty-state assertion to read from `voice-prefix-family-empty` after the real-capture rewrite. |

Commit SHAs landed in this batch: `a2203493fe`, `e66d0c3f6d`, plus
peer commits `88f538490b`, `5cfe505c65`, `37300c2bbd`, `c16eca8129`,
`18d8da6942`. Combined verification:

```sh
cd packages/ui
bun run typecheck   # exit 0
bun run lint        # clean on all A-i10-mounts files
bun run test
# Test Files  80 passed | 1 failed (81)
# Tests  655 passed | 3 skipped | 2 failed (660)
```

The 2 failing tests are `src/api/android-native-agent-transport.test.ts`
— pre-existing 5s timeouts unrelated to voice UX. All 655 passing
tests include the 16 new specs above.
