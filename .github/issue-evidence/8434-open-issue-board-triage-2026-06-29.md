# elizaOS open issue board triage - 2026-06-29

Snapshot source: `gh issue list -R elizaos/eliza --state open --limit 100`
plus latest-three issue comments fetched by GraphQL. Snapshot count: 37 open
issues. Local machine: Windows, Node v24.15.0, Bun 1.4.0.

## Current blockers on this Windows box

- `bun install`, `bun run install:light`, `bun install --ignore-scripts`, and
  `bun install --backend=copyfile` hang or exit early in this worktree, leaving
  an incomplete `node_modules/.bun` store. This blocks full local `bun run
  verify` until the dependency tree is repaired.
- Targeted checks still work when their dependency subset exists. Verified
  today: `bun run biome check packages\scripts\run-turbo.mjs`, `node
  packages\scripts\run-turbo.mjs --version`, and a targeted Turbo build of
  `@elizaos/logger`.
- Hardware/prod-only lanes remain genuinely gated from this computer unless the
  corresponding device, cloud credentials, or operator approval are available.

## Active PR queue to watch or review

| PR | Base | Status | Related issues | Action |
| --- | --- | --- | --- | --- |
| #10029 `codex/fix/remove-dead-core-plugin-map` | develop | open | #9941 | Review dead plugin-map removal and targeted tests. |
| #10028 `fix/launcher-swipe-pointer-capture` | develop | open | #9967 | Review Android WebView pointer-capture fix and app evidence. |
| #10027 `codex/fix-9942-9944` | develop | draft | #9942, #9944 | Leave draft until capture helpers and gates are ready. |
| #10025 `docs/issue-board-triage-2026-06-29` | develop | this triage artifact | #8434 | Keep current as issues/PRs move. |
| #10024 `feat/tui-settings-voice-views` | develop | open | #9946, #9969, #9958 | Review terminal view coverage and evidence. |
| #10022 `codex/fix/remote-plugin-bridge-validation` | develop | locally validated | #9940 | Merge only after CI is allowed to complete. |
| #10020 `chore/purge-deleted-plugin-refs` | develop | conflict/dirty | #9941 | Rebase or supersede before review. |
| #10019 `fix/develop-workflow-followups` | develop | locally validated | #9626 | Merge only after CI is allowed to complete. |
| #10018 `fix/xr-sim-rolldown-react-ci` | develop | open | #9968 | Review CI unblock for XR harness. |
| #10017 `fix/9991-review-followup` | develop | approved, CI blocked | #9943 | Merge when checks are allowed to complete. |
| #10016 `fix/9965-domain-topology` | develop | open | #9965 | Rebase/review domain-link changes; merge when green. |
| #10007 `nubs/iac-userorg-lifecycle-invalidation` | perf branch | open | #8434, #9853, #9899 | Review after #9981 stabilizes. |
| #9981 `perf/iac-hotpath-prod-port` | main | open | #8434, #9899 | Needs auth/security review before prod/main merge. |

## Work ordering

The requested order is easiest first, while still reviewing open PRs when they
unblock easy closures. Immediate queue: quick validation/closure for #9969,
#9966, #9961, #9959, #9957, #9947, #9946, and #9874; low-risk PR review for
#10025, #10029, #10022, #10019, #10017, #10016, and #10018. Middle queue:
#9970, #9955, #9954, #9941, #9940, #9956, #9950, #9949, #9948, #9952, and
#9626. Hard/gated queue: #8434, #9853, #9960, #9963, #9964, #9967, #9968,
#9958, #9953, #9939, #9899, #9880, #9581, #9580, and #9180.

## Issue-by-issue triage

