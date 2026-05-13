---
id: task_00039_audio_player_core_architecture_design_document
name: Audio Player Core Architecture Design Document
category: Workflow and Agent Orchestration
grading_type: hybrid
external_dependency: none
verification_method: rubric
input_modality: text-only
timeout_seconds: 1800
workspace_files:
- source: specs/requirements.yaml
  dest: specs/requirements.yaml
- source: specs/api_contract.json
  dest: specs/api_contract.json
- source: specs/platform_matrix.toml
  dest: specs/platform_matrix.toml
- source: specs/capacity_planning.yaml
  dest: specs/capacity_planning.yaml
- source: config/cache_config.yaml
  dest: config/cache_config.yaml
- source: config/player_defaults.json
  dest: config/player_defaults.json
- source: data/sample_tracks.csv
  dest: data/sample_tracks.csv
- source: docs/architecture_notes.md
  dest: docs/architecture_notes.md
- source: docs/legacy_design_v1.md
  dest: docs/legacy_design_v1.md
- source: benchmarks/cache_perf.json
  dest: benchmarks/cache_perf.json
- source: logs/integration_test_run.log
  dest: logs/integration_test_run.log
- source: tests/queue_test_cases.json
  dest: tests/queue_test_cases.json
- source: deps/Cargo.toml.reference
  dest: deps/Cargo.toml.reference
- source: data/codec_support_matrix.csv
  dest: data/codec_support_matrix.csv
- source: config/state_schema.json
  dest: config/state_schema.json
- source: docs/error_handling_guide.md
  dest: docs/error_handling_guide.md
- source: specs/threading_model.yaml
  dest: specs/threading_model.yaml
- source: data/shuffle_test_vectors.json
  dest: data/shuffle_test_vectors.json
- source: reports/profiling_summary.txt
  dest: reports/profiling_summary.txt
grading_weights:
  automated: 0.55
  llm_judge: 0.45
subcategory: Workflow and Task Scheduling
---
## Prompt

I need a comprehensive design doc pulled together for our audio player core v2.0 rewrite. We're building this in Rust, targeting cross-platform support, and a new engineer starts Monday — so this document needs to serve as the single source of truth they can ramp up from.

Please create `audio_player_core_design.md` covering these areas (structure it however makes sense):

System architecture — the concurrency model, actor/component breakdown, inter-thread communication, and the real-time constraints on the audio decode thread (allocation rules, scheduling, etc.).

Queue management — operations supported, persistence backend, data model. The test cases in the workspace might be useful to reference. Make sure you're clear about which database backend the queue uses vs. the state persistence layer — those are two separate subsystems.

Play modes — sequential, shuffle (pick an algorithm and justify the choice), repeat variants. We have shuffle test vectors in the data directory, mention those.

Playback engine — all the controls (play/pause/stop/prev/next/seek/speed), valid speed range, seek behavior, gapless playback support, and codec details including bitrate and sample rate info for each supported codec (mp3, flac, ogg, wav, aac). There's a codec support matrix in the data directory — pull the numbers from there, but sanity-check every value against the requirements spec because I've seen some weird entries in our spreadsheets. Also spot-check a few tracks from sample_tracks.csv — compute actual bitrate from file_size and duration to verify the codec matrix limits make sense.

Caching layer — strategy selection (justify it using the benchmark data we have, including a concrete comparison against the runner-up strategy with their numbers side by side), max cache size, prefetch behavior, eviction policy.

State persistence — which backend, what gets persisted, schema overview.

Platform compatibility — audio backends per platform, Rust crate mappings, minimum OS versions, and make sure the crate versions are correct for the features we need (especially pipewire support on Linux).

Memory budget — add up every component's memory allocation and produce a table showing where the bytes go. There's a capacity planning doc in the specs directory that has a breakdown. Reconcile those numbers against the performance requirements (specifically max_memory_usage_mb) and explain any apparent discrepancy between the cache size and the memory limit.

For the audio pipeline section, compute how many milliseconds of audio the ring buffer can hold at the default sample rate and channel count. I want to verify we have enough buffering headroom for the callback interval.

Also cover the default configuration values and dependency recommendations — flag anything in the dependency references that looks outdated or needs bumping.

The workspace has a bunch of files — requirements specs, API contracts, platform matrices, capacity planning, configs, architecture notes, older design docs, benchmarks, test data, dependency references, and some logs. Cross-reference them carefully. I know some are probably stale or contradictory, so when you find conflicts, treat `specs/requirements.yaml` and the v2.0 architecture notes as authoritative. Call out any discrepancies so we can clean up the repo later.

Oh — and include a "Known Discrepancies" section at the end cataloging every conflict you spot between files. We need to clean the repo up and it'd save us a lot of time having them all in one place. Also generate a `workspace_audit.json` alongside the design doc with the same discrepancies in structured format — I want to script ticket creation from it. Each entry should have the conflict description, which files disagree, and how you resolved it.

I want a real design document — not just file contents pasted together. Something a senior Rust engineer would actually use as a working reference.

## Expected Behavior

Produce `audio_player_core_design.md` plus `workspace_audit.json` as specified below: synthesize multiple workspace files, resolve contradictions with `specs/requirements.yaml` and v2.0 architecture notes as authoritative, and meet the **Content Requirements** (numeric cross-checks, traps, and deliverables are defined there — no need to repeat them as a second checklist in the prompt above).

### Trap Resolution

**Trap 1 — Cache Size Contradiction:**
- `specs/requirements.yaml` specifies `max_size_mb: 512` for the cache.
- `config/cache_config.yaml` specifies `max_size_mb: 256` and has a comment "Updated 2024-01-15" making it look current.
- **Correct behavior:** The agent should use 512 MB from the authoritative requirements spec and flag the discrepancy with `config/cache_config.yaml`. The design document must state 512 MB as the max cache size.

**Trap 2 — Architecture Model Contradiction:**
- `docs/architecture_notes.md` describes the correct v2.0 actor-based concurrency model using tokio, with trait-based platform abstraction, crossbeam channels, ringbuffers, and real-time audio thread constraints.
- `docs/legacy_design_v1.md` describes a single-threaded design with global mutable state (lazy_static), no async, only mp3 support, and recommends outdated rodio 0.14. It is titled "Audio Player Core Design v1.0" without being marked deprecated.
- **Correct behavior:** The agent should use the architecture from `docs/architecture_notes.md` and either ignore the legacy doc or explicitly note it as outdated/superseded. The design must describe the actor-based model, not the single-threaded approach.

**Trap 3 — Codec Bitrate Unit Mismatch:**
- `data/codec_support_matrix.csv` lists max_bitrate values. Most are in kbps, but AAC appears to be listed as `0.512` (Mbps) instead of `512` (kbps). The column header has no unit.
- **Correct behavior:** The agent should recognize the unit inconsistency and normalize AAC's max bitrate to 512 kbps in the design document, explicitly noting that the CSV had `0.512` as a unit error (Mbps vs kbps).

