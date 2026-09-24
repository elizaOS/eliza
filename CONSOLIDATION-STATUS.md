# Eliza consolidation review candidate

Branch: `codex/consolidated-eliza-20260923`.
Current source checkpoint: `e8eec247928`. Included develop cutoff: `ff48eeb4193`.
Status: **context cleanup acceptance in progress; not approved for release**.

## Current context and recovery follow-up

This update supersedes the earlier review-ready status below. Earlier metrics remain historical evidence, not claims about the newest changes.

- Removed the initial global action-name/catalog preload using existing discovery, including noncoding voice-group/unknown channels and context-read refreshes. Known actions still route directly; unfamiliar operations retain authorized catalog/schema discovery.
- Shared historical navigation guidance once while preserving all exact receipts and ownership checks. The saved dynamic-input replay fell from 34,361 to 17,421 characters; this is not a total-token measurement.
- Actual rebuilt-preview handler input fell from the saved 17,114-token sample to 13,469 tokens. Whole-turn tests also exposed missing progress and empty-final-reply recovery, so input reduction alone is not acceptance.
- Recovered the small acknowledgment restriction removal from `8daa2014f52` and stronger day/range Calendar routing from `484d1e9eec1`. Their behavior existed in the saved text/group candidates but was missing from the voice candidate that fed consolidation. The Calendar search guard itself was already retained.
- The older reference-only catalog was explicitly changed to a name index by `78224097693`; restoring deferral is a design change with discovery tradeoffs, not merely recovery of a missing commit.
- Aligned evaluator instructions with its existing required-reply contract and made source-reply schema guidance include planning acknowledgments. No added classifier/model call, hardcoded intent router, history cap or permission bypass.
- Merged the 12 additional develop commits through `ff48eeb4193`, including owner-resolution and canonical BGE changes. A rollback tag preserves the pre-merge checkpoint: `codex/context-cleanup-pre-develop-20260923`.

Verification: root `bun run verify` passed on `e8eec247928` (382 workspace tasks plus audits); 536 focused core/discovery/owner tests, 3 owner-routing tests, 108 reply/recovery tests and 38 prompt-package tests passed across the recorded checkpoints. The inference Vitest lane passed 2,935 tests with 29 explicit skips; its separate native lane passed 60 tests. These are overlapping scoped results, not one unique full-repository test count.

The matching native library is now staged for the isolated preview from llama fork `d4a7ef4244`. The required context-GPU-selection export and canonical 384-dimensional BGE semantic/reopen checks passed. The shared old library was preserved.

Final current typed Calendar check: 4.696s, three foreground calls plus one background memory call. Handler input 13,553 tokens; foreground total 40,554, with 1,024 cached; background 9,691, with none cached. Actual wire confirms reference-only discovery and shared navigation guidance. The model generated an acknowledgment, and the evaluator produced the final reply without a fourth recovery call. This does not establish physical voice timing or universal cache/latency performance.

**Acceptance remains HOLD:** the model again selected a next-event projection for a whole-day agenda question and claimed an exhaustive count. The one-event fixture happened to match the answer, which is insufficient scope proof. Verify/fix this specific read-coverage contract before release; do not bypass it or erase failed traces. The context/recovery goal remains active. No new PR, protected-develop merge, deployment or original-ref deletion has occurred.

The private local reports `CONTEXT-CLEANUP-PLAN.md`, `WHOLE-TURN-CONTEXT-AUDIT.md`, `CONTEXT-RECOVERY-AUDIT.md` and `SHAW-CONTEXT-AND-LATENCY.md` record the findings and unresolved gates. The 159-branch inventory accounts for refs and dispositions; it does not certify that every prior prompt edit survived or that every scenario is newly re-tested.

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

## Review handoff

The [branch disposition snapshot](docs/consolidation/branch-dispositions-20260923.md) accounts for the 159 collected branch names, including intentionally preserved or excluded alternatives. Full root verification completed 382 workspace tasks plus repository audits on `f01aea47706`.

A further bounded real-Cartesia Calendar read verified the longer-turn acknowledgment: “Checking what's on your calendar tomorrow.” First audio arrived 1.557s after transcription, final answer at 3.792s. Whole agent runtime was 3.805s with three foreground model calls (handler, planner, evaluator), 47,677 input tokens and 8,192 cached. The acknowledgment added zero model calls. The read returned the correct event, no writes, no error or duplicate reply; the new reply-completion signal arrived before TTS completion. This is synthetic-audio transport evidence, not a physical microphone/speaker guarantee.

Engineering consolidation and bounded QA evidence are ready for user review. Release approval is still required. Complex turns may exceed three seconds; intermittent historical host stalls are not claimed universally eliminated. Further code changes should follow a reproducible failure, not an unbounded benchmark loop.