| Issue | Current read | Windows-feasible work | Difficulty | Next action |
| --- | --- | --- | --- | --- |
| #9970 personal-assistant app-usage / PRIORITIZE / scenarios | No progress comments yet. Body calls out app-usage not surfaced, empty-list ranking, and scenarios asserting routing rather than outcomes. | Yes: inspect plugin-personal-assistant plus health/calendar/inbox scenario tests; add deterministic unit/scenario coverage. | Medium | Pick after PR reviews; read plugin-local docs before edits. |
| #9969 TUI whole-app e2e | Latest comments say harness, PR CI lane, real PTY smoke, capture artifacts, and TUI client auth all landed. | Yes: verify merged evidence and close/comment if no remaining scope. | Easy closure | Audit linked PR evidence, then close or ask for explicit remaining scope. |
| #9968 XR deterministic harness | High-confidence IWER harness landed; PR #10018 remains open to unblock XR sim under rolldown-vite and CI. | Yes for headless XR sim and CI; no for real headset validation. | Hard | Review #10018 and merge when green; leave hardware/spatial renderer gaps explicit. |
| #9967 Android launcher native-plugin tests | Device-free wiring gate PR #10004 noted; real Kotlin/device lane remains. | Partial: Node wiring checks from Windows; real emulator/device only if Android stack exists. | Hard/gated | Verify #10004 landed; document emulator/device gap. |
| #9966 Cloud device-code dead close button | Comments say #9971/#9972/#9979 landed the dead-close and developer-gate work. | Yes: review merged UI/auth tests and close if covered. | Easy closure | Cross-check #9961 duplicate and close both if no remaining role-gate gap. |
| #9965 Domain topology | PR #10016 open for app/docs URL and homepage CTA fixes. | Yes: review URLs/docs/native links; no special hardware. | Medium | Two-eyes review #10016; merge when green; comment evidence. |
| #9964 Cloud agent rollback/snapshot/migrations | No progress comments. Requires blue/green swap safety, DB migration up/down, rollback. | Partial: code/tests in cloud services possible; real validation needs staging/cloud access. | Hard | Defer until cloud branch is calm; split into snapshot metadata + rollback tests first. |
| #9963 Full-agent backup/restore | No progress comments. Large local/cloud backup system across DB, media, vault, character. | Yes for local export/import API and tests; cloud restore requires staging/prod proof. | Hard | Design narrow local backup slice before cloud work. |
| #9962 TEE confidential execution | Body says most software groundwork exists; remaining host verdict and hardware verifier are gated. | Mostly no from plain Windows; code consolidation possible, hardware verifier needs TEE host. | Hard/gated | Mark hardware-gated; only do docs/code-home consolidation if not already done. |
| #9961 Cloud login simplification | Comments say work landed and duplicate branch was dropped. | Yes: review merged UI/auth tests and close if #9966 also covered. | Easy closure | Verify no Developer-view residue, then close/comment. |
| #9960 Orchestrator verifiability | PR #10003 landed first CI chunk; remaining live multi-account, timer seams, UI monolith. | Partial: secret-free tests/refactors from Windows; live account CI needs secrets. | Hard | Continue with deterministic timing seams after middle queue. |
| #9959 Home first-time-user state | Comment says #10002 addressed show-once/sunset lifecycle and connector nudge cleanup. | Yes: verify app tests/audit evidence. | Easy closure | Review #10002 evidence; close if merged and complete. |
| #9958 Cross-platform live voice e2e | No progress comments. Requires iOS/Android/Electrobun live mic/ASR/TTS. | Partial: Windows desktop/Electrobun harness only; mobile needs devices/sims. | Hard/gated | Defer; list device requirements and capture gaps. |
| #9957 Tutorial theming/e2e | Comment says #10002 replaced hardcoded orange and added coverage. | Yes: visual audit if app deps work; otherwise review CI artifacts. | Easy closure | Verify #10002 evidence and close if complete. |
| #9956 Retrieval benchmark | No progress comments. Needs precision/recall/latency benchmark and CI gate. | Yes: deterministic benchmark harness can be built on Windows. | Medium | Good middle work after PR reviews. |
| #9955 Chat keyword search | No progress comments. Needs message-content keyword search and jump-to-message. | Yes: API, model, UI, tests; requires app visual evidence. | Medium | Strong next implementation candidate. |
| #9954 Chat UX fuzz/jank | No progress comments. Needs nav interleaving fuzz, real gesture overlay e2e, jank CI. | Yes: unit/e2e tests possible; app audit needed for UI changes. | Medium | Add pure nav fuzz first, then UI e2e. |
| #9953 Desktop chromeless chat bar | No progress comments. Large desktop UX/native tray direction. | Partial on Windows desktop, but broad redesign and cross-platform tray required. | Hard | Defer until medium queue cleared. |
| #9952 First-run in-chat flow | No progress comments. Large onboarding/startup shell UX change. | Yes for web/app code, but needs visual audit and screenshots. | Medium-hard | Sequence after #9959/#9957 closure to avoid overlap. |
| #9950 View e2e/aesthetic gate | Comment says #10008 landed minimal aesthetic density gate; deeper per-view e2e remains. | Yes: Playwright/audit lanes from Windows if deps work. | Medium-hard | Verify #10008, then add one heavy-view e2e chunk. |
| #9949 should-respond security gate | Comments indicate canonical security work landed in #9995, route follow-up in #10015/#10021. | Yes for adversarial tests; live LLM adjudication needs keys. | Medium-hard | Re-read #9995/#10021 and close or define remaining LLM gate. |
| #9948 canonical role model | Comments indicate role/security route work landed through #10015 and #10021. | Yes for role tests and route allowlist; broad role unification may remain. | Medium-hard | Verify merged role model coverage before closing. |
| #9947 embedded-app launch surface | Comments say reachable embed-auth route landed in #10015. | Yes: review route tests and add connector surface if missing. | Medium | Verify #10015; close if launch surface is complete enough. |
| #9946 TUI first-class run mode | Comments say core scope landed: naming, PR lane, whole-app harness, PTY smoke, auth evidence. | Yes: verify evidence; no new code unless a gap appears. | Easy closure | Close/comment after evidence review. |
| #9943 CI coverage does not guarantee tested | #9991 merged; comment notes feed lane red/non-blocking and #10017 follow-up open. | Yes: review #10017 and fix any CI fallout. | Medium | Two-eyes review #10017 now. |
| #9941 Retire hardcoded plugin couplings | No progress comments. Concrete code-search/refactor work. | Yes: Windows grep/refactor/tests. | Medium | Good middle work after #9943/#9965 PR reviews. |
| #9940 Runtime empty-fallback sludge | No direct comments, but #10023 just restored type-safety ratchet. Broad smell-pattern issue. | Yes: incremental audit/refactor/test chunks. | Medium | Start with one validated fallback pattern, not the whole umbrella. |
| #9939 Seamless cloud provision handoff | No progress comments. Requires shared-to-dedicated cloud handoff. | Partial: code/mocks possible; real proof needs cloud staging. | Hard | Defer until cloud launch/perf PRs settle. |
| #9899 Cloud TTFT perf | No progress comments. Root-caused to cloud-api pre-forward overhead. | Partial: profile/code from Windows; real latency proof needs prod/staging. | Hard | Coordinate with #9981/#10007 cloud perf work. |
| #9880 Name-aware wake word | Comments show Linux, Pixel, macOS/iOS tiers and PR #9925 evidence; remaining cross-platform/battery. | Partial: Windows voice path possible; mobile/device proof gated. | Hard/gated | Verify merged evidence; identify Windows-only remaining slice. |
| #9874 Planner confabulation follow-ups | Comments say all three structural follow-ups implemented and verified with video in #9930. | Yes: closure verification only. | Easy closure | Close after confirming PR/evidence links. |
| #9853 Cloud apps hardening | Long audit tracker; many P1/P3 items verified, still GA hardening remains. | Partial: code review/tests possible; staging/prod hardening needs cloud access. | Hard | Coordinate with cloud launch tracker; avoid duplicate work. |
| #9626 Build process audit | Ongoing. This pass opened #10019 for Windows Turbo wrapper fallback. | Yes: incremental build/script fixes from Windows. | Medium | Watch #10019 checks; continue small script/cache slices. |
| #9581 Computer Use x Vision | Comments show many mac/CUDA fixes verified; remaining on-device/cross-platform tuning. | Partial: Windows CUA possible if local device stack exists; many GPU/device gates. | Hard/gated | Treat as hardware-gated unless Windows CUA hardware is available. |
| #9580 On-device inference matrix | Comments show CUDA/RTX verification and training-script cleanup; remaining backend matrix/training. | Mostly hardware/training gated. | Hard/gated | No plain-Windows closure; document hardware needs. |
| #9180 pgbouncer tenant DB rollout | Comments repeatedly mark it pure operator rollout, no code deliverable. | No, unless operator prod access is granted. | Blocked ops | Leave open for operator or close if ops completed externally. |
| #8434 Cloud 10-user launch tracker | Active coordination. Latest comments discuss #10017, #9981, #10007, prod-cutover auth. | Partial: review PRs and verify logs; prod launch needs cloud/phone agents. | Hard | Review #9981/#10007 after CI and auth review; keep comments coordinated. |
