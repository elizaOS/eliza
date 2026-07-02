# #10727 — Local-model lifecycle matrix, Linux re-verification (2026-07-02)

Fresh run of `bun run --cwd plugins/plugin-local-inference lifecycle:matrix -- --check-remote`
on linux-x64 (CUDA host), probing `https://huggingface.co/elizaos/eliza-1` directly
(unauthenticated public path, `viaCloud=false`). Every failing row below was
adversarially re-verified with `curl -sI` against the resolve URLs and against the
full repo tree (`/api/models/elizaos/eliza-1/tree/main?recursive=true`, 401 files,
no pagination).

**Headline: the 2026-07-01 darwin evidence overstated the publish gaps.** Two of its
blocker classes were tool/staleness artifacts, not missing files. The remaining
failures are real, and most of them are expected fallout of the in-flight
**Qwen→Gemma migration** of the HF repo.

## Tool bugs found and fixed (this PR)

1. **Remote checks probed without the downloader's auth header.** The production
   downloader (`downloader.ts`) sends `resolveHfDownloadBase().authHeader` — on a
   cloud-linked host every catalog URL routes through the Eliza Cloud HF proxy,
   which requires that bearer. The matrix script probed the same URLs with **no**
   header, so any cloud-linked host reports false 401/404 "publish gaps".
   Fixed: checks now mirror the downloader's request shape exactly
   (`lifecycle-remote-checks.ts`, unit-tested).
2. **Transient HTTP statuses (429 rate-limit, 5xx) were reported as `fail`.** With
   ~90 sequential probes per run, rate limiting is routine — and mid-migration it
   must not read as "unpublished". Fixed: 429/5xx retry with backoff
   (Retry-After respected, capped) and degrade to `warn` (inconclusive), never
   `fail`. Bundle closure now distinguishes `fail` (definitive 404s) from `warn`
   (only-transient probes).
3. Remote-check logic moved out of the script into a testable service module
   (`src/services/lifecycle-remote-checks.ts`) with injected fetch/sleep;
   10 new unit tests cover auth parity, HEAD→ranged-GET fallback, 404 fail,
   429→warn, 5xx recovery, and bundle fail/warn/pass classification.

## Darwin evidence (2026-07-01) vs verified reality

| Darwin claim | Verified reality (curl + tree, 2026-07-02) |
| --- | --- |
| `2b/4b voice` downloadable 404 | **Stale catalog in that run**, since fixed on develop: it probed `tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf` (never existed). Current catalog points at `bundles/{2b,4b}/tts/kokoro/kokoro-82m-v1_0.gguf` → **HTTP 302→200, passes**. |
| `4b` bundle closure 12/24 failing | **3/24.** Nine `bundles/4b/tts/kokoro/voices/*.bin` 404s from that run all resolve now (present in the tree). |
| `2b` bundle closure 2/22 failing | Confirmed — see real gaps below. |
| 9b/27b/27b-256k pending + manifest 404 | Confirmed — no `bundles/{9b,27b,27b-256k}/` directory exists on HF at all (migration-in-flight). |

## Non-LLM lanes verified GREEN on HF (curl `-sI`, all 302→CDN)

Voice sub-models at repo root: `voice/wakeword/hey-eliza.{melspec,embedding,classifier}.gguf`,
`voice/speaker-encoder/wespeaker-resnet34-lm.gguf`, `voice/diarizer/pyannote-segmentation-3.0.gguf`,
`voice/turn-detector/intl/turn-detector-intl-q8.gguf`, `voice/turn-detector/onnx/turn-detector-en-q8.gguf`,
`voice/voice-emotion/wav2small-msp-dim-int8.gguf`, `voice/vad/silero-vad-v5.1.2.ggml.bin`,
`voice/embedding/eliza-1-embedding-q8_0.gguf`, `voice/asr/eliza-1-asr-*.gguf` + mmproj.
Per-tier (cut Gemma tiers 2b/4b): `asr/mmproj-audio-{2b,4b}-bf16.gguf`,
`vision/mmproj-{2b,4b}.gguf`, `vad/silero-vad-v5.gguf`, `tts/kokoro/kokoro-82m-v1_0.gguf`,
`bundles/4b/embedding/eliza-1-embedding.gguf`. Pinned-revision URLs in
`voice-models.ts` also resolve (spot-checked wakeword@c544bb4c, turn-detector-intl@e7ef6204).
**No catalog or voice-models path fixes were needed — all advertised non-LLM paths are correct.**