**Trap 4 — Outdated Dependency Version:**
- `specs/platform_matrix.toml` lists pipewire as a Linux audio backend and specifies `cpal = "0.15"` with a note that v0.15+ is required for pipewire.
- `deps/Cargo.toml.reference` lists `cpal = "0.13"` which does not support pipewire.
- **Correct behavior:** The agent should recommend cpal 0.15+ (or note that the reference Cargo.toml's cpal version is insufficient for pipewire support) and flag this discrepancy.

**Trap 5 — Cache TTL Hours Discrepancy:**
- `specs/requirements.yaml` specifies `ttl_hours: 168` for the cache.
- `config/cache_config.yaml` specifies `ttl_hours: 72`.
- **Correct behavior:** The agent should use 168 hours from the authoritative requirements spec. This discrepancy must be explicitly noted alongside the cache size discrepancy — both come from the same two files and a thorough agent should catch both.

**Trap 6 — FLAC Max Bitrate Discrepancy:**
- `specs/requirements.yaml` specifies FLAC `max_bitrate_kbps: 9216`.
- `data/codec_support_matrix.csv` lists FLAC max_bitrate as `9126` (transposed digits — a data entry error).
- **Correct behavior:** The agent should catch this discrepancy when cross-referencing the codec matrix against the requirements spec (as instructed in the prompt), use the authoritative value 9216, and flag the CSV error. This is a subtle data quality issue that requires careful per-codec comparison.

**Trap 7 — Memory Budget vs Cache Size Apparent Contradiction:**
- `specs/requirements.yaml` specifies `max_memory_usage_mb: 128` in performance requirements.
- The cache is configured for 512 MB, which appears to exceed the memory limit by 4×.
- `specs/capacity_planning.yaml` clarifies that the 512 MB cache is ON-DISK storage while the 128 MB limit refers to heap/RAM allocations only. The in-memory LRU index is only ~0.8 MB.
- **Correct behavior:** The agent must reconcile these numbers in a memory budget section, explaining that the cache size (512 MB) refers to disk-backed storage and the 128 MB performance limit applies to heap memory. Simply using both numbers without addressing the apparent contradiction is insufficient.

**Trap 8 — Sample Track Bitrate Anomaly:**
- `data/sample_tracks.csv` contains a track "Synthetic Dawn" (MP3 codec) with `file_size_bytes: 14625168` and `duration_ms: 304691`, yielding an actual bitrate of ~384 kbps — exceeding the MP3 max of 320 kbps per the codec matrix and requirements spec.
- **Correct behavior:** The agent should identify this data quality issue when cross-validating sample data against codec limits. The track either has an incorrect file size, incorrect codec label, or represents a data entry error.

### Content Requirements

The design doc should read as a synthesized reference (not a paste-up of sources). Cover at least:

1. **Caching:** LRU justified with `benchmarks/cache_perf.json` vs ARC in **one** contiguous table or block: hit rates, lookup latencies, memory overheads, plus **≥4** secondary metrics from that file (e.g. p99 latency, insertion time, prefetch improvement for both). Include eviction times and **≥2** per-pattern hit rates (e.g. sequential/random) in that block **or** one immediately following paragraph that still clearly refers to the same benchmark.

2. **Shuffle & modes:** Fisher-Yates + `data/shuffle_test_vectors.json`; sequential, shuffle, repeat_one, repeat_all.

3. **Platforms & deps:** Five targets per `specs/platform_matrix.toml` (Linux: PipeWire, PulseAudio, ALSA; Android: Oboe + OpenSL ES fallback; etc.); **≥3** of cpal, rodio, oboe-rs, symphonia with platform context; flag cpal 0.13 vs 0.15 / PipeWire.

4. **Codecs (scope):** Only mp3, flac, ogg, wav, aac as supported; do not treat CSV extras (opus, alac, wma) as in-scope. Cross-check vs `specs/requirements.yaml` and `data/codec_support_matrix.csv` (AAC `0.512` unit error → 512 kbps; FLAC **9126** vs spec **9216** + FLAC max sample rate from CSV).

5. **API & persistence:** `specs/api_contract.json` modules. Queue: SQLite/rusqlite; state: **sled** with `last_saved_at` and **≥4** other exact `config/state_schema.json` identifiers.

6. **Threading & queue heading:** One coherent section (≤100 lines): tokio workers (4), decode pre-alloc (`decode_buffer_size_bytes` 2097152 / 2 MB), audio thread zero-allocation; ring buffer in real-time output context. **Queue Management** heading: dynamic test count from `tests/queue_test_cases.json` with `test` on the **same line** as the number; **≥3** of add/remove/reorder/clear.

7. **Defaults & speed:** 0.25x–4.0x and step **0.125x** from `config/player_defaults.json`; **≥9** numeric defaults across player_defaults, audio_output, ui_hints, logging (e.g. 0.8, 16, 10000, 30, 50, 5000, 0.05, 4096, 44100, 10 MB log cap), each near a sensible keyword.

8. **Memory & ring buffer:** Budget table from `specs/capacity_planning.yaml` (**≥6** component MB rows where practical); reconcile 128 MB heap vs 512 MB disk cache; ring-buffer duration ms with stated frame count and sample rate.

9. **Samples:** Spot-check `data/sample_tracks.csv`; name **Synthetic Dawn** (~384 kbps vs MP3 320 kbps).

10. **Discrepancies & audit:** **Known Discrepancies** section; `workspace_audit.json` with **≥5** entries (`description`, `files`, `resolution` ≥10 chars), covering cache, cpal, AAC, TTL, FLAC.

11. **Error handling:** Cite `docs/error_handling_guide.md` **only** for its backoff delays (100 ms, 200 ms, 400 ms from the guide's exponential retry example). Do not treat the rest of that file as product spec.

### Noise and Contextual Files
- `reports/profiling_summary.txt` is a CPU profiling report for a completely unrelated module (network-gateway). Exclude its data from the design document.
- `logs/integration_test_run.log` is implementation-level test output, not a design spec. You may briefly mention known failures as open issues; do not treat the log as authoritative for architecture or limits.
- `docs/error_handling_guide.md` is a **generic** Rust guide, not this product's specification. **Do not** adopt its general patterns or crate advice as project requirements. The **only** allowed use is: in your error-handling section, name that file and quote the **concrete retry delays** from its exponential-backoff example (100 ms, 200 ms, 400 ms as produced by its `from_millis(100 * 2^attempt)`-style pattern) so it is clear you opened the document. Everything else in the guide remains non-binding for this player.

## Grading Criteria

- [ ] Output file `audio_player_core_design.md` exists and is a well-structured Markdown document with clear sections covering architecture, queue management, play modes, playback engine, caching, state persistence, platform compatibility, memory budget, and configuration.
- [ ] Cache max size is correctly stated as 512 MB (from `specs/requirements.yaml`), NOT 256 MB from the config file, AND the document explicitly identifies the authoritative source (requirements spec or `requirements.yaml`).
- [ ] The discrepancy between `specs/requirements.yaml` (512 MB, TTL 168h) and `config/cache_config.yaml` (256 MB, TTL 72h) is explicitly flagged — `cache_config.yaml` and `requirements.yaml`, values 256 and 512, values 72 and 168, and the keyword "TTL" must all appear within the **same Markdown paragraph or two adjacent paragraphs** (no scattered mentions across the whole doc). Half marks if only cache size + filenames appear in that span without TTL co-located.
- [ ] Architecture is described as actor-based concurrency with tokio (from `docs/architecture_notes.md`), NOT the single-threaded model from the legacy v1 design doc.
- [ ] The legacy v1 design document is either ignored or explicitly identified as outdated/superseded.
- [ ] LRU is selected as the cache strategy with ALL six core benchmark numbers from `benchmarks/cache_perf.json` (hit rate, lookup latency, memory overhead for both LRU and ARC) presented in a single comparison block (same paragraph or table). Full marks require the comparison block to also contain at least 4 secondary metrics (from: p99 latency, insertion time, prefetch improvement for both strategies). Half marks require at least 2 secondary metrics in the same block.
- [ ] All five target platforms are covered with their correct audio backends AND Rust crate mappings from `specs/platform_matrix.toml`. All six primary backends (PipeWire, PulseAudio, ALSA for Linux; CoreAudio for macOS/iOS; WASAPI for Windows; Oboe for Android) must be named. Android must also list OpenSL ES as a fallback backend (both Oboe and OpenSL ES required). Linux must include all three backends. At least 3 of the 4 dependency crate names (cpal, rodio, oboe-rs, symphonia) from the platform matrix must be referenced.
- [ ] The cpal version issue is identified — the reference Cargo.toml's cpal 0.13 is insufficient for pipewire support on Linux; cpal 0.15+ is recommended or the discrepancy is flagged.
- [ ] Codec support covers all five formats (mp3, flac, ogg, wav, aac) with precise max_bitrate values matching `specs/requirements.yaml` for at least 3 codecs, plus max_sample_rate values (e.g., 192000 Hz for FLAC, 96000 Hz for WAV/AAC) from `data/codec_support_matrix.csv` for at least 2 codecs.
- [ ] The AAC max bitrate anomaly (0.512 in `data/codec_support_matrix.csv` where other codecs use kbps values) is explicitly identified as a unit error (0.512 Mbps → 512 kbps), not silently corrected.
- [ ] The FLAC max bitrate discrepancy between `data/codec_support_matrix.csv` (9126) and `specs/requirements.yaml` (9216) is identified as a data entry error with transposed digits. Full marks require both the erroneous (9126) and correct (9216) values to appear alongside FLAC's maximum sample rate (192000 Hz) in the same cross-validation context; half marks if both bitrate values co-occur with 'flac' without the sample rate.
- [ ] The document describes the API modules (QueueManager, PlaybackEngine, CacheManager, StateStore) based on the API contract.
- [ ] State persistence backend is correctly identified as sled. Persisted fields must include the `last_saved_at` timestamp plus at least 4 additional field names matching `config/state_schema.json` (current_track_id, queue_position, playback_position_ms, play_mode, shuffle_seed, is_playing), using their exact schema identifiers. Queue persistence is correctly identified as SQLite — the two subsystems are clearly distinguished.
- [ ] Fisher-Yates shuffle algorithm is specified for shuffle mode, and all four play modes (sequential, shuffle, repeat_one, repeat_all) are described.
- [ ] Playback speed range is correctly stated as 0.25x to 4.0x with the configured step increment (0.125x from `config/player_defaults.json`) and a qualifier ('step', 'increment', or 'granularity'), all appearing in the same section alongside the word 'speed.' Half marks if the range bounds and 'speed' co-occur without the step increment.
- [ ] Irrelevant profiling data (network-gateway) is excluded. `docs/error_handling_guide.md` is **not** treated as product spec **except** for citing its concrete backoff delays (100ms, 200ms, 400ms) in the error-handling discussion — the rest of that guide must not be asserted as requirements.
- [ ] The codec support section covers only the five required codecs (mp3, flac, ogg, wav, aac) — opus, alac, and wma from the CSV are excluded as out-of-scope.
- [ ] A dedicated Queue Management section (with a markdown heading) exists, references the exact number of queue test cases from `tests/queue_test_cases.json` (dynamically read; currently 18) with the word "test" on the same line, and names at least 3 of the 4 tested operation types (add, remove, reorder, clear) within the section.
- [ ] The document clearly distinguishes between the queue persistence backend (SQLite) and the state persistence backend (sled) as two separate subsystems.
- [ ] The error-handling discussion names `docs/error_handling_guide.md` and includes at least two of the guide's backoff delays (100ms, 200ms, 400ms — from its exponential retry pattern) within the same 20-line window as "exponential" or "backoff". This is the **only** required use of that file; it does not override `requirements.yaml` or architecture notes.
- [ ] The document discusses the lock-free ring buffer in the context of the audio output thread (real-time audio pipeline).
- [ ] The document includes a memory budget table reconciling component allocations against the 128 MB heap limit, explaining that the 512 MB cache is disk-backed.
- [ ] The ring buffer duration is calculated in milliseconds (~371 ms at 44100 Hz) and stated in the document. Full marks require showing the computation parameters (frame count and sample rate) alongside the result.
- [ ] At least one sample track from `data/sample_tracks.csv` is cross-validated, and the "Synthetic Dawn" bitrate anomaly (~384 kbps exceeding MP3 max 320 kbps) is identified.
- [ ] The anomalous sample track "Synthetic Dawn" is identified by name with a computed bitrate value (~384 kbps) stated alongside the MP3 codec limit.
- [ ] The document includes a dedicated "Known Discrepancies" section (or equivalent heading) listing at least 4 specific file-pair contradictions (e.g., requirements.yaml vs cache_config.yaml, codec CSV vs requirements for FLAC, Cargo.toml vs platform_matrix for cpal, etc.).
- [ ] A `workspace_audit.json` file exists, is valid JSON, and contains at least 5 discrepancy entries covering all 5 conflict topics (cache size, cpal version, AAC bitrate, TTL hours, FLAC bitrate). Each entry must include a "files" array listing the specific conflicting file paths, a conflict description, AND a "resolution" field (exact key name) explaining how the conflict was resolved. Full marks require every entry to have a "resolution" field (≥10 characters) and at least 3 entries whose "files" array references actual workspace file names.
- [ ] The memory budget table includes at least 4 component-level allocations with precise MB values matching `specs/capacity_planning.yaml` (within ±10% tolerance).
- [ ] The output includes a benchmark comparison paragraph containing all four core per-strategy values from `benchmarks/cache_perf.json` within the same paragraph: LRU hit rate (87.3%), LRU avg lookup latency (45 ns), ARC hit rate (89.7%), ARC avg lookup latency (85 ns), PLUS both average eviction times (LRU: 38 ns, ARC: 72 ns) and at least 2 per-access-pattern hit rates (from: LRU sequential 94.1%, ARC sequential 92.3%, LRU random 72.8%, ARC random 81.5%). Full marks require all core values, both eviction times, and ≥2 pattern hit rates in one paragraph. Half marks for the 4 core values only in one paragraph.
- [ ] The document accurately describes the threading model within a single 100-line section: the tokio runtime's worker thread count (4, from `specs/threading_model.yaml`) near "worker" and "tokio"/"runtime", the decode thread's pre-allocated buffer size (2097152 bytes or "2 MB" from `decode_buffer_size_bytes` in threading_model.yaml) near "decode"/"pre-alloc" context, and the audio thread's zero-allocation policy ("zero_alloc"/"zero-alloc"/"zero alloc") — all three elements must co-occur within the same 100-line window.
- [ ] The document references at least 9 precise default configuration values from `config/player_defaults.json` in their correct context — spanning all configuration sections: default volume (0.8), bit depth (16), max queue size (10000), auto-save interval (30s), latency target (50ms), seek step (5000ms), volume step (0.05), buffer size (4096 frames), sample rate (44100 Hz), and log file size limit (10 MB). Each value must appear near its identifying keyword. Full marks for ≥9 matched; half marks for ≥6.
- [ ] The document is coherent — not a raw dump — with substantive coverage of architecture, queue, caching, codecs, platforms, memory, and persistence (automated check uses topic coverage rather than word count or heading tally alone).

## Automated Checks

```python
import os
import re
import json
import csv


def _read_file(path):
    if not os.path.isfile(path):
        return ""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the audio_player_core_design.md output file."""

    output_file = os.path.join(workspace_path, "audio_player_core_design.md")

    results = {
        "file_exists_check": 0.0,
        "cache_size_correct": 0.0,
        "cache_discrepancy_flagged": 0.0,
        "actor_concurrency_model": 0.0,
        "legacy_doc_handled": 0.0,
        "lru_benchmark_justified": 0.0,
        "platform_backends_covered": 0.0,
        "cpal_version_awareness": 0.0,
        "codec_support_comprehensive": 0.0,
        "aac_bitrate_handled": 0.0,
        "api_modules_described": 0.0,
        "state_persistence_design": 0.0,
        "play_modes_section": 0.0,
        "speed_control_range": 0.0,
        "noise_file_excluded": 0.0,
        "queue_management_section": 0.0,
        "error_handling_strategy": 0.0,
        "ringbuffer_audio_thread": 0.0,
        "discrepancy_section_exists": 0.0,
        "workspace_audit_valid": 0.0,
        "document_quality": 0.0,
        "memory_budget_analysis": 0.0,
        "ring_buffer_duration": 0.0,
        "codec_scope_correct": 0.0,
        "queue_vs_state_backends": 0.0,
        "flac_bitrate_crossref": 0.0,
        "sample_data_validated": 0.0,
        "sample_track_anomaly_detected": 0.0,
        "memory_component_breakdown": 0.0,
        "benchmark_numbers_paragraph": 0.0,
        "threading_model_accuracy": 0.0,
        "default_config_values": 0.0,
    }

    if not os.path.isfile(output_file):
        return results

    with open(output_file, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    if len(content.strip()) < 200:
        return results

    results["file_exists_check"] = 1.0

    content_lower = content.lower()
    paragraphs = re.split(r'\n\s*\n', content)

    req_text = _read_file(os.path.join(workspace_path, "specs", "requirements.yaml"))
    platform_text = _read_file(os.path.join(workspace_path, "specs", "platform_matrix.toml"))
    threading_text = _read_file(os.path.join(workspace_path, "specs", "threading_model.yaml"))
    capacity_text = _read_file(os.path.join(workspace_path, "specs", "capacity_planning.yaml"))

    ref_cache_mb = 512
    m = re.search(r'max_size_mb:\s*(\d+)', req_text)
    if m:
        ref_cache_mb = int(m.group(1))

    ref_codec_bitrates = {}
    for match in re.finditer(
        r'-\s*name:\s*(\w+)\s*\n(?:.*\n)*?\s*max_bitrate_kbps:\s*(\d+)', req_text
    ):
        ref_codec_bitrates[match.group(1).lower()] = int(match.group(2))
    if not ref_codec_bitrates:
        ref_codec_bitrates = {"mp3": 320, "flac": 9216, "ogg": 500, "wav": 4608, "aac": 512}

    lru_ref = {
        "hit_rate_percent": 87.3, "avg_lookup_ns": 45,
        "memory_overhead_percent": 2.1, "p99_lookup_ns": 120,
        "avg_insert_ns": 62, "prefetch_improvement_percent": 12.4,
        "avg_eviction_ns": 38, "sequential_hit_rate": 94.1,
        "random_hit_rate": 72.8, "zipf_hit_rate": 91.2,
    }
    arc_ref = {
        "hit_rate_percent": 89.7, "avg_lookup_ns": 85,
        "memory_overhead_percent": 8.7, "p99_lookup_ns": 210,
        "avg_insert_ns": 130, "prefetch_improvement_percent": 14.2,
        "avg_eviction_ns": 72, "sequential_hit_rate": 92.3,
        "random_hit_rate": 81.5, "zipf_hit_rate": 93.1,
    }
    bench_path = os.path.join(workspace_path, "benchmarks", "cache_perf.json")
    try:
        with open(bench_path, "r", encoding="utf-8") as bf:
            bd = json.load(bf)
        if "results" in bd:
            lru_ref.update(bd["results"].get("LRU", {}))
            arc_ref.update(bd["results"].get("ARC", {}))
    except Exception:
        pass

    ref_linux_backends = ["pulseaudio", "alsa", "pipewire"]
    m = re.search(
        r'\[platforms\.linux\].*?backends\s*=\s*\[([^\]]+)\]', platform_text, re.DOTALL
    )
    if m:
        ref_linux_backends = [b.strip().strip('"').lower() for b in m.group(1).split(',')]

    ref_rb_frames = 16384
    m = re.search(r'ring_buffer_capacity_frames:\s*(\d+)', threading_text)
    if m:
        ref_rb_frames = int(m.group(1))
    ref_rb_samples = None
    m = re.search(r'capacity_samples:\s*(\d+)', threading_text)
    if m:
        ref_rb_samples = int(m.group(1))

    ref_workers = 4
    wm = re.search(r'worker_threads:\s*(\d+)', threading_text)
    if wm:
        ref_workers = int(wm.group(1))
    ref_alloc_policy = "zero_allocation"
    apm = re.search(r'allocation_policy:\s*(\w+)', threading_text)
    if apm:
        ref_alloc_policy = apm.group(1).lower()

    ref_sr = 44100
    ref_speed_step = 0.125
    defaults_path = os.path.join(workspace_path, "config", "player_defaults.json")
    try:
        with open(defaults_path, "r", encoding="utf-8") as df:
            dj = json.load(df)
        ref_sr = dj.get("player_defaults", {}).get("sample_rate", 44100)
        ref_speed_step = dj.get("ui_hints", {}).get("speed_step", 0.125)
    except Exception:
        pass

    expected_rb_ms_a = ref_rb_frames / ref_sr * 1000
    expected_rb_ms_b = (ref_rb_samples / 2 / ref_sr * 1000) if ref_rb_samples else None

    ref_mem_components = {}
    for match in re.finditer(r'(\w+):\s*\n\s*allocated_mb:\s*([\d.]+)', capacity_text):
        ref_mem_components[match.group(1).lower()] = float(match.group(2))
    if not ref_mem_components:
        ref_mem_components = {
            "ring_buffer": 0.5, "decode_workspace": 3.0, "resampler_tables": 1.2,
            "codec_state": 0.3, "cache_index": 0.8, "prefetch_buffer": 25.5,
            "queue_metadata": 4.9, "state_db_cache": 4.0, "state_db_wal": 1.0,
            "misc_overhead": 12.0,
        }

    ref_max_sample_rates = {}
    csv_codec_bitrates = {}
    def _codec_max_bitrate_kbps(codec_name: str, br_raw: str):
        br_raw = (br_raw or "").strip()
        if not br_raw:
            return None
        try:
            fv = float(br_raw)
        except ValueError:
            return None
        cn = codec_name.lower()
        if cn.startswith("ogg"):
            cn = "ogg"
        # AAC row uses 0.512 (Mbps-style) while others are kbps integers
        if cn == "aac" and fv < 10:
            return int(round(fv * 1000))
        return int(fv)

    codec_csv_path = os.path.join(workspace_path, "data", "codec_support_matrix.csv")
    try:
        with open(codec_csv_path, "r", encoding="utf-8-sig", newline="") as cf:
            reader = csv.DictReader(cf)
            for row in reader:
                codec_name = row.get("codec", "").lower()
                if codec_name.startswith("ogg"):
                    codec_name = "ogg"
                sr_str = row.get("supported_sample_rates", "")
                if sr_str:
                    rates = [int(r) for r in sr_str.split(";") if r.strip()]
                    if rates:
                        ref_max_sample_rates[codec_name] = max(rates)
                br_raw = row.get("max_bitrate", "")
                kbps = _codec_max_bitrate_kbps(codec_name, br_raw)
                if kbps is not None:
                    csv_codec_bitrates[codec_name] = kbps
    except Exception:
        pass

    anomalous_tracks = []
    sample_csv_path = os.path.join(workspace_path, "data", "sample_tracks.csv")
    try:
        with open(sample_csv_path, "r", encoding="utf-8-sig", newline="") as sf:
            reader = csv.DictReader(sf)
            for row in reader:
                codec = row.get("codec", "").lower()
                fsize = int(row.get("file_size_bytes", 0))
                dur = int(row.get("duration_ms", 0))
                if dur > 0 and codec in ref_codec_bitrates:
                    actual_kbps = fsize * 8 / dur
                    limit = ref_codec_bitrates[codec]
                    if actual_kbps > limit * 1.05:
                        anomalous_tracks.append({
                            "title": row.get("title", ""),
                            "codec": codec,
                            "actual_kbps": round(actual_kbps, 1),
                            "max_kbps": limit,
                        })
    except Exception:
        pass

    cache_str = str(ref_cache_mb)
    found_cache_val = False
    found_cache_src = False
    for para in paragraphs:
        pl = para.lower()
        if (re.search(r'(?<![.\d])' + cache_str + r'\s*(?:mb|megabyte)', pl)
                and re.search(r'\bcach(?:e|ing)\b', pl)):
            found_cache_val = True
            if re.search(r'(?:requirements?\.ya?ml|requirements?\s+spec|authoritative)', pl):
                found_cache_src = True
    if not found_cache_val:
        for para in paragraphs:
            pl = para.lower()
            if (re.search(r'(?<![.\d])' + cache_str + r'(?!\d)', para)
                    and re.search(r'\bcach(?:e|ing)\b', pl)
                    and re.search(r'\b(?:mb|size|capacity|max)\b', pl)):
                found_cache_val = True
                if re.search(r'(?:requirements?\.ya?ml|requirements?\s+spec|authoritative)', pl):
                    found_cache_src = True
                break
    if found_cache_val and found_cache_src:
        results["cache_size_correct"] = 1.0
    elif found_cache_val:
        results["cache_size_correct"] = 0.5

    content_lines = content.split('\n')
    disc_full = False
    disc_partial = False
    for i in range(len(paragraphs)):
        for span in (1, 2):
            if i + span > len(paragraphs):
                break
            window = "\n\n".join(paragraphs[i:i + span]).lower()
            has_files = (
                re.search(r'cache_config', window)
                and re.search(r'requirements', window)
            )
            has_cache_vals = (
                re.search(r'(?<!\d)256(?!\d)', window)
                and re.search(r'(?<!\d)512(?!\d)', window)
            )
            has_ttl_vals = (
                re.search(r'(?<!\d)72(?!\d)', window)
                and re.search(r'(?<!\d)168(?!\d)', window)
                and re.search(r'ttl', window)
            )
            if has_files and has_cache_vals and has_ttl_vals:
                disc_full = True
                break
            if has_files and has_cache_vals and not disc_partial:
                disc_partial = True
        if disc_full:
            break
    if disc_full:
        results["cache_discrepancy_flagged"] = 1.0
    elif disc_partial:
        results["cache_discrepancy_flagged"] = 0.5

    for para in paragraphs:
        pl = para.lower()
        if re.search(r'\bactor\b', pl) and re.search(r'\btokio\b', pl):
            results["actor_concurrency_model"] = 1.0
            break

    if re.search(r'(?i)(legacy|supersed|outdat|obsolet|deprecated|v1\.0|version\s*1)', content):
        results["legacy_doc_handled"] = 1.0

    has_lru = bool(re.search(r'(?i)\bLRU\b', content))
    has_arc = bool(re.search(r'(?i)\bARC\b', content))

    def _bench_present(ref_val, is_ns=False, is_pct=False):
        s = str(ref_val)
        if is_ns:
            return bool(re.search(r'(?<!\d)' + re.escape(s) + r'\s*ns', content_lower))
        if is_pct:
            return bool(re.search(r'(?<!\d)' + re.escape(s) + r'\s*%', content))
        return bool(re.search(r'(?<!\d)' + re.escape(s) + r'(?!\d)', content))

    def _val_in_para(pl, ref_val, is_ns=False, is_pct=False):
        s = str(ref_val)
        if is_ns:
            return bool(re.search(r'(?<!\d)' + re.escape(s) + r'\s*ns', pl))
        if is_pct:
            return bool(re.search(r'(?<!\d)' + re.escape(s) + r'\s*%', pl))
        return bool(re.search(r'(?<!\d)' + re.escape(s) + r'(?!\d)', pl))

    core_checks = [
        _bench_present(lru_ref.get("hit_rate_percent", 87.3), is_pct=True),
        _bench_present(arc_ref.get("hit_rate_percent", 89.7), is_pct=True),
        _bench_present(int(lru_ref.get("avg_lookup_ns", 45)), is_ns=True),
        _bench_present(int(arc_ref.get("avg_lookup_ns", 85)), is_ns=True),
        _bench_present(lru_ref.get("memory_overhead_percent", 2.1), is_pct=True),
        _bench_present(arc_ref.get("memory_overhead_percent", 8.7), is_pct=True),
    ]
    extra_items = [
        (int(lru_ref.get("p99_lookup_ns", 120)), True, False),
        (int(arc_ref.get("p99_lookup_ns", 210)), True, False),
        (int(lru_ref.get("avg_insert_ns", 62)), True, False),
        (int(arc_ref.get("avg_insert_ns", 130)), True, False),
        (lru_ref.get("prefetch_improvement_percent", 12.4), False, True),
        (arc_ref.get("prefetch_improvement_percent", 14.2), False, True),
    ]
    core_ct = sum(core_checks)

    best_para_core = 0
    best_para_extra = 0
    for para in paragraphs:
        pl = para.lower()
        pc = sum([
            _val_in_para(pl, lru_ref.get("hit_rate_percent", 87.3), is_pct=True),
            _val_in_para(pl, arc_ref.get("hit_rate_percent", 89.7), is_pct=True),
            _val_in_para(pl, int(lru_ref.get("avg_lookup_ns", 45)), is_ns=True),
            _val_in_para(pl, int(arc_ref.get("avg_lookup_ns", 85)), is_ns=True),
            _val_in_para(pl, lru_ref.get("memory_overhead_percent", 2.1), is_pct=True),
            _val_in_para(pl, arc_ref.get("memory_overhead_percent", 8.7), is_pct=True),
        ])
        pe = sum(
            _val_in_para(pl, v, is_ns=ns, is_pct=pct) for v, ns, pct in extra_items
        )
        if pc > best_para_core or (pc == best_para_core and pe > best_para_extra):
            best_para_core = pc
            best_para_extra = pe

    if has_lru and has_arc and best_para_core >= 6 and best_para_extra >= 4:
        results["lru_benchmark_justified"] = 1.0
    elif has_lru and has_arc and best_para_core >= 6 and best_para_extra >= 2:
        results["lru_benchmark_justified"] = 0.5

    backend_found = {
        "pipewire": bool(re.search(r'(?i)\bpipewire\b', content)),
        "pulseaudio": bool(re.search(r'(?i)\bpulse\s*audio\b', content)),
        "alsa": bool(re.search(r'(?i)\bALSA\b', content)),
        "coreaudio": bool(re.search(r'(?i)\bcore\s*audio\b', content)),
        "wasapi": bool(re.search(r'(?i)\bWASAPI\b', content)),
        "oboe": bool(re.search(r'(?i)\bOboe\b', content)),
    }
    has_opensles = bool(re.search(
        r'(?i)\b(?:opensl[\s_-]*es|opensles|open\s*sl\s*es)\b', content
    ))
    total_be = sum(backend_found.values())
    linux_ok = all(backend_found.get(b, False) for b in ref_linux_backends)
    android_ok = backend_found.get("oboe", False) and has_opensles

    ref_crate_names = set()
    for cm in re.finditer(r'\[dependencies\.([^\]]+)\]', platform_text):
        ref_crate_names.add(cm.group(1).strip().lower())
    if not ref_crate_names:
        ref_crate_names = {"cpal", "rodio", "oboe-rs", "symphonia"}
    crate_hits = 0
    for cn in ref_crate_names:
        pat = re.escape(cn).replace(r'\-', r'[\s_-]?')
        if re.search(r'(?i)\b' + pat + r'\b', content):
            crate_hits += 1

    if total_be >= 6 and linux_ok and android_ok and crate_hits >= 3:
        results["platform_backends_covered"] = 1.0
    elif total_be >= 6 and linux_ok and android_ok:
        results["platform_backends_covered"] = 0.5
    elif total_be >= 5 and android_ok:
        results["platform_backends_covered"] = 0.25

    if re.search(r'cpal\D*(0\.1[5-9]|0\.[2-9]\d*|[1-9]\d*\.)', content):
        results["cpal_version_awareness"] = 1.0

    codecs = ["mp3", "flac", "ogg", "wav", "aac"]
    codec_count = sum(1 for c in codecs if c in content_lower)
    br_hits = 0
    for cn in codecs:
        ref_br = ref_codec_bitrates.get(cn)
        if ref_br is None:
            continue
        for para in paragraphs:
            pl = para.lower()
            if cn in pl and re.search(r'(?<![.\d])' + str(ref_br) + r'(?!\d)', pl):
                br_hits += 1
                break

    sr_hits = 0
    for cn in codecs:
        max_sr = ref_max_sample_rates.get(cn)
        if not max_sr or max_sr < 88200:
            continue
        for para in paragraphs:
            pl = para.lower()
            if cn in pl and str(max_sr) in pl:
                sr_hits += 1
                break

    if codec_count >= 5 and br_hits >= 4 and sr_hits >= 2:
        results["codec_support_comprehensive"] = 1.0
    elif codec_count >= 5 and br_hits >= 3 and sr_hits >= 1:
        results["codec_support_comprehensive"] = 0.75
    elif codec_count >= 5 and br_hits >= 2:
        results["codec_support_comprehensive"] = 0.5
    elif codec_count >= 5:
        results["codec_support_comprehensive"] = 0.25

    for para in paragraphs:
        pl = para.lower()
        if re.search(r'\baac\b', pl):
            has_original = bool(re.search(r'0\.512', pl))
            has_corrected = bool(re.search(r'(?<!\d)512\s*(?:kbps|kb/s|kbit)', pl))
            has_unit_note = bool(re.search(r'(?:mbps|megabit|unit|mismatch|conversion)', pl))
            if has_original and (has_corrected or has_unit_note):
                results["aac_bitrate_handled"] = 1.0
                break
            elif has_corrected or has_original:
                results["aac_bitrate_handled"] = 0.5
                break

    modules = [r'queue\s*manager', r'playback\s*engine', r'cache\s*manager', r'state\s*store']
    if all(re.search(m, content_lower) for m in modules):
        results["api_modules_described"] = 1.0

    has_sled_persist = False
    for para in paragraphs:
        pl = para.lower()
        if re.search(r'\bpersist', pl) and re.search(r'\bsled\b', pl):
            has_sled_persist = True
            break
    if has_sled_persist:
        schema_path = os.path.join(workspace_path, "config", "state_schema.json")
        schema_field_names = []
        try:
            with open(schema_path, "r", encoding="utf-8") as sf:
                schema_data = json.load(sf)
            schema_field_names = list(schema_data.get("properties", {}).keys())
        except Exception:
            pass
        trivial = {"queue", "volume", "speed"}
        check_fields = [f for f in schema_field_names if f not in trivial]
        if not check_fields:
            check_fields = [
                "current_track_id", "queue_position", "playback_position_ms",
                "play_mode", "shuffle_seed", "is_playing", "last_saved_at",
            ]
        field_pats = [f.replace("_", r'[\s_-]?') for f in check_fields]
        field_hits = sum(1 for pat in field_pats if re.search(pat, content_lower))
        has_last_saved = bool(re.search(r'last[\s_-]?saved[\s_-]?at', content_lower))
        if has_last_saved and field_hits >= 5:
            results["state_persistence_design"] = 1.0
        elif has_last_saved and field_hits >= 3:
            results["state_persistence_design"] = 0.5

    has_fy = bool(re.search(r'(?i)fisher[\s-]*yates', content))
    modes_present = sum(1 for m in ["sequential", "shuffle", "repeat"] if m in content_lower)
    if has_fy and modes_present >= 3:
        results["play_modes_section"] = 1.0
    elif has_fy or modes_present >= 3:
        results["play_modes_section"] = 0.5

    step_str = str(ref_speed_step)
    for para in paragraphs:
        pl = para.lower()
        has_min = bool(re.search(r'(?<!\d)0\.25', pl))
        has_max = bool(re.search(r'(?<!\d)4\.0(?!\d)', pl))
        has_spd = bool(re.search(r'\bspeed\b', pl))
        if has_min and has_max and has_spd:
            has_step = (
                bool(re.search(
                    r'(?<!\d)' + re.escape(step_str) + r'(?!\d)', pl
                ))
                and bool(re.search(
                    r'(?:step|increment|granularity|resolution)', pl
                ))
            )
            if has_step:
                results["speed_control_range"] = 1.0
            else:
                results["speed_control_range"] = 0.5
            break

    noise_markers = ["hyper::proto::h1", "rustls::conn::connectioncommon", "h2::proto::streams"]
    if not any(m in content_lower for m in noise_markers):
        results["noise_file_excluded"] = 1.0

    queue_heading = re.search(r'(?im)^#{1,4}\s+.*queue\s+management', content)
    if queue_heading:
        queue_test_path = os.path.join(workspace_path, "tests", "queue_test_cases.json")
        ref_qt_count = 0
        ref_qt_ops = set()
        try:
            with open(queue_test_path, "r", encoding="utf-8") as qtf:
                qt_data = json.load(qtf)
            tc_list = qt_data.get("test_cases", [])
            ref_qt_count = len(tc_list)
            for tc in tc_list:
                op = tc.get("operation", "")
                if op:
                    ref_qt_ops.add(op.lower())
        except Exception:
            pass
        if ref_qt_count == 0:
            results["queue_management_section"] = 1.0
        else:
            sec_start = queue_heading.start()
            next_h = re.search(r'(?m)^#{1,4}\s+', content[sec_start + 1:])
            sec_end = (sec_start + 1 + next_h.start()) if next_h else len(content)
            sec_text = content[sec_start:sec_end].lower()
            qt_s = str(ref_qt_count)
            has_qt_count = False
            for line in sec_text.split('\n'):
                if (re.search(r'(?<!\d)' + qt_s + r'(?!\d)', line)
                        and re.search(r'test', line)):
                    has_qt_count = True
                    break
            op_hits = sum(
                1 for op in ref_qt_ops
                if re.search(r'\b' + re.escape(op) + r'\b', sec_text)
            )
            if has_qt_count and op_hits >= 3:
                results["queue_management_section"] = 1.0

    err_guide_path = os.path.join(workspace_path, "docs", "error_handling_guide.md")
    err_guide_text = _read_file(err_guide_path)
    ref_retry_intervals = [100, 200, 400]
    retry_base_m = re.search(r'from_millis\((\d+)\s*\*\s*2', err_guide_text)
    if retry_base_m:
        _base_ms = int(retry_base_m.group(1))
        ref_retry_intervals = [_base_ms * (2 ** i) for i in range(3)]
    for i in range(len(content_lines)):
        end_idx = min(i + 20, len(content_lines))
        window = '\n'.join(content_lines[i:end_idx]).lower()
        if not re.search(r'(?:exponential|backoff)', window):
            continue
        iv_hits = sum(
            1 for iv in ref_retry_intervals
            if re.search(r'(?<!\d)' + str(iv) + r'\s*ms', window)
        )
        if iv_hits >= 2:
            results["error_handling_strategy"] = 1.0
            break

    for para in paragraphs:
        pl = para.lower()
        if re.search(r'ring[\s_-]*buffer', pl) and re.search(r'audio\s+(thread|output|callback)', pl):
            results["ringbuffer_audio_thread"] = 1.0
            break

    disc_heading = re.search(
        r'(?im)^#{1,4}\s+.*(?:discrepanc|conflict|inconsistenc|mismatch|errata)', content
    )
    if disc_heading:
        disc_text = content[disc_heading.start():].lower()
        contradictions = [
            (r'cache', r'(?:256|512)'),
            (r'(?:legacy|v1)', r'(?:architectur|v2|actor)'),
            (r'flac', r'(?:9126|9216)'),
            (r'cpal', r'(?:0\.13|0\.15)'),
            (r'aac', r'(?:0\.512|unit|mbps)'),
            (r'ttl', r'(?:168|72)'),
        ]
        pairs_found = sum(
            1 for a, b in contradictions
            if re.search(a, disc_text) and re.search(b, disc_text)
        )
        if pairs_found >= 4:
            results["discrepancy_section_exists"] = 1.0
        elif pairs_found >= 2:
            results["discrepancy_section_exists"] = 0.5
        else:
            results["discrepancy_section_exists"] = 0.25
    elif re.search(r'(?i)(discrepanc|conflict\s+found|noted\s+inconsistenc)', content):
        results["discrepancy_section_exists"] = 0.25

    topic_patterns = [
        r'\barchitect', r'\bqueue\b', r'\bcach', r'platform|backend|pipewire|wasapi',
        r'memory|heap|budget|allocat', r'\bcodec\b|mp3|flac|aac', r'\bsled\b|sqlite|persist',
        r'shuffle|play\s*mode|fisher', r'ring[\s_-]*buffer|tokio',
    ]
    topic_hits = sum(1 for pat in topic_patterns if re.search(pat, content_lower))
    clen = len(content.strip())
    if topic_hits >= 7 and clen >= 600:
        results["document_quality"] = 1.0
    elif topic_hits >= 5 and clen >= 400:
        results["document_quality"] = 0.5

    audit_file = os.path.join(workspace_path, "workspace_audit.json")
    if os.path.isfile(audit_file):
        try:
            with open(audit_file, "r", encoding="utf-8") as af:
                audit_data = json.load(af)
            if isinstance(audit_data, dict):
                discs = audit_data.get("discrepancies", audit_data.get("conflicts", []))
                if isinstance(discs, list):
                    ws_rel_paths = set()
                    for root, _dirs, fnames in os.walk(workspace_path):
                        for fn in fnames:
                            rp = os.path.relpath(
                                os.path.join(root, fn), workspace_path
                            )
                            ws_rel_paths.add(rp)
                            ws_rel_paths.add(os.path.basename(fn))
                    valid = 0
                    with_files = 0
                    with_resolution = 0
                    files_verified = 0
                    for d in discs:
                        if not isinstance(d, dict) or len(d) < 3:
                            continue
                        valid += 1
                        fv = d.get("files", d.get("source_files", d.get("sources", [])))
                        if isinstance(fv, list) and len(fv) >= 2:
                            with_files += 1
                            matched = sum(
                                1 for fp in fv
                                if (str(fp).strip() in ws_rel_paths
                                    or os.path.basename(str(fp)) in ws_rel_paths)
                            )
                            if matched >= max(1, int(len(fv) * 0.8)):
                                files_verified += 1
                        elif isinstance(fv, str) and len(fv) > 10:
                            with_files += 1
                        res = d.get("resolution")
                        if isinstance(res, str) and len(res.strip()) >= 10:
                            with_resolution += 1
                    all_text = json.dumps(audit_data).lower()
                    has_cache = "cache" in all_text and ("512" in all_text or "256" in all_text)
                    has_cpal = "cpal" in all_text or "pipewire" in all_text
                    has_ttl = "ttl" in all_text and ("168" in all_text or "72" in all_text)
                    has_flac = "flac" in all_text and ("9126" in all_text or "9216" in all_text)
                    has_aac = "aac" in all_text and ("0.512" in all_text or "mbps" in all_text)
                    topics = sum([has_cache, has_cpal, has_ttl, has_flac, has_aac])
                    if (valid >= 5 and with_files >= 4 and topics >= 5
                            and with_resolution >= valid
                            and files_verified >= 3):
                        results["workspace_audit_valid"] = 1.0
                    elif (valid >= 5 and topics >= 4
                            and with_resolution >= 3):
                        results["workspace_audit_valid"] = 0.5
                    elif valid >= 3:
                        results["workspace_audit_valid"] = 0.25
        except Exception:
            pass

    for para in paragraphs:
        pl = para.lower()
        has_128 = bool(re.search(r'(?<![.\d])128\s*(?:mb|\b)', pl))
        has_mem_ctx = bool(re.search(r'(?:memory|heap|budget|footprint|allocation)', pl))
        if has_128 and has_mem_ctx:
            has_disk = bool(re.search(r'(?:disk|on.disk|file.system|not.*heap|exclud|separate)', pl))
            has_explain = bool(re.search(
                r'(?:exceed|conflict|contradict|reconcil|distinct|refer|note)', pl
            ))
            if has_disk or has_explain:
                results["memory_budget_analysis"] = 1.0
            else:
                results["memory_budget_analysis"] = 0.5
            break

    def _rb_in_range(val, exp_a, exp_b=None):
        if exp_a * 0.9 <= val <= exp_a * 1.1:
            return True
        if exp_b is not None and exp_b * 0.9 <= val <= exp_b * 1.1:
            return True
        return False

    for para in paragraphs:
        pl = para.lower()
        if not re.search(r'ring[\s_-]*buffer', pl):
            continue
        ms_matches = re.findall(r'(\d{2,4}(?:\.\d+)?)\s*(?:ms|millisecond)', pl)
        for ms_str in ms_matches:
            try:
                val = float(ms_str)
                if _rb_in_range(val, expected_rb_ms_a, expected_rb_ms_b):
                    has_params = (
                        (re.search(r'16384', pl) or re.search(r'65536', pl))
                        and re.search(r'44100', pl)
                    )
                    if has_params:
                        results["ring_buffer_duration"] = 1.0
                    else:
                        results["ring_buffer_duration"] = max(
                            results["ring_buffer_duration"], 0.5
                        )
                    break
            except ValueError:
                pass
        if results["ring_buffer_duration"] == 1.0:
            break

    out_of_scope = ["opus", "alac", "wma"]
    scope_violations = 0
    for codec in out_of_scope:
        for para in paragraphs:
            pl = para.lower()
            if (re.search(r'\b' + codec + r'\b', pl)
                    and re.search(r'(?:support|codec|format|decode|playback)', pl)):
                scope_violations += 1
                break
    if scope_violations == 0:
        results["codec_scope_correct"] = 1.0
    elif scope_violations == 1:
        results["codec_scope_correct"] = 0.5

    has_queue_sqlite = False
    has_state_sled = False
    for para in paragraphs:
        pl = para.lower()
        if re.search(r'queue', pl) and re.search(r'sqlite|rusqlite', pl):
            has_queue_sqlite = True
        if re.search(r'state', pl) and re.search(r'\bsled\b', pl):
            has_state_sled = True
    if has_queue_sqlite and has_state_sled:
        results["queue_vs_state_backends"] = 1.0
    elif has_queue_sqlite or has_state_sled:
        results["queue_vs_state_backends"] = 0.5

    # flac_bitrate_crossref: Both erroneous CSV value and correct spec value
    csv_flac_br = csv_codec_bitrates.get("flac", 9126)
    req_flac_br = ref_codec_bitrates.get("flac", 9216)
    if csv_flac_br != req_flac_br:
        csv_s = str(csv_flac_br)
        req_s = str(req_flac_br)
        flac_max_sr = str(ref_max_sample_rates.get("flac", 192000))
        if re.search(r'(?<![.\d])' + re.escape(csv_s) + r'(?!\d)', content):
            for para in paragraphs:
                pl = para.lower()
                if (re.search(r'flac', pl)
                        and re.search(csv_s, pl)
                        and re.search(req_s, pl)
                        and re.search(flac_max_sr, pl)):
                    results["flac_bitrate_crossref"] = 1.0
                    break
            if results["flac_bitrate_crossref"] < 1.0:
                for para in paragraphs:
                    pl = para.lower()
                    if (re.search(r'flac', pl)
                            and re.search(csv_s, pl)
                            and re.search(req_s, pl)):
                        results["flac_bitrate_crossref"] = 0.5
                        break

    for para in paragraphs:
        pl = para.lower()
        if (re.search(r'(?:sample|track|synthetic.*dawn)', pl)
                and re.search(r'(?:bitrate|kbps|bit[\s_-]*rate|data[\s_-]*rate)', pl)
                and re.search(
                    r'(?:exceed|anomal|inconsisten|invalid|mismatch|higher'
                    r'|above|impossible|incorrect|suspicious|error)', pl
                )):
            results["sample_data_validated"] = 1.0
            break
        if (re.search(r'(?<![.\d])384(?!\d)', pl) or re.search(r'(?<![.\d])383(?!\d)', pl)):
            if re.search(r'(?:mp3|kbps|bitrate|exceed)', pl):
                results["sample_data_validated"] = 1.0
                break

    if anomalous_tracks:
        best = 0.0
        for track in anomalous_tracks:
            title_low = track["title"].lower()
            actual = track["actual_kbps"]
            for para in paragraphs:
                pl = para.lower()
                if title_low not in pl:
                    continue
                br_vals = re.findall(r'(\d{3,4})(?:\.\d+)?\s*(?:kbps|kb/s|kbit)', pl)
                for bv in br_vals:
                    if actual * 0.95 <= float(bv) <= actual * 1.05:
                        best = 1.0
                        break
                if best < 1.0:
                    approx = re.findall(r'(?:~|≈|approximately\s+|about\s+|around\s+)(\d{3,4})', pl)
                    for av in approx:
                        if actual * 0.95 <= float(av) <= actual * 1.05:
                            best = 1.0
                            break
                if best < 1.0 and title_low in pl:
                    best = max(best, 0.5)
                if best == 1.0:
                    break
            if best == 1.0:
                break
        results["sample_track_anomaly_detected"] = best

    if ref_mem_components:
        name_pats = {
            "ring_buffer": r'ring[\s_-]*buffer',
            "decode_workspace": r'decod(?:e|ing)[\s_-]*(?:workspace|buffer)',
            "resampler_tables": r'resampl(?:er|ing)',
            "codec_state": r'codec[\s_-]*state',
            "cache_index": r'(?:cache[\s_-]*index|lru[\s_-]*index)',
            "prefetch_buffer": r'prefetch',
            "queue_metadata": r'queue[\s_-]*(?:metadata|meta)',
            "state_db_cache": r'(?:sled|state)[\s_-]*(?:db[\s_-]*)?(?:page[\s_-]*)?cache',
            "state_db_wal": r'(?:wal|write[\s_-]*ahead)',
            "misc_overhead": r'(?:misc|overhead|tokio|runtime)',
        }
        matched = set()
        for comp_key, exp_val in ref_mem_components.items():
            pat = name_pats.get(comp_key, re.escape(comp_key.replace("_", " ")))
            for para in paragraphs:
                pl = para.lower()
                if not re.search(pat, pl):
                    continue
                vals = re.findall(r'(\d+\.?\d*)\s*(?:mb|megabyte)', pl)
                for v in vals:
                    fv = float(v)
                    if exp_val * 0.9 <= fv <= exp_val * 1.1:
                        matched.add(comp_key)
                        break
                if comp_key in matched:
                    break
        mc = len(matched)
        if mc >= 6:
            results["memory_component_breakdown"] = 1.0
        elif mc >= 4:
            results["memory_component_breakdown"] = 0.75
        elif mc >= 2:
            results["memory_component_breakdown"] = 0.5

    bench_core_vals = [
        (str(lru_ref.get("hit_rate_percent", 87.3)), r'\s*%'),
        (str(int(lru_ref.get("avg_lookup_ns", 45))), r'\s*ns'),
        (str(arc_ref.get("hit_rate_percent", 89.7)), r'\s*%'),
        (str(int(arc_ref.get("avg_lookup_ns", 85))), r'\s*ns'),
    ]
    bench_evict_vals = [
        (str(int(lru_ref.get("avg_eviction_ns", 38))), r'\s*ns'),
        (str(int(arc_ref.get("avg_eviction_ns", 72))), r'\s*ns'),
    ]
    bench_pattern_vals = [
        (str(lru_ref.get("sequential_hit_rate", 94.1)), r'\s*%'),
        (str(arc_ref.get("sequential_hit_rate", 92.3)), r'\s*%'),
        (str(lru_ref.get("random_hit_rate", 72.8)), r'\s*%'),
        (str(arc_ref.get("random_hit_rate", 81.5)), r'\s*%'),
    ]
    for para in paragraphs:
        pl = para.lower()
        bcore = sum(
            1 for val_s, sfx in bench_core_vals
            if re.search(r'(?<!\d)' + re.escape(val_s) + sfx, pl)
        )
        bevict = sum(
            1 for val_s, sfx in bench_evict_vals
            if re.search(r'(?<!\d)' + re.escape(val_s) + sfx, pl)
        )
        bpatt = sum(
            1 for val_s, sfx in bench_pattern_vals
            if re.search(r'(?<!\d)' + re.escape(val_s) + sfx, pl)
        )
        if bcore >= 4 and bevict >= 2 and bpatt >= 2:
            results["benchmark_numbers_paragraph"] = 1.0
            break
        if bcore >= 4:
            results["benchmark_numbers_paragraph"] = max(
                results["benchmark_numbers_paragraph"], 0.5
            )

    ref_decode_buf = 2097152
    dbm = re.search(r'decode_buffer_size_bytes:\s*(\d+)', threading_text)
    if dbm:
        ref_decode_buf = int(dbm.group(1))
    ref_decode_buf_mb = ref_decode_buf / (1024 * 1024)
    for i in range(len(content_lines)):
        end_idx = min(i + 100, len(content_lines))
        window = '\n'.join(content_lines[i:end_idx]).lower()
        w_has_workers = (
            re.search(r'(?<!\d)' + str(ref_workers) + r'(?!\d)', window)
            and re.search(r'worker', window)
            and re.search(r'(?:tokio|runtime)', window)
        )
        w_has_decode_buf = bool(
            re.search(r'(?<!\d)' + str(ref_decode_buf) + r'(?!\d)', window)
        )
        if not w_has_decode_buf:
            if (re.search(
                    r'(?<![.\d])' + re.escape(str(int(ref_decode_buf_mb)))
                    + r'(?:\.\d+)?\s*mb', window)
                    and re.search(r'(?:decode|pre[\s_-]*alloc)', window)):
                w_has_decode_buf = True
        w_has_alloc = bool(re.search(r'zero[\s_-]*alloc', window))
        if w_has_workers and w_has_decode_buf and w_has_alloc:
            results["threading_model_accuracy"] = 1.0
            break

    dc_vals = {}
    try:
        with open(defaults_path, "r", encoding="utf-8") as df3:
            dj3 = json.load(df3)
        for sec_name in ("player_defaults", "audio_output", "ui_hints", "logging"):
            sec = dj3.get(sec_name, {})
            for k, v in sec.items():
                if isinstance(v, (int, float)):
                    dc_vals[k] = v
    except Exception:
        dc_vals = {
            "default_volume": 0.8, "bit_depth": 16,
            "max_queue_size": 10000, "auto_save_interval_sec": 30,
            "latency_target_ms": 50, "seek_step_ms": 5000,
            "volume_step": 0.05, "buffer_size_frames": 4096,
            "sample_rate": 44100, "max_file_size_mb": 10,
        }
    dc_context = {
        "default_volume": r'(?:default|initial).{0,20}volume',
        "bit_depth": r'bit.{0,5}depth',
        "max_queue_size": r'queue.{0,10}(?:size|capacity|limit|max)',
        "auto_save_interval_sec": r'(?:auto.{0,5}save|save.{0,10}interval)',
        "latency_target_ms": r'latency.{0,10}target',
        "seek_step_ms": r'seek.{0,10}(?:step|increment)',
        "volume_step": r'volume.{0,10}(?:step|increment)',
        "buffer_size_frames": r'buffer.{0,15}(?:size|frame)',
        "sample_rate": r'(?:sample|sampling).{0,5}rate',
        "max_file_size_mb": r'log.{0,30}(?:file|size|max)',
    }
    dc_hits = 0
    for cfg_key, ctx_pat in dc_context.items():
        cfg_val = dc_vals.get(cfg_key)
        if cfg_val is None:
            continue
        val_s = str(cfg_val)
        val_pat = r'(?<!\d)' + re.escape(val_s) + r'(?!\d)'
        for para in paragraphs:
            pl = para.lower()
            if re.search(ctx_pat, pl) and re.search(val_pat, pl):
                dc_hits += 1
                break
    if dc_hits >= 9:
        results["default_config_values"] = 1.0
    elif dc_hits >= 6:
        results["default_config_values"] = 0.5

    return results
```

## LLM Judge Rubric

**Fallback Rule:** If the output file `audio_player_core_design.md` does not exist or contains fewer than 200 characters, all criteria below score 0.0.

### Criterion 1: Trap Detection and Conflict Resolution Quality (Weight: 40%)
**Score 1.0**: The document explicitly identifies and resolves ALL 8 traps with clear reasoning: (1) flags the 256 MB vs 512 MB cache discrepancy with authority source explanation; (2) identifies the legacy v1.0 doc as superseded; (3) recognizes the AAC bitrate unit mismatch (0.512 Mbps → 512 kbps) with explicit mention of the original erroneous value; (4) identifies the cpal version incompatibility; (5) catches the TTL hours discrepancy (168 vs 72); (6) detects the FLAC bitrate transposition (9126 vs 9216); (7) reconciles the memory budget (128 MB heap vs 512 MB disk cache) with a clear explanation; (8) identifies the sample track bitrate anomaly (~384 kbps MP3). A dedicated discrepancies section catalogs all conflicts, and a valid `workspace_audit.json` covers at least the 5 major conflicts. Reasoning is transparent and traceable to source files.
**Score 0.75**: The document correctly resolves 6 of the 8 traps with explicit reasoning. A discrepancies section exists covering most conflicts. Minor traps (FLAC bitrate, sample data) may be missed but all original 5 traps (cache size, architecture, AAC, cpal, TTL) are handled.
**Score 0.5**: The document correctly resolves 4 of the 8 traps. The original "easy" traps (cache size, architecture) are handled, but the subtler traps requiring cross-file numerical comparison (FLAC bitrate, sample data validation, memory budget reconciliation) are missed. A partial discrepancies section exists.
**Score 0.25**: Only 2 traps are explicitly detected. The document shows awareness of some contradictions but misses most of the subtler data quality issues. No structured conflict catalog.
**Score 0.0**: No traps are explicitly detected or discussed. The document uses incorrect values without question.

### Criterion 2: Quantitative Analysis and Cross-Validation Depth (Weight: 35%)
**Score 1.0**: The document demonstrates rigorous numerical analysis: (1) LRU vs ARC: one contiguous comparison block with all six core metrics plus ≥4 secondary metrics from `cache_perf.json`; eviction times and ≥2 per-pattern hit rates appear in that block or one clearly linked following paragraph; (2) memory budget table with ≥6 component MB values from `capacity_planning.yaml`, reconciled to the 128 MB heap limit and disk-backed 512 MB cache; (3) ring buffer duration from stated frame count and sample rate (~371 ms at defaults); (4) "Synthetic Dawn" named with ~384 kbps vs MP3 320 kbps cap; (5) codec bitrates and max sample rates cross-checked between CSV and requirements (incl. AAC unit error and FLAC 9126 vs 9216); (6) platforms with primary/fallback backends and crate names; (7) threading section with tokio workers (4), decode pre-alloc buffer, audio zero-allocation; (8) ≥9 defaults from `player_defaults.json` across sections including logging. Numbers traceable to sources.
**Score 0.75**: The document includes 3-4 of the 5 quantitative analyses above. Most numbers are correct and traceable. One or two analyses may be missing or superficial.
**Score 0.5**: The document includes 2 of the 5 quantitative analyses. The LRU benchmark numbers are present but may lack ARC comparison. Memory budget may be mentioned but not computed. No ring buffer calculation or sample data validation.
**Score 0.25**: The document mentions benchmark data or codec numbers but without meaningful analysis. Numbers are stated without derivation or cross-reference verification.
**Score 0.0**: No quantitative analysis is present. The document lacks numerical reasoning and data cross-validation.

### Criterion 3: Synthesis Quality and Document Coherence (Weight: 25%)
**Score 1.0**: The document reads as a unified, professionally structured design document. Information from different source files is woven together logically, with cross-references between sections (e.g., caching strategy references codec bitrates for sizing, platform backends reference dependency versions, queue persistence references the state persistence backend to explain the dual-backend design). The queue and state persistence subsystems are clearly distinguished. The narrative flows naturally and would genuinely serve as a "single source of truth." Technical depth is consistent throughout.
**Score 0.75**: The document is well-structured and mostly cohesive, with clear section organization. Some cross-referencing between related topics exists. The queue/state backend distinction is present but could be clearer. Overall readability is high.
**Score 0.5**: The document covers the required topics but reads more like a compilation of notes from different files. Limited cross-referencing. The distinction between queue (SQLite) and state (sled) persistence may be unclear or absent.
**Score 0.25**: The document is disjointed, with sections that appear to be direct transcriptions from source files with minimal synthesis. Inconsistent level of detail.
**Score 0.0**: The document is incoherent, missing major sections, or is essentially a raw dump of source file contents.
