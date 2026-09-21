# Final text integration candidate

Branch: `codex/final-text-integration-20260920`.
Parents: published text checkpoint `2ea336c2a58` and pinned develop `5356317c263`.
This is local text-demo acceptance, not production release acceptance.

## Changes since the verified text checkpoint

Six new develop commits were fetched and reviewed. Five consolidate tests for Cloud auth/parser/cancellation, Codex provider, personal-assistant agreements and Wi-Fi. The production change is the scheduling fix for anchor offsets crossing midnight; due evaluation and next-fire indexing now share occurrence resolution. The real scheduling suite checks DST, positive/negative offsets, observed/fixed anchors and exactly-once firing.

The sole merge conflict was a test harness option union. Both `channelKeys` and `anchors` were retained, preserving our dispatcher coverage and the new midnight recovery test. No production conflict, prompt change, context reduction or authorization shortcut was introduced.

Published peer branches `ganttnubs` (`bd227d2f52e`) and `nubsDONTDELETEpls` (`e59818bf174`) were unchanged. Earlier source decisions remain in REMOTE-SOURCE-DECISIONS.md and GROUP-CHANNEL-INTEGRATION.md. Uncommitted remote work is preserved and is not claimed integrated. Develop is pinned to the reviewed revision, not continuously chased during acceptance.

## Acceptance checklist

- [x] Preserve and publish prior branch/checkpoint; GitHub branch and tag match `2ea336c2a58`.
- [x] Review six develop deltas and resolve the test-only conflict without dropping either side.
- [x] Scheduling:637 tests pass; Codex provider:10 pass; Cloud affected suites:103 pass; Wi-Fi:29 pass after building the fresh checkout's UI dependency.
- [x] Full root verification after UI dependency build:373 tasks and repository audits passed, session87512 exit0.
- [x] Agreement real-PGlite suite:56/56 passed after build settled, session75918 exit0. Initial concurrent run had55 pass and one transient snapshot failure; isolated case also passed. All logs retained; exact transient cause remains unproven, and no guard was weakened.
- [ ] Start final isolated app and verify source, health and rendered text behavior.
- [ ] Publish final branch/tag and deliver one URL with limitations.

Existing eleven-turn text acceptance and cancellation/acknowledgment checks are documented in TEXT-ACCEPTANCE.md and remain explicitly reused where code is unchanged. Do not repeat paid benchmarks merely to obtain lower timings. Calendar availability's observed five-call/4.971s run remains a known model decision inefficiency; its existing prompt already instructs direct clarification. No universal sub3s claim. Background-memory cost remains separate from foreground calls.

Local evidence root: `/Users/nubs/Documents/ChatGPT/test/eliza-group-channel-integration-20260920/`. Logs prefixed `final-`; final app launchers/state under `final-runtime`. Initial fresh-checkout root/Wi-Fi checks could not resolve unbuilt UI exports; explicit UI build passed55 runtime export checks before reruns. The initial dependency install's optional native-inference download was cancelled; frozen install completed using supported ELIZA_SKIP_FUSED_INFERENCE_SETUP=1. Existing native runtime installation remains untouched.

Voice/native-device QA, actual Discord sends, deployment and protected-branch merging are deferred. Historical build-time request delay remains unproven, and consistent sub3s response time is unachieved. All older demo instances and data remain preserved.
