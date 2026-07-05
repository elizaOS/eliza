# #13415 — cloud-shared fallback sweep slice 9: vertex / video-gen / waifu

vertex-model-registry, vertex-tuning, video-generation-reconcile, waifu-webhook.
Verified untouched at file level before starting.

## Findings (all already fail-closed — annotations + tests only)
- **vertex-model-registry** — no source change; no try/catch/console/parseFloat; every dbRead/dbWrite/remote call propagates uncaught. Pinned by test.
- **vertex-tuning** — `// error-policy:J1` on the gcloud-token optional-source catch (auth boundary throws a structured "No Google access token available" below); fetch handlers already check `.ok` and throw with status+body.
- **video-generation-reconcile** (MONEY path) — `// error-policy:J1` comment on the provider status-probe catch (already money-safe: a probe failure = UNKNOWN → keeps the hold, never refunds blind). Uses `Number()+isFinite` (strict). `reconcile`/`refundCredits`/`recon:<txid>:refund` idempotency arithmetic left untouched (money-path-flagged).
- **waifu-webhook** (MONEY/webhook path) — `// error-policy:J1/J3` on the SSRF-guard + transport catches and the URL-parse guard; `receiverPath()` money-routing fallback left untouched (money-path-flagged).

## Verification
15 new error-path `bun:test` suites pass under `--isolate`, proving internal-failure PROPAGATES vs designed-empty stays distinguishable, driving the real exported functions. Source edits are comment-only annotations (verified: every added line is an `// error-policy:` comment) so no behavior changes. The pre-existing `__tests__/video-generation-reconcile.test.ts` PGlite test FALSE-fails only in a bare run without the CI-provisioned DB — confirmed it fails identically with my changes stashed (environmental, unrelated).

## N/A
UI/model-trajectory/audio — N/A (server model/media/webhook services). Runtime traces — N/A - comment-only annotations + unit-boundary error-path coverage.
