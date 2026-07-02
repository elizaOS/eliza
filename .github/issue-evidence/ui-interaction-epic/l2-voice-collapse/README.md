# L2 — voice + transcription state/UI in chat, and chat collapse behavior

Leg 2 of the UI-interaction epic (`feat/ui-interaction-launcher-epic`).
Research-first audit of the complete voice/transcription state machine and the
ContinuousChatOverlay collapse machine, followed by surgical fixes for every
high-confidence defect found. All state lives in two files; there is **no**
`components/voice-pill/` or `components/voice/` directory in the current tree —
the epic prompt's code map was stale on that point. The voice pill of today is
`PillHandle` inside `ContinuousChatOverlay` (glow = `listening || responding`)
plus `HomePill` for the separate desktop-overlay/kiosk shell.

## 1. State-machine map (as it exists on develop @ 8e396f4702e)

### 1a. Voice/transcription — owner: `useShellController` (packages/ui/src/components/shell/useShellController.ts)

| State | Where | Meaning |
|---|---|---|
| `recording` | controller `useState` | a capture handle is live (any intent) |
| `transcript` | controller `useState` | live interim text of the current utterance |
| `handsFree` (+`handsFreeRef`) | controller | always-on converse loop engaged (mic re-opens after each spoken reply) |
| `transcriptionMode` (+ref) | controller | long-form record-only layer active |
| `analyser` | controller | live `AnalyserNode` for the waveform |
| `lastTurnVoice` | controller | latch: speak the next reply aloud |
| `speaking / needsAudioUnlock / agentVoiceMuted` | `useShellVoiceOutput` | TTS playback state |
| `phase` | derived | `booting → listening → responding → summoned/idle` (recording wins over responding) |
| `responding` | derived | `chatSending \|\| speaking` — the honest busy bit |
| capture intent | `startCapture(intent)` closure | `converse` (EOT aggregator + shouldRespond + VOICE_DM send) · `dictate` (PTT → dictation sink → composer draft) · `transcription` (verbatim → `TranscriptSessionAccumulator`) |
| PTT phase | overlay `pttRef` (`idle→pending→holding`) + `pttHolding` label mirror | press-and-hold dictation |
| draft (`draft`, `pendingImages`) | overlay `useState` + `setComposerHasDraft` bridge → controller | pauses the hands-free loop while typing |
| session sinks | `setDictationSink` / `setTranscriptSessionSink` refs | overlay wires draft-append + transcript-attachment delivery |