## Real publish gaps (ops checklist)

Requires write access to HF `elizaos/eliza-1` (release-publish pipeline owners).

### A. Genuinely missing / stale — non-LLM (fix independently of the migration)

- [ ] `bundles/2b/eliza-1.manifest.json` references two files that do not exist
      (verified 404): `tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf` (actual hosted file
      is `tts/kokoro/kokoro-82m-v1_0.gguf`, no `-Q4_K_M` suffix) and
      `vad/silero-vad-int8.onnx` (ONNX deliberately removed from bundles).
      → Re-publish a corrected 2b manifest (rename the kokoro entry, drop the onnx entry).
- [ ] `bundles/4b/eliza-1.manifest.json` — same two entries plus
      `tts/kokoro/model_q4.onnx` (404; the 2b bundle has it, 4b does not).
      → Re-publish a corrected 4b manifest.
- [ ] `bundles/2b/embedding/eliza-1-embedding.gguf` absent (404); 4b hosts it
      (639,150,592 bytes) and `voice/embedding/eliza-1-embedding-q8_0.gguf`
      (identical size) exists as a source. → Either publish the 2b copy + manifest
      entry + set `hasEmbedding` for 2b in the catalog, or record the product
      decision that the 2b tier has no local embedding.

### B. Blocked on the Qwen→Gemma republish (LLM lane — do not pin to Qwen names)

- [ ] `bundles/9b/`, `bundles/27b/`, `bundles/27b-256k/` do not exist on HF
      (whole-tier absence, manifest 404). Catalog correctly marks these tiers
      `pending` until the Gemma-4 fine-tunes are staged and pass the
      text-architecture provenance gate. 21 matrix rows blocked here.
- [ ] LiteRT-LM mobile bundles `bundles/{2b,4b}/text/eliza-1-{2b,4b}.litertlm`
      (verified 404) — the Gemma QAT `.litertlm` artifacts have never been
      uploaded; catalog `wna8o8` variant stays `planned`.
- [ ] Gemma MTP drafters `bundles/<tier>/mtp/drafter-<tier>.gguf` — not hosted
      anywhere (only `candidates/gemma-2b-base-v1/mtp/MISSING.txt`); catalog
      correctly keeps `ELIZA_1_HOSTED_MTP_TIER_IDS` empty, so 5 mtp rows fail
      "expected but no catalog source" until the drafters are published.

### Row accounting (37 rows)

- **11 rows now download-clean** on this host (2b/4b text, voice, asr, vad,
  vision, 4b embedding) — their only remaining blocker is the stale-manifest
  bundle-closure item A above (plus per-host install/run evidence, `unknown`
  off-device).
- **2 rows** (2b/4b litert): B — `.litertlm` never uploaded.
- **1 row** (2b embedding): A/product call.
- **5 rows** (mtp × 5 tiers): B — Gemma drafters unpublished.
- **21 rows** (9b/27b/27b-256k × 7 components): B — whole tiers pending Gemma republish.
- Darwin-only "voice 404" and "4b 12/24" blockers: **not real** (10 false
  blocker instances removed by re-verification; see table above).

The Pixel 6a on-device row (installed/load-run evidence) is being captured by a
parallel lane and is intentionally absent here (this host has no bundle installed,
so those columns stay `unknown`/`skipped` — honest).

