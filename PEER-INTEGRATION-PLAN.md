# Isolated peer context integration

## Current state

Pinned peer integration is ready for a local review checkpoint. All 33 peer commits were reviewed; seven textual conflicts were reconciled. Root verification passes on the final source (373 tasks plus audits). Owning tests and six live browser prompts are recorded in the evidence below. Navigation, Notes exact text, Calendar options without booking, and original/correction recall passed their sampled correctness checks. Recall latency, progress wording and complete scheduled-background cost accounting remain explicit follow-ups; this is not universal performance or release acceptance. The isolated API is stopped after observing unsolicited scheduled output; supported test-only scheduler switches are now in its launcher. This task owns this worktree.

- Worktree: `/Users/nubs/Git/eliza-peer-context-integration-20260919`
- Branch: `codex/peer-context-integration-20260919`
- Base: `bd227d2f52e474146394c20f269cecf062d04ba2`, including tested production `f0c5bddfe3d` plus saved acceptance documentation.
- Preserved demo tag: `codex/ganttnubs-pre-peer-integration-20260919`.
- Peer scope pinned to the supplied handoff: `e59818bf174c2b6d96081fc804175d5150dff736`, not the moving local branch tip.
- Handoff runtime was `558252f8b848ff7e5e80177d995ea725c3e57f1c` on 5228; published branch and runtime are distinct.
- Current demo stays on 5248/API31372 in `/Users/nubs/Git/eliza-core-latency-cleanup-20260917`. Do not restart, repoint or share its writable database with the integration instance.

## Evidence already reviewed

[Peer handoff](/Users/nubs/Documents/ChatGPT/test/eliza-fork-audit-20260915/runtime/history-read-provider-recovery-20260918/STOPPING-POINT.md) and its CURRENT-ACCEPTANCE.md were read. Peer navigation reportedly fell from 23,383 to 11,712 input tokens, but exact quotation took two foreground calls/4.925 seconds and 35,043 inputs. Samples have different history/timing. Handler instructions remain 16,712 characters. These are peer observations, not integrated acceptance.

[Preflight inventory](/Users/nubs/Documents/ChatGPT/test/eliza-peer-integration-20260919/integration-inventory.json) pins all 33 peer commits, shared base and 20 overlapping paths. [Merge preflight](/Users/nubs/Documents/ChatGPT/test/eliza-peer-integration-20260919/merge-preflight.txt) reports seven text conflicts: four production files (evaluator prompt, candidate hints, completion context, Stage-1 decision) plus three documentation files. The preflight used `git merge-tree`; subsequently the pinned merge was applied only in this integration worktree with `--no-commit --no-ff`.

## Sequence and acceptance

- [x] Save current source and task/acceptance snapshot; tag before integration.
- [x] Create separate branch/worktree; pin supplied peer commit; review linked acceptance and graph.
- [x] Run non-mutating merge preflight and record conflict/overlap inventory.
- [x] Read owning guides, peer tests and dependencies for the 33 commits. Classify each change: already present, compatible benefit, dependency, conflicting behavior, or unrelated/defer. A clean textual merge alone is not correctness.
- [x] Reconcile core source selection/recovery and reply-finalization contracts without reverting current Calendar/Notes guards or early acknowledgments. Preserve both sides' relevant regressions. Prefer coherent dependent change groups; do not blindly cherry-pick the final commit or select whole files from either side.
- [x] Run focused offline checks for recalled-source deferral, original/correction preservation, source ownership, non-owner withholding, stale/missing checkpoint fallback, provider restoration, handler/planner/evaluator routing and no premature effects.
- [x] Check Notes/Calendar current contracts and accepted single-call navigation remain intact; owning types/lint and root verify on the integrated source.
- [x] Set up a separate local instance with separate writable state and unused ports; label it explicitly. Do not use 5248/31372, 5228 or 5199. Preserve provider/model settings; never log secrets.
- [x] Minimal necessary real browser acceptance (recorded limitations below): navigation, exact historical quote plus correction, one representative Notes write/read and Calendar clarification/proposal path where affected. Reuse archived trajectories first; no repeated paid timing sweep. Record source version and state, foreground/background calls, input/cache/output, acknowledgment/final times and actual saved values.
- [x] Investigate the extra exact-recall call and handler prompt overhead from actual traces. Retain the recovery call if removing it loses authorized originals/corrections. No arbitrary context truncation, summary substitution or phrase-specific fast path.
- [x] Classify result ACCEPT / HOLD with remaining limits; clean only integration fixtures; commit/tag integrated source only after its own gates. Keep baseline available for comparison. No claim that integration is already deployed or universally faster.

## Invariants

Full original records, standing constraints, permissions, source identities, corrections, exact text, request clocks and effect receipts remain authoritative. A model-selected retention checkpoint is not a permission grant. Stale/incomplete selection must retain or recover full authorized context. Proposed free slots never select a booking time; eventual writes validate target and availability. An acknowledgment is transient and adds no model call. Preserve one continuous chat per instance and one authoritative final response.

## Scope boundaries

User authorized isolated integration work. No changes to protected/source branches, no develop merge, push, deployment, shared-branch publication, voice/microphone testing or provider switch in this phase. Voice remains last/separate. This document governs integration execution; the existing local board remains the cross-task status index.

## Rollback and continuation

To compare or revert this work, use the pre-integration tag in another isolated checkout; do not reset the user's live demo. Tags restore code, not application state. Continue here by reviewing the four production conflicts and related tests, then implement coherent selected changes. No further user “proceed” is required for this authorized local work, but do not report it complete before the remaining gates pass.

## Current evidence and remaining gates

- `/Users/nubs/Documents/ChatGPT/test/eliza-peer-integration-20260919/REVIEW.md`: 33-commit decisions and conflict reconciliation.
- `/Users/nubs/Documents/ChatGPT/test/eliza-peer-integration-20260919/LIVE-RESULTS.md`: every live scenario, actual inputs/cache/calls/timing, persistence and limitations.
- `/Users/nubs/Documents/ChatGPT/test/eliza-peer-integration-20260919/LATENCY-INVESTIGATION.md`: why original-evidence recovery cannot be dropped for speed.
- Root final check: `verify-typed-calendar.log`, exit0,373/373tasks plus audits. Personal Assistant receipt/handoff44pass; separately configured scheduling real lane9pass. Notes191pass. Calendar split-run coverage documented in REVIEW.md.
- Notes and synthetic historical-conversation fixtures were removed through owning APIs; Calendar test day remains empty. Main synthetic QA transcript remains as evidence.
- Documented follow-ups: semantic-recall unavailability reason and unnecessary discovery path; uninstrumented scheduled usage is unavailable and must not be counted as zero. Offline logs identify the unsolicited outputs as default-pack work, unchanged by this merge. Progress transport preserves one final reply, but model-authored progress wording failed the desired conversational quality in one sample. Do not weaken source/permission checks or add phrase matching to hide it.

This local checkpoint preserves reviewed integration work without changing the saved demo or authorizing a remote merge/deploy. The completion audit documents the remaining tradeoffs without claiming universal speed or release acceptance.

## Review checkpoint

Integration merge `d80236a956377fc1c5bce6970ea56339a8f783dc`, local tag `codex/peer-integration-reviewed-checkpoint-20260919`. Detailed requirement-by-requirement audit: `/Users/nubs/Documents/ChatGPT/test/eliza-peer-integration-20260919/COMPLETION-AUDIT.md`. Core integration and sampled text correctness: accepted for local review. Universal latency, acknowledgment prose quality and broader release readiness: HOLD. No further model calls made to chase timing samples.
