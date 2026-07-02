# Leg W6 — on-device model lifecycle (#10727) + voice self-test honesty (#10726) + CI bun pin (#11184/#9454)

Branch `feat/ui-mobile-gap-burndown` (worktree `ui-mobile-wave3`, base develop `5471346e7a6`,
verified against origin/develop tip `dc1a63b1038` on 2026-07-02).
Wave 3 leg W6. Evidence root: this directory.

## Research inventory (findings BEFORE code changes, 2026-07-02)

### #10727 — lifecycle matrix state at develop tip

- **PR #11203 (merged) postdates this worktree's base.** It extracted the remote probes
  into `src/services/lifecycle-remote-checks.ts` (downloader-parity auth header,
  HEAD→ranged-GET fallback, 429/5xx retry→`warn`) and slimmed
  `scripts/local-model-lifecycle-matrix.ts` to consume it. This leg adopted the
  develop-tip bytes of those files first (verified byte-identical via
  `git show origin/develop:... | diff`) and layered the reconciliation on top.
- **The thread's named next slice** (issue #10727, lalalune 2026-07-02 05:51 comment,
  ops checklist item A3): two "expected but not advertised" row classes were
  mis-attributed as `implemented: fail`:
  - `eliza-1-2b:embedding` — the 2b `TierSpec` in
    `packages/shared/src/local-inference/catalog.ts` deliberately has no `hasEmbedding`;
    the shipped product serves `TEXT_EMBEDDING` on every tier from the gte-small preset
    (`plugins/plugin-local-inference/src/runtime/embedding-presets.ts`, 384-dim
    `gte-small_fp16.gguf`, exact match to plugin-sql's dim384 column), not from a
    per-tier bundle GGUF. The checklist offered "publish the 2b artifact **or** record
    the product decision" — no HF write access here and the runtime already embodies the
    decision, so this leg records it in the matrix.
  - `eliza-1-*:mtp` (all 5 tiers) — the catalog documents the exact source path
    (`bundles/<tier>/mtp/drafter-<tier>.gguf`) and gates advertisement on
    `ELIZA_1_HOSTED_MTP_TIER_IDS` (currently `[]`) because the Gemma drafters are not
    hosted (`candidates/gemma-2b-base-v1/mtp/MISSING.txt`). That is a **publish gap**,
    not an implementation gap — the same class as the pending 9b/27b text tiers.
- **Mis-attribution mechanics** (`src/services/local-model-lifecycle-matrix.ts`):
  `expectedComponentsForModel()` puts `embedding` in the baseline set for every tier and
  `mtp` for every `ELIZA_1_MTP_TIER_IDS` tier; `implementedCheck()` then failed any
  expected component without a catalog source file, making a deliberate catalog gate and
  a genuinely-missing implementation indistinguishable.
- **Upstream drift observed while capturing evidence**: the 2b/4b bundle manifests have
  been republished — `matrix-before-reconcile.md` (fresh run, this host) shows
  `bundleClosure: pass (21/24 manifest files)` for 2b/4b, so ops items A1/A2 from the
  05:51 checklist are done on HF. The `.litertlm` 404s and 9b/27b absent bundles remain.

### #10727 — reconciliation implemented (still honest — no gap turns green)

- New `knownGap?: { kind, reason }` on `LocalModelLifecycleArtifact`, computed from
  catalog data in `knownGapFor()` (never hardcoded per-model):
  - `publish-pending` (mtp rows): `implemented: pass` (runtime seam + documented path),
    `published`/`downloadable`/`deployable`: **fail** with the real reason
    (drafter not hosted; gated by `ELIZA_1_HOSTED_MTP_TIER_IDS`), row `publishStatus`
    forced `pending` so it counts in `pendingPublishRows`. Row stays a failing row.
  - `served-by-alternate-runtime` (embedding rows on tiers with no bundle embedding):
    every artifact check reports `skipped` with the recorded product decision naming the
    serving preset. No blockers on the row.
  - Genuinely missing components (e.g. a tier without `asr`) still `implemented: fail` —
    pinned by a regression test.
- `--load-run` lane (`src/services/lifecycle-loadrun.ts` + matrix `loadRunChecks`):
  loads each installed curated model through the production coordinator
  (`localInferenceService.setActive`) and decodes through the real FFI engine
  (`generateInConversation`, exact `output_tokens` from the backend usage block — not a
  length estimate), recording load ms, decode tok/s, and the probed accelerated backend
  into `loadsAndRunsOnDevice` (supersedes trust-in-`bundleVerifiedAt`).

### #10727 — NEW FINDING from the real M4 download→load→run leg (2026-07-02)

**The published 2b bundle cannot be activated by the production path.** The fresh HF
download completed (7.35 GB bundle, text GGUF sha256 `e049411c…`, manifest version
`0.0.1-local.1-gemma4`), but `localInferenceService.setActive` → `assertManifestEvalsPassed`
refuses it: the published `bundles/2b/eliza-1.manifest.json` ships **every**
`evals.*.passed=false` with zero/placeholder metrics (textEval score 0, wer 1, rtf 0, …).
That is the #7679 candidate gate working exactly as designed — but it means the shipped
first-run default tier is candidate-gated in production. Direct FFI diagnostic (gate
bypassed for diagnosis only) proves the **weights are good**: `general.architecture=gemma4`,
36/36 layers offloaded to Metal, correct answers ("The capital of France is Paris.",
correct Rayleigh-scattering explanation), warm decode ≈ **108 tok/s (length-estimated)**
on this M4 Max. → The unblock is publisher-side: run the evals and flip the manifest
`evals` block on HF (same publish-gate class as the ops checklist), or the 2b bundle
stays download-clean but activation-dead. Secondary finding: the fused backend's usage
block reports `completion_tokens` from the MTP acceptance counter (0 with no drafter
hosted), so exact decode-token counts are unavailable on the non-MTP path — the load-run
lane falls back to the engine's own length-estimate convention and flags it.

### #10726 — voice self-test honesty

- **The pass-on-provider-error hole (verified in source):** the SEND stage passed on
  `send.completed && reply.length > 0`. On provider failure the server substitutes a
  synthetic reply — canonical strings + kinds in `packages/agent/src/api/chat-routes.ts`
  (`classifySyntheticChatFailureText`, `PROVIDER_ISSUE_CHAT_REPLY`, …) and
  `packages/core/.../recentMessages.ts` (`SYNTHETIC_ASSISTANT_FAILURE_TEXTS/KINDS`).
  The SSE done event already carries `failureKind?: ChatFailureKind` and
  `localInference?: LocalInferenceChatMetadata` (returned by
  `ElizaClient.sendConversationMessageStream`) — the harness read neither, so a run
  whose provider 500'd reported `send: pass`.
- **Fix shipped:** `packages/ui/src/voice/voice-selftest/error-fallback-reply.ts`
  (client-side mirror of the canonical strings, source pointers in-file, every string
  pinned by tests); the SEND stage now fails on the structured `failureKind` FIRST, then
  on a recognized fallback text, and records the serving backend
  (`local-inference:<model id>` from the SSE metadata, else `remote-provider`) in stage
  detail + report (`sendBackend`).
- **Voice-path attribute-inference gap** (issue comment 2026-07-01: "my sister Joan"
  and "John from accounting" not extractable on the voice path; `works_at` existed only
  in the text pipeline): fixed in the entity parser
  (`plugins/plugin-personal-assistant/src/lifeops/entities/voice-attribution.ts` +
  `voice-observer.ts`):
  - kin claims generalized: `extractKinClaim` covers partner AND sibling labels →
    `partner_of` / `sibling_of` edges through the same eager-resolve/pending-queue
    machinery (open-string relationship types are supported by the shared registry);
  - self-affiliation claims (`extractSelfAffiliationClaim`: "I'm John from the
    accounting team", "I work at Acme") bind the SPEAKING entity to a match-or-created
    `organization` entity via `works_at` on the same turn, with a plausibility gate so
    "I'm Jill with the long hair" cannot mint an org (pinned by test). Matches the
    seeded workbench scenario `confusable-names-clean` turn
    ("Eliza I am John from the accounting team").

### #11184 / #9454 (lockfile half) — CI bun pin

- Literal `bun-version: "canary"` at `setup-bun-workspace` call sites: **7 sites in 4
  workflows** — `ci.yaml` (4), `benchmark-tests.yml` (1), `feed-env-audit.yml` (1),
  `windows-desktop-preload-smoke.yml` (1). All pinned. `release.yaml:116` also pins
  canary but through raw `oven-sh/setup-bun` (not the workspace action) — left alone,
  listed here. `test.yml` (hosts W1's WebKit lane) and `scenario-pr.yml` pin via
  `env.BUN_VERSION` and were **not touched**.
- **Deviation from the literal gap text, verified live this session:**
  `package.json#packageManager` is `bun@1.4.0-canary.1`, which is unresolvable —
  GitHub release tag `bun-v1.4.0-canary.1` → HTTP 404, `npm view bun@1.4.0-canary.1` →
  E404. Pinning workflows to that string would hard-fail setup on every lane. The
  committed `bun.lock` is `lockfileVersion: 1` (floating canary writes v2 — the exact
  frozen-lockfile failure in #11184) and was authored by stable bun `1.3.14`
  (`bun --version` here = 1.3.14; `bun-v1.3.14` release exists, npm `bun` latest =
  1.3.14). Pinned the 7 sites to `"1.3.14"` with an in-line comment. Follow-up (outside
  this leg's ownership): move `packageManager` itself off the phantom canary string.

## Artifacts

| Artifact | What it proves |
| --- | --- |
| `matrix-before-reconcile.md` | Fresh darwin-arm64 run of the pre-change (develop-tip) code with `--check-remote`: 2b-embedding + 5 MTP rows mis-attributed `implemented: fail`; 26 failing rows / 21 pending-publish |
| `matrix-darwin-arm64.md` / `.json` | Same host + flags on the reconciled code (+ `--load-run` where installed): MTP rows attributed to publish (`pendingPublishRows` includes them), 2b-embedding row `skipped (served-by-alternate-runtime)` |
| `loadrun-darwin-arm64-metal.log` | The real download→load→run: production Downloader fetched the advertised 2b bundle fresh from HF (7.35 GB, terminal state=completed); production activation HONESTLY REFUSED (candidate-gated manifest, recorded in the matrix row); direct FFI diagnostic proves the weights decode correctly on Metal (36/36 layers offloaded, ≈108 tok/s warm) |
| `unit-tests.log` | vitest runs: plugin-local-inference full suite, PA entities suites, UI voice suites |
| N/A — Android/iOS/CUDA/Vulkan/ROCm load-run rows | Gated: no such device/GPU on this host; the Pixel 6a + iPhone legs are owned by parallel lanes per the #10727 thread (their evidence is on the issue). The matrix reports those rows `skipped`/`unknown` — never `pass` |
| N/A — live agent-server voice self-test run | The SEND-honesty change is exercised by unit tests pinning the real harness function + the canonical server strings; the in-app `?shellMode=voice-selftest` e2e lanes (web/android/desktop) run this same harness in CI |