Mic button semantics (overlay): tap = toggle hands-free · hold ≥200 ms = PTT
dictate · tap while transcribing = `stopTranscriptionAndMic` (mic is the parent
control) · transcribe button = transcript layer only, leaves the mic on
(#10699). Error/denied/no-device: `describeCaptureFailure` →
`setActionNotice` toast (NotAllowed vs NotFound distinguished), latched via
`captureFailureNoticedRef` so hands-free retries don't spam.

### 1b. Collapse — owner: `ContinuousChatOverlay` (single `mode` ordinal)

`mode ∈ {pill, input, half, full}` is the ONE openness state;
`pilled/sheetOpen/expanded` are derived. Orthogonal overrides: `freeH`
(free-drag rest height) and `maximized` (full-bleed, only legal at `full`).
Transitions: grabber drag/flick/tap (usePullGesture), composer focus/typing →
`expand()` (half), send → half, Escape/outside-tap/grabber-tap → `collapse()`,
header launcher → `navigateAndClose`, tutorial + prefill + `#chat?…` hash
events, first-run pin at FULL. Voice deliberately SURVIVES collapse: capture is
controller-owned (App-root), the pill glows while listening/responding, and the
interim transcript renders at the overlay root in every mode — by design, not a
leak (comment at the interim-transcript block).

## 2. Defect inventory (ranked; verdicts)

| # | Finding | Confidence | Verdict / action |
|---|---|---|---|
| D1 | **Mic tap dead during transcription while a reply is in flight.** `handleMicClick` gated `responding && !handsFree` BEFORE the `transcriptionMode` branch. A wake-word inline reply (#9880) sets `responding=true` with `handsFree=false` (paused by the transcript layer) → the mic button reads "stop transcription", lights active, and does nothing. On the continuous (talkmode) backend `recording` stays true through the reply so the mic (not the stop control) is what's rendered. | High | **FIXED** — off-path checked first; turning a live voice layer OFF is never gated on `responding`. |
| D2 | **Audio-unlock chip unreachable while the sheet is open.** The chip (`overlay-voice-audio-unlock`) renders at the overlay ROOT, outside the glass panel. Both document-level outside-tap detectors classified it as "outside": pointerdown dismissed the keyboard/collapsed, pointerup swallowed the click (`stopImmediatePropagation` + one-shot click suppressor) → `unlockAudio` never fired AND the sheet collapsed. Voice output could not be enabled while chat was open — an unreachable error-recovery state. | High | **FIXED** — new `isOverlayControlTarget` predicate: anything inside `overlayRef` counts as inside (root + backdrop are pointer-events-none, so real targets there are always controls), with the full-viewport dimming backdrop explicitly excluded (synthetic events only). |
| D3 | **Transcription silently pauses while a draft exists.** The transcription re-listen loop copied the hands-free loop's `composerHasDraft` gate. On a one-shot backend (local-inference VAD auto-stop) typing anything froze the re-open — recording stopped while the badge still said "Transcribing", losing meeting audio; the continuous backend kept recording, so behavior diverged per backend. Contradicts the documented additive-layer contract ("the composer keeps working; the mic stays on the whole time"). | High | **FIXED** — draft gate removed from the transcription loop only (converse loop unchanged; reply/TTS gates kept so agent speech is not recorded). |
| D4 | **Stale `maximized` on the two leave-full paths that bypass `goToDetent`.** (a) tutorial `pill` action, (b) `onSettleFree` gap-rest branch. Declared invariant: "only true while at FULL; every leave-full transition resets it." Leak (a) is reachable (tutorial pill from maximized + thread-less pill→input open → later return to full jumps straight to edge-to-edge); leak (b) is currently defensive only (the grabber is unmounted at full-bleed) but enforces the invariant at the seam. | High (a) / Medium-defensive (b) | **FIXED** — `setMaximized(false)` at both sites. |
| — | Recording state surviving overlay collapse | — | **Not a defect** — deliberate ambient-voice design (controller-owned session, pill glow feedback, interim transcript rendered in all modes). Verified against VOICE_UX.md. |
| — | Transcript loss on collapse / navigation / unmount | — | **Not found** — session lives in the controller (`TranscriptSessionAccumulator`), which outlives the overlay; PTT unmount cleanup already stops a stuck dictate capture. |
| — | Permission-denied / no-device states | — | Already surfaced via `describeCaptureFailure` toast with retry latch (covered by existing tests). |

### Recommendations NOT implemented (medium/low confidence)

1. **`toggleTranscriptionMode` entry is not gated on `responding`** (slash
   command / server `voice-control` event can open a transcription capture
   while TTS is playing, potentially recording the tail of agent speech on a
   continuous backend). The re-listen loop already waits out `speaking`; adding
   an entry defer needs a queued-start design (start once the reply ends) —
   product call, medium confidence, left as recommendation.
2. **`ShellController.close()` collapses hands-free** but is only wired in the
   desktop overlay/kiosk `ShellFoundationMount`; the main app never calls it.
   Harmless duplication of surface, not dead code (the OS-overlay window uses
   it) — no change.
3. The `isOpen` controller flag and the overlay `mode` are intentionally
   separate machines (controller = "voice/chat session", overlay = sheet
   geometry). They do not duplicate state; no consolidation warranted.

## 3. Implemented changes

- `packages/ui/src/components/shell/ContinuousChatOverlay.tsx`
  - `handleMicClick`: transcription off-path before the `responding` gate (D1).
  - `isOverlayControlTarget` predicate + both outside-tap detectors use it (D2);
    removed the now-redundant grabber special-case in the keyboard-dismiss
    detector (the grabber is inside the overlay).
  - `setMaximized(false)` in the tutorial `pill` action and the `onSettleFree`
    gap-rest branch (D4).
- `packages/ui/src/components/shell/useShellController.ts`
  - Transcription re-listen loop no longer gates on `composerHasDraft` (D3).
- Tests:
  - `ContinuousChatOverlay.test.tsx`: mic-tap-ends-transcription-mid-reply;
    audio-unlock chip works with the sheet open and the sheet stays open.
  - `ContinuousChatOverlay.fuzz.test.tsx`: leaving FULL via the tutorial pill
    drops full-bleed for good (thread-less pill→input seam), invariants asserted
    at every step.
  - `__tests__/useShellController.test.tsx`: transcription keeps recording
    through a composer draft; later utterances land in the SAME session.
  - `__e2e__/chat-sheet-fixture.tsx` + `run-chat-sheet-e2e.mjs`: new `?unlock` +
    `?transcribing` fixture states; two real-browser scenarios (unlock chip with
    the sheet open; mic-off during an in-flight inline reply) with screenshots
    (`output/state-audio-unlock-*.png`, `output/state-transcribing-inline-reply.png`,
    copied here).

Every fix was adversarially verified: each new test was run against a
temporarily-reverted fix and failed, then re-run green with the fix restored
(red→green evidence in `test-logs.txt`).

## 4. Evidence files

- `test-logs.txt` — unit + fuzz + controller suite runs (baseline, red-on-revert
  proof, final green) and the chat-sheet e2e log.
- `state-audio-unlock-open.png` / `state-audio-unlock-cleared.png` — the fixed
  unlock flow with the sheet open (chip visible → tapped → cleared, sheet still
  open).
- `state-transcribing-inline-reply.png` — mic as "stop transcription" during an
  in-flight reply (the previously-dead state, now live).