## Fresh matrix (post-fix run, linux-x64, direct HF)

# Local Model Lifecycle Matrix (#10727)

Observed: 2026-07-02T05:47:48.790Z
Host: linux-x64, RAM 30.7 GB, GPU cuda, expected backend cuda

## Summary

- Rows: 37
- Failing rows: 37
- Rows with unknown evidence: 37
- Installed rows: 0
- On-device verified rows: 0
- Pending publish rows: 21

## Matrix

| Model | Component | Publish | Download | Bundle | Installed | Load/run | Backend | Blockers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| eliza-1-2b | text | pass: tier publish status is published | pass: HTTP 200 OK | fail: 2/22 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cpu (CPU allowed) | bundleClosure: 2/22 manifest file(s) failed remote checks |
| eliza-1-2b | voice | pass: tier publish status is published | pass: HTTP 200 OK | fail: 2/22 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cpu (CPU allowed) | bundleClosure: 2/22 manifest file(s) failed remote checks |
| eliza-1-2b | asr | pass: tier publish status is published | pass: HTTP 200 OK | fail: 2/22 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cpu (CPU allowed) | bundleClosure: 2/22 manifest file(s) failed remote checks |
| eliza-1-2b | vad | pass: tier publish status is published | pass: HTTP 200 OK | fail: 2/22 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cpu (CPU allowed) | bundleClosure: 2/22 manifest file(s) failed remote checks |
| eliza-1-2b | embedding | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | fail: 2/22 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cpu (CPU allowed) | implemented: embedding is expected but has no catalog source file; deployable: embedding is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact; bundleClosure: 2/22 manifest file(s) failed remote checks |
| eliza-1-2b | vision | pass: tier publish status is published | pass: HTTP 200 OK | fail: 2/22 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cpu (CPU allowed) | bundleClosure: 2/22 manifest file(s) failed remote checks |
| eliza-1-2b | litert | pass: tier publish status is published | fail: HTTP 404 Not Found | fail: 2/22 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cpu (CPU allowed) | downloadable: HTTP 404 Not Found; bundleClosure: 2/22 manifest file(s) failed remote checks |
| eliza-1-2b | mtp | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | fail: 2/22 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cpu (CPU allowed) | implemented: mtp is expected but has no catalog source file; deployable: mtp is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact; bundleClosure: 2/22 manifest file(s) failed remote checks |
| eliza-1-4b | text | pass: tier publish status is published | pass: HTTP 200 OK | fail: 3/24 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | bundleClosure: 3/24 manifest file(s) failed remote checks |
| eliza-1-4b | voice | pass: tier publish status is published | pass: HTTP 200 OK | fail: 3/24 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | bundleClosure: 3/24 manifest file(s) failed remote checks |
| eliza-1-4b | asr | pass: tier publish status is published | pass: HTTP 200 OK | fail: 3/24 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | bundleClosure: 3/24 manifest file(s) failed remote checks |
| eliza-1-4b | vad | pass: tier publish status is published | pass: HTTP 200 OK | fail: 3/24 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | bundleClosure: 3/24 manifest file(s) failed remote checks |
| eliza-1-4b | embedding | pass: tier publish status is published | pass: HTTP 200 OK | fail: 3/24 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | bundleClosure: 3/24 manifest file(s) failed remote checks |
| eliza-1-4b | vision | pass: tier publish status is published | pass: HTTP 200 OK | fail: 3/24 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | bundleClosure: 3/24 manifest file(s) failed remote checks |
| eliza-1-4b | litert | pass: tier publish status is published | fail: HTTP 404 Not Found | fail: 3/24 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | downloadable: HTTP 404 Not Found; bundleClosure: 3/24 manifest file(s) failed remote checks |
| eliza-1-4b | mtp | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | fail: 3/24 manifest file(s) failed remote checks | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | implemented: mtp is expected but has no catalog source file; deployable: mtp is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact; bundleClosure: 3/24 manifest file(s) failed remote checks |
| eliza-1-9b | text | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-9b | voice | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-9b | asr | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-9b | vad | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-9b | embedding | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-9b | vision | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-9b | mtp | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | implemented: mtp is expected but has no catalog source file; deployable: mtp is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b | text | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b | voice | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b | asr | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b | vad | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b | embedding | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b | vision | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b | mtp | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | implemented: mtp is expected but has no catalog source file; deployable: mtp is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b-256k | text | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b-256k | voice | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b-256k | asr | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b-256k | vad | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b-256k | embedding | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b-256k | vision | fail: tier publish status is pending | fail: tier publish status is pending | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | published: tier publish status is pending; downloadable: tier publish status is pending; bundleClosure: manifest unavailable: HTTP 404 Not Found |
| eliza-1-27b-256k | mtp | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | fail: manifest unavailable: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | cuda | implemented: mtp is expected but has no catalog source file; deployable: mtp is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact; bundleClosure: manifest unavailable: HTTP 404 Not Found |

