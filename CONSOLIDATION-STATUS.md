# Eliza consolidation review candidate

Branch: `codex/consolidated-eliza-20260923`.
Runtime source verified: `f01aea47706`. Develop cutoff: `69641f10997`.
Status: available for review, **not approved for release**.

## Included work

- Preserved voice/text decision and context behavior, navigation outcome continuity, and transient visible/spoken progress.
- Restored text-group progressive context loading and conservative retention of unclassified history originals in the current assistant owner.
- Shared bounded model-route recovery for the composer and model-download UI.
- Develop updates through the stated cutoff, including auth and relationship storage changes.
- Complete memory namespace transfer and document-fragment link preservation from PR #32368 head `9c12e0fd4a7`.
- Calendar clarification outcomes now stop identical failed attendee retries and remain diagnostic rather than generating a second systemic-error reply. Shared attendee schema carries authorization guidance through tool promotion.

## Evidence

Full repository `bun run verify` passed on the runtime source above. Focused suites cover core/context, voice protocol/UI, real PGlite storage, Notes, Calendar, auth, relationship storage, and transfer round trips. Earlier and overlapping counts are not a single unique test total.

Live QA on an isolated copy of retained state verified greetings, Notes navigation and follow-up, exact note creation/read/edit, exact-time event creation, overlap blocking with checked alternatives, cancellation without data changes, and Home navigation after cancellation. A bounded synthetic Cartesia greeting used one agent model call and produced audio 1.46 seconds after the final transcript; it is not physical microphone/speaker proof.

## Remaining acceptance and limits

- Physical voice capture, animation and playback require device acceptance.
- Action latency is above the requested approximately three-second target in observed runs. The recorded note creation needed reply recovery after invalid model control characters; Calendar had additional domain extraction and substantial host delay. Neither guards nor complete context were removed to conceal those costs.
- Transient local responsiveness delays were observed. Current health probes recovered; root cause is not established. Do not describe every delay as provider/network latency.
- The earlier unfinished provider prose is not claimed fixed by these changes.
- Branch audit distinguishes retained behavior, superseded alternatives, preserved checkpoints, and separate Cloud release history. It does not authorize wholesale deployment-history merges or branch deletion.
- User QA and explicit approval precede new PR publication, merging into develop, or deployment. Recheck upstream compatibility before publication; the cutoff is not a promise of perpetual latest-develop parity.

## Local review artifacts

The private local evidence directory is `/Users/nubs/Documents/ChatGPT/test/consolidation-20260923`.
Start with `PLAN.md`, `CURRENT-STATUS.md`, `BRANCH-DISPOSITIONS.md`, `PROMPT-PATHS.md`, `LIVE-QA-FINDINGS.md`, and `USER-QA.md`. Raw conversation/provider payloads and meeting transcripts stay local, not in this repository.

Preserved rollback tag: `codex/consolidation-baseline-20260923` at `c454f7b7ef9`.
The old preview source and state remain available; no protected branch was force-pushed and no original branch was deleted.

## Latest user-reported navigation regression

After the user observed slow navigation, whole-runtime traces showed inconsistent navigation declarations causing repair and empty reply text causing an extra final-response call. Existing instructions now keep the action pending while holding its nonempty destination confirmation until successful delivery; no guard or permission check was removed. The newest develop snapshot was merged, preserving its stronger transfer validation.

Full repository verification passed on `f01aea47706`. With builds finished, real browser checks measured Notes navigation 2.149s and Calendar navigation 1.189s, one model call each. A bounded synthetic Cartesia “Open Notes” turn navigated a real bound QA browser tab in 1.324s agent runtime; audio began 1.423s after transcription. The canonical reply-completion event preceded audio. Cached input was 4096/6144/6144 tokens respectively. These are single observed runs, not a universal latency guarantee; failed earlier traces remain in local evidence.

The preview has been restarted on the verified version. Physical voice timing retest and user release approval remain pending. Temporary QA browser tab was closed. No PR, protected merge, deployment or branch deletion was performed.
