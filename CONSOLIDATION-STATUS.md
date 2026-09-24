# Consolidated Eliza: verified QA candidate

Branch: `codex/consolidated-eliza-20260923`. Runtime source: `84393b71246`; transport-test checkpoint: `93e59cfb3df`. Includes develop cutoff `ff48eeb4193`.

**Engineering fixes and bounded autonomous QA are complete for user review. This is not release approval, a universal latency guarantee, or verification of Shaw's combined refactor.**

## What changed

- Removed the full action-catalog preload from noncoding response handlers. Old navigation receipts follow selected original requests, with exact restoration and source binding; originals remain stored.
- Required snapshot revisions for promoted Notes field replacements. Existing atomic literal substitutions remain available through `NOTES_UPDATE`. Ownership, ambiguity and concurrency checks remain intact.
- Preserved committed effect receipts across later failures and into authorized follow-ups. Text, SSE and voice-bridge retry tests prove the same admitted request does not rerun actions.
- Included existing participant identity in Stage 1 and clarified Calendar local-time wording without inferring attendance from elapsed time.
- Kept concise acknowledgments in display metadata, removed elapsed timers, and retained speaking/mic-paused state until device playback drains. Acknowledgments use existing inference, not another model call.

## Evidence and limits

| Check | Result |
| --- | --- |
| Real Cartesia with synthetic agenda audio | Correct two-event answer; three calls; 4.034s runtime |
| Acknowledgment | “One sec, checking.”; first audio 1.937s after final transcription |
| Handler / planner / evaluator inputs | 10,670 / 9,694 / 9,506 tokens; cached subsets 0 / 4,096 / 1,024 |
| Earlier comparable agenda inputs | 15,950 / 15,600 / 15,388; history/cache differ, so this is not a controlled speed comparison |
| Historical navigation follow-up | Correct, 1.459s, one call, no navigation or writes |
| Combined disposable Notes delete/edit | Both correct; original notes unchanged; 10.471s/seven calls due to revision recovery |
| Failure transport proof | Committed effects survive later failure and reach the next turn through text, SSE and voice bridge; retries do not repeat actions |

Root verification passed at the runtime source; 515 context/routing checks and 101 Notes checks passed, alongside focused voice, UI, identity and persistence checks. Later test-only changes passed agent tests/typecheck. Counts overlap and are not an all-platform E2E claim.

Physical microphone, speaker and animation feel still need user acceptance. Synthetic audio proves the provider/runtime protocol; client tests cover mic gating, playback drain and renewal ordering. Some tasks remain above three seconds. Model wording can vary; historical incorrect replies are not retroactively rewritten. Disposable QA fixtures were removed and the original Notes snapshot is unchanged.

## Integration boundary

Last verified Shaw head `b45c2b8525b` included this branch through `0730db6be16`. Subsequent fixes require reviewed integration and combined QA. The reasoning-removal experiment `816bad9bca5` was reverted by `7bc7bc3f0a4`; do not take the experiment alone.

No new PR, protected merge, deployment, agent message, branch deletion or PR closure was performed by this task. Historical branch cleanup and separate Cloud release histories remain distinct preserved work. User approval precedes publication or integration.

Local acceptance evidence: `/Users/nubs/Documents/ChatGPT/test/consolidation-20260923/long-qa-review/GOAL-COMPLETION-AUDIT.md`. Start with `CURRENT-STATUS.md` and `FINAL-HANDOFF.md` in that evidence directory. Private model payloads remain local.