## Blockers

- eliza-1-2b:text: bundleClosure: 2/22 manifest file(s) failed remote checks
- eliza-1-2b:voice: bundleClosure: 2/22 manifest file(s) failed remote checks
- eliza-1-2b:asr: bundleClosure: 2/22 manifest file(s) failed remote checks
- eliza-1-2b:vad: bundleClosure: 2/22 manifest file(s) failed remote checks
- eliza-1-2b:embedding: implemented: embedding is expected but has no catalog source file
- eliza-1-2b:embedding: deployable: embedding is expected but has no catalog source file
- eliza-1-2b:embedding: published: catalog does not advertise a hosted artifact for this component
- eliza-1-2b:embedding: downloadable: no download URL exists for this artifact
- eliza-1-2b:embedding: bundleClosure: 2/22 manifest file(s) failed remote checks
- eliza-1-2b:vision: bundleClosure: 2/22 manifest file(s) failed remote checks
- eliza-1-2b:litert: downloadable: HTTP 404 Not Found
- eliza-1-2b:litert: bundleClosure: 2/22 manifest file(s) failed remote checks
- eliza-1-2b:mtp: implemented: mtp is expected but has no catalog source file
- eliza-1-2b:mtp: deployable: mtp is expected but has no catalog source file
- eliza-1-2b:mtp: published: catalog does not advertise a hosted artifact for this component
- eliza-1-2b:mtp: downloadable: no download URL exists for this artifact
- eliza-1-2b:mtp: bundleClosure: 2/22 manifest file(s) failed remote checks
- eliza-1-4b:text: bundleClosure: 3/24 manifest file(s) failed remote checks
- eliza-1-4b:voice: bundleClosure: 3/24 manifest file(s) failed remote checks
- eliza-1-4b:asr: bundleClosure: 3/24 manifest file(s) failed remote checks
- eliza-1-4b:vad: bundleClosure: 3/24 manifest file(s) failed remote checks
- eliza-1-4b:embedding: bundleClosure: 3/24 manifest file(s) failed remote checks
- eliza-1-4b:vision: bundleClosure: 3/24 manifest file(s) failed remote checks
- eliza-1-4b:litert: downloadable: HTTP 404 Not Found
- eliza-1-4b:litert: bundleClosure: 3/24 manifest file(s) failed remote checks
- eliza-1-4b:mtp: implemented: mtp is expected but has no catalog source file
- eliza-1-4b:mtp: deployable: mtp is expected but has no catalog source file
- eliza-1-4b:mtp: published: catalog does not advertise a hosted artifact for this component
- eliza-1-4b:mtp: downloadable: no download URL exists for this artifact
- eliza-1-4b:mtp: bundleClosure: 3/24 manifest file(s) failed remote checks
- eliza-1-9b:text: published: tier publish status is pending
- eliza-1-9b:text: downloadable: tier publish status is pending
- eliza-1-9b:text: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-9b:voice: published: tier publish status is pending
- eliza-1-9b:voice: downloadable: tier publish status is pending
- eliza-1-9b:voice: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-9b:asr: published: tier publish status is pending
- eliza-1-9b:asr: downloadable: tier publish status is pending
- eliza-1-9b:asr: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-9b:vad: published: tier publish status is pending
- eliza-1-9b:vad: downloadable: tier publish status is pending
- eliza-1-9b:vad: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-9b:embedding: published: tier publish status is pending
- eliza-1-9b:embedding: downloadable: tier publish status is pending
- eliza-1-9b:embedding: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-9b:vision: published: tier publish status is pending
- eliza-1-9b:vision: downloadable: tier publish status is pending
- eliza-1-9b:vision: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-9b:mtp: implemented: mtp is expected but has no catalog source file
- eliza-1-9b:mtp: deployable: mtp is expected but has no catalog source file
- eliza-1-9b:mtp: published: catalog does not advertise a hosted artifact for this component
- eliza-1-9b:mtp: downloadable: no download URL exists for this artifact
- eliza-1-9b:mtp: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b:text: published: tier publish status is pending
- eliza-1-27b:text: downloadable: tier publish status is pending
- eliza-1-27b:text: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b:voice: published: tier publish status is pending
- eliza-1-27b:voice: downloadable: tier publish status is pending
- eliza-1-27b:voice: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b:asr: published: tier publish status is pending
- eliza-1-27b:asr: downloadable: tier publish status is pending
- eliza-1-27b:asr: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b:vad: published: tier publish status is pending
- eliza-1-27b:vad: downloadable: tier publish status is pending
- eliza-1-27b:vad: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b:embedding: published: tier publish status is pending
- eliza-1-27b:embedding: downloadable: tier publish status is pending
- eliza-1-27b:embedding: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b:vision: published: tier publish status is pending
- eliza-1-27b:vision: downloadable: tier publish status is pending
- eliza-1-27b:vision: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b:mtp: implemented: mtp is expected but has no catalog source file
- eliza-1-27b:mtp: deployable: mtp is expected but has no catalog source file
- eliza-1-27b:mtp: published: catalog does not advertise a hosted artifact for this component
- eliza-1-27b:mtp: downloadable: no download URL exists for this artifact
- eliza-1-27b:mtp: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b-256k:text: published: tier publish status is pending
- eliza-1-27b-256k:text: downloadable: tier publish status is pending
- eliza-1-27b-256k:text: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b-256k:voice: published: tier publish status is pending
- eliza-1-27b-256k:voice: downloadable: tier publish status is pending
- eliza-1-27b-256k:voice: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b-256k:asr: published: tier publish status is pending
- eliza-1-27b-256k:asr: downloadable: tier publish status is pending
- eliza-1-27b-256k:asr: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b-256k:vad: published: tier publish status is pending
- eliza-1-27b-256k:vad: downloadable: tier publish status is pending
- eliza-1-27b-256k:vad: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b-256k:embedding: published: tier publish status is pending
- eliza-1-27b-256k:embedding: downloadable: tier publish status is pending
- eliza-1-27b-256k:embedding: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b-256k:vision: published: tier publish status is pending
- eliza-1-27b-256k:vision: downloadable: tier publish status is pending
- eliza-1-27b-256k:vision: bundleClosure: manifest unavailable: HTTP 404 Not Found
- eliza-1-27b-256k:mtp: implemented: mtp is expected but has no catalog source file
- eliza-1-27b-256k:mtp: deployable: mtp is expected but has no catalog source file
- eliza-1-27b-256k:mtp: published: catalog does not advertise a hosted artifact for this component
- eliza-1-27b-256k:mtp: downloadable: no download URL exists for this artifact
- eliza-1-27b-256k:mtp: bundleClosure: manifest unavailable: HTTP 404 Not Found
