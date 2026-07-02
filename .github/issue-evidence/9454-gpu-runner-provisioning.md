# #9454 — Voice live E2E runner provisioning handoff

**Issue:** [elizaOS/eliza#9454](https://github.com/elizaOS/eliza/issues/9454) — *ops(voice): provision the real-audio GPU CI lane for #9147's merge-gating DER/WER/echo/owner/impostor evidence.*

**Status:** code/config side is done and the lane is now keyless and self-staging.
The only remaining work is **physical**: register one self-hosted Linux x86‑64
runner with the voice models staged on it. Everything below is the exact recipe.

This issue **cannot be closed from a code session** — it needs a registered
runner that runs `voice-live-e2e.yml` to `conclusion=success` and uploads real
metrics. The PR that ships these config fixes references #9454 but does **not**
`Closes` it.

---

## 0. Update (#11184) — CI health: install fix + provisioning preflight

Two more checked-in config bugs kept the nightly lane red *before it ever
reached provisioning* (latest failing run 28548736294). Both are fixed in the
#11184 PR; neither changes the provisioning recipe below — they just stop the
lane burning ~90 min to a confusing mid-run red on an unprovisioned runner.

1. **Frozen-lockfile install failure (hard-failed every run).** All six jobs
   used a hand-rolled `bun install --frozen-lockfile`. This repo tracks
   `bun-version: canary`, and canary reserializes `bun.lock` byte-for-byte
   between builds, so the frozen install reds with `lockfile had changes, but
   lockfile is frozen` even when the resolved graph is identical. Replaced with
   the repo's `./.github/actions/setup-bun-workspace` composite
   (`install-command: bun install --ignore-scripts --no-frozen-lockfile`), which
   does the non-frozen fallback and restores the committed lockfile — the exact
   pattern already merged for Browser Benchmark Lanes (#11231) and used
   throughout `scenario-pr.yml`. `install-native-deps`/`install-protoc` are set
   `false` for the self-hosted jobs: they build no Rust plugins and a `sudo
   apt-get` would introduce a new failure mode on the fleet.

2. **Missing `nvcc`/`nvidia-smi`/`ffmpeg` → confusing deep red.** The two
   self-hosted jobs now run a **provisioning preflight** first (before install
   and before any GGUF download). It probes for the fused
   `libelizainference.so` + the `eliza-1-2b` ASR bundle (`asr/` region):

   - **Provisioned** (both present) → `VOICE_RUNNER_PROVISIONED=1`; the
     require-real matrix runs **exactly as before**. A provisioned-but-broken
     runner still **hard-fails** — no fake green.
   - **Not provisioned** → `VOICE_RUNNER_PROVISIONED=0`; the install + every
     real step is skipped via `if:`, and the job self-skips **LOUDLY** to a
     neutral (green) result: a `::warning::` annotation plus a `SKIPPED.md`
     marker in the `voice-real-acoustic-matrix` artifact, both pointing back to
     this runbook. This stops the nightly non-required lane from being a
     permanent unexplained red on the board.

   > **Reading a green run:** green now means *either* "the real matrix ran and
   > passed" *or* "the runner was not provisioned and the lane skipped" — check
   > the job's annotations / the `SKIPPED.md` artifact to tell them apart. A
   > green skip does **NOT** satisfy the §7 close criteria for #9454; producing
   > real DER/WER/echo/owner/impostor numbers still requires staging §3.3 + §3.4
   > on the runner. `nvcc`/`nvidia-smi`/`ffmpeg` remain informational only (the
   > fused lib carries `GGML_CPU`, so the acoustic passes run CPU-only).

---

## 1. What changed in this PR (config side)

The lane previously could not go green **even on a fully provisioned runner**,
because of three checked-in config bugs in `.github/workflows/voice-live-e2e.yml`.
All three are fixed here:

1. **Keyless contradiction.** The acoustic job's `Probe provisioned voice runner`
   step did `exit 1` whenever `ELEVENLABS_API_KEY` was empty — directly
   contradicting #9577, which made the matrix keyless (owner/impostor turns are
   synthesized locally with distinct fused Kokoro presets). This was the exact
   step the nightly runs failed at. The hard requirement is removed; the key is
   now optional (it only upgrades the human-turn rows to real ElevenLabs voices).

2. **Phantom Kokoro GGUF.** The lane downloaded
   `bundles/2b/tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf` with sha
   `cb5440c3…`. That filename **404s on Hugging Face** (only the canonical
   `kokoro-82m-v1_0.gguf` is published), and the pinned sha matched nothing. So
   the `Stage published acoustic GGUFs` step would hard-fail at the Kokoro
   download regardless of runner. Repointed to the published
   `kokoro-82m-v1_0.gguf` with its real sha `25521c1a…`. The Kokoro engine
   discovery treats the no-suffix name as canonical, and the lane's consuming
   scripts glob `kokoro-82m-v1_0*.gguf`, so this is fully compatible.

3. **Stale `af_bella.bin` sha.** The pinned `f69d8362…` no longer matched the
   published voice pack (`63d24d0e…`), so `download_sha` would also fail there.
   Repointed to the current sha (verified by downloading the 522 KB file and
   `sha256sum`-ing it).

Plus two operability changes:

- **Single point of runner config.** Both real jobs now use
  `runs-on: ${{ fromJSON(vars.VOICE_LIVE_RUNNER_LABELS || '["self-hosted","Linux","X64","eliza"]') }}`.
  Default targets the already-online `eliza` runners. To repoint at a dedicated
  GPU box, set **one** repo variable `VOICE_LIVE_RUNNER_LABELS` — no workflow edit.
- **Actionable hard-fail + lib-path alignment.** The acoustic job now fails with
  a clear "fused lib not staged — see this doc" message instead of a bare
  non-zero, and the fused-lib search list now includes the canonical
  `~/.eliza/local-inference/lib/libelizainference.so` output of
  `stage-desktop-fused-lib.mjs`, so staging is one command with no env wiring.

The other four pinned GGUFs (wespeaker, pyannote, both silero VAD files) were
verified against HF and are **correct** — unchanged.

---

## 2. Current runner target

| | |
|---|---|
| Jobs that need it | `voice-roundtrip` (non-blocking) and `voice-acoustic-matrix` (the gate) |
| Default labels | `[self-hosted, Linux, X64, eliza]` |
| Single config point | repo variable `VOICE_LIVE_RUNNER_LABELS` (JSON array of labels) |
| Currently online with this label | `odi-100-25-1` … `odi-100-25-5` (5 runners) |

The label `gpu-cuda-12.6` named in the original issue **does not exist** on the
org; the lane was already repointed off it to `eliza`. The 5 `eliza`-labeled
runners are online but do **not** have the voice models/lib staged — that is the
remaining work.

**A GPU is recommended (for speed) but not required.** The fused
`libelizainference.so` builds with `GGML_CPU` always on and has no CUDA
`DT_NEEDED`, so the acoustic forward passes run on CPU. They were proven on real
hardware on both an RTX 5080 box (CPU-fused lib, no CUDA rebuild) and an Apple
M4 Max (Metal). A CUDA 12.6+ box just runs the matrix faster.

---

## 3. Provisioning steps (the physical handoff)

Pick the host: either stage the models on one of the existing `eliza` runners,
or stand up a dedicated GPU box and point the lane at it via
`VOICE_LIVE_RUNNER_LABELS`.

**3.1 Register the runner** (skip if using an existing `eliza` runner)

```bash
# On the target Linux x86-64 box, register a repo/org self-hosted runner with
# the labels you want the lane to match. Default expects: self-hosted Linux X64 eliza
./config.sh --url https://github.com/elizaOS/eliza \
  --token <RUNNER_TOKEN> --labels self-hosted,Linux,X64,eliza
./run.sh    # or install as a service
```

If you use a different label set (e.g. a real GPU box labeled `gpu-cuda-12.6`),
register with those labels and set the repo variable:

```bash
gh variable set VOICE_LIVE_RUNNER_LABELS \
  --repo elizaOS/eliza --body '["self-hosted","Linux","X64","gpu-cuda-12.6"]'
```

**3.2 Host tooling**

- **ffmpeg** (`apt-get install -y ffmpeg`) — round-trip resample step.
- **Node 24** and **Bun canary** are installed by the workflow itself (setup-node
  / setup-bun), so they don't need pre-staging. Build toolchain for the fused lib:
  `build-essential`, `cmake`, and **CUDA Toolkit 12.6+** (`nvcc`) if you want the
  GPU build; without `nvcc` the script falls back to Vulkan/HIP/CPU automatically.

**3.3 Stage the fused `libelizainference.so`** (one command)

```bash
# From a checkout of this repo on the runner:
node packages/app-core/scripts/stage-desktop-fused-lib.mjs --variant auto
# Outputs ~/.eliza/local-inference/lib/libelizainference.so
# (--variant cuda forces the CUDA build; auto detects nvcc → CUDA, else CPU)
```

The lane now searches `~/.eliza/local-inference/lib/libelizainference.so`
directly, so no env var is needed. To use a lib at a custom path instead, set the
runner env `ELIZA_INFERENCE_LIBRARY=/abs/path/libelizainference.so`.

**3.4 Stage the eliza-1-2b ASR bundle**

The lane requires a source bundle with an `asr/` region at
`~/.eliza/local-inference/models/eliza-1-2b.bundle` (override with
`ELIZA_ASR_BUNDLE`). Any box that has run the Eliza desktop app with local
inference already has it. To stage it manually, fetch the ASR region from HF:

```bash
B=~/.eliza/local-inference/models/eliza-1-2b.bundle/asr
mkdir -p "$B"
base=https://huggingface.co/elizaos/eliza-1/resolve/main/bundles/2b/asr
curl -fL "$base/eliza-1-asr.gguf"        -o "$B/eliza-1-asr.gguf"
curl -fL "$base/eliza-1-asr-mmproj.gguf" -o "$B/eliza-1-asr-mmproj.gguf"
curl -fL "$base/mmproj-audio-2b-bf16.gguf" -o "$B/mmproj-audio-2b-bf16.gguf"
```

| ASR file (under `asr/`) | size | sha256 |
|---|---|---|
| `eliza-1-asr.gguf` | 804.7 MB | `bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971` |
| `eliza-1-asr-mmproj.gguf` | 214.4 MB | `41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d` |
| `mmproj-audio-2b-bf16.gguf` | 986.8 MB | `e42083b71a9e31e0f722171d551f6d92b101544001c4dde040306a8f2160fe8c` |

That is **all** the runner needs. Every other GGUF (speaker / diarizer / VAD /
Kokoro TTS) is fetched fresh from HF with a pinned sha256 by the lane itself.

---

## 4. Voice GGUFs the lane downloads (no manual staging needed)

All verified present on `https://huggingface.co/elizaos/eliza-1/resolve/main`
with the shas now pinned in the workflow:

| HF path | dest in overlay bundle | sha256 |
|---|---|---|
| `voice/speaker-encoder/wespeaker-resnet34-lm.gguf` | `speaker/…` | `ad066730b125f61a305c949f7f196d23681f387f3e3f916be7a4cd003aae6ae3` |
| `voice/diarizer/pyannote-segmentation-3.0.gguf` | `diariz/…` | `30983eba41c0a99ab7eada564739ae8be74faeb21a31da759c870b5173cbd8a5` |
| `voice/vad/silero-vad-v5.1.2.ggml.bin` | `vad/…` | `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` |
| `bundles/2b/vad/silero-vad-v5.gguf` | `vad/…` | `d348cd6d87ea53dcd3e6680698c88be326082e27dae899adef653d090bee4995` |
| `bundles/2b/tts/kokoro/kokoro-82m-v1_0.gguf` | `tts/kokoro/…` | `25521c1aa35218d03630bf5239e70d8b5acd0e54c6e92543accfb3ebf9cff9d2` |
| `bundles/2b/tts/kokoro/voices/af_bella.bin` | `tts/kokoro/voices/…` | `63d24d0e5d91cb6cf3bca294a3b8c0b4428aa54ac9b5de42e5ba07f6bd110ea8` |

**No wakeword GGUF is required by this lane.** The acoustic matrix exercises
VAD + speaker-encoder (WeSpeaker) + diarizer (pyannote) + Kokoro TTS + ASR; it
does not load a wakeword model, so the wake-word asset filenames mentioned in
older issue comments do not gate any row here. All VAD/speaker/diariz/Kokoro
assets are present on HF — there are **no absent assets** blocking this lane.

---

## 5. Secrets / env

| Name | Required? | Effect |
|---|---|---|
| `ELEVENLABS_API_KEY` | **No** (keyless, #9577) | If set, the human-turn rows use real ElevenLabs voices instead of local Kokoro presets. The gate passes without it. |
| `CEREBRAS_API_KEY` | No | Only enables the optional mixed cloud round-trip in `voice-roundtrip` (non-blocking job). |
| `VOICE_LIVE_RUNNER_LABELS` (repo var) | No | Override the runner labels (single config point). |

There are **no required secrets** after #9577. Provisioning is the only blocker.

---

## 6. What the lane runs and the gate it enforces

Trigger on demand:

```bash
gh workflow run voice-live-e2e.yml --repo elizaOS/eliza --ref develop
```

The blocking `voice-acoustic-matrix` job runs, in `--require-real` mode (a missing
model/ABI is a hard failure, never a green skip), and uploads logs to the
`voice-real-acoustic-matrix` artifact:

1. `test:kokoro:real` — real Kokoro GGUF synthesizes audible PCM.
2. `voice-attribution-smoke.ts --require-real` — VAD / WeSpeaker / diarizer /
   enrollment / bystander / streaming + live self-voice echo suppression.
3. `voicestack:real`, `agentvoice:real`, `robustness:real`.
4. `voice:workbench --real`.
5. **`packages/benchmarks/voice/voice-real-ci-matrix.mjs`** — the DER / WER /
   echo / owner / impostor gate (below).
6. Real fused FFI vitest lanes (encoder / diarizer / asr-timed / kokoro bridge).

### Acceptance thresholds (`voice-real-ci-matrix.mjs`, all env-overridable)

| Metric | Gate | Env override |
|---|---|---|
| DER | ≤ `0.6` | `ELIZA_VOICE_REAL_MAX_DER` |
| WER (mean) | ≤ `0.35` | `ELIZA_VOICE_REAL_MAX_WER` |
| Owner accuracy | ≥ `1.0` (100%) | `ELIZA_VOICE_REAL_MIN_OWNER_ACCURACY` |
| Impostor accept rate (FAR) | ≤ `0` | `ELIZA_VOICE_REAL_MAX_IMPOSTOR_ACCEPT_RATE` |
| Owner accept threshold (cosine) | `0.78` | `ELIZA_VOICE_OWNER_ACCEPT_THRESHOLD` |
| Self-voice margin | ≥ `0.1` | `ELIZA_VOICE_REAL_MIN_SELF_MARGIN` |
| Echo rejection | must be `1` (agent echo suppressed) | — |

> Note on DER: local self-validating runs reproduced the pyannote over-detection
> tracked in **#9460** (DER ≈ 0.57 on a clean 2-speaker clip). If the provisioned
> run trips the DER gate, that is the #9460 diarizer bug surfacing, not a lane
> defect — it must be fixed (or the runner must carry a fused lib built past the
> diarizer-submodule fix `a359942d30`) before the gate goes green. The lane is
> doing its job by failing hard on it.

---

## 7. Definition of done for #9454 (close criteria)

- [ ] `voice-live-e2e.yml` run with `conclusion=success` on the provisioned
      runner (link the `gh run`), real-matrix steps green, no skip-pass.
- [ ] That run uploads real DER/WER/echo/owner/impostor numbers as lane outputs
      to `.github/issue-evidence/9147-*`.
- [ ] Numbers meet the thresholds in §6.

**Remaining work = exactly one physical step:** stage §3.3 (fused lib) + §3.4
(ASR bundle) on a Linux x86‑64 runner carrying the `eliza` label (or a dedicated
GPU box pointed to via `VOICE_LIVE_RUNNER_LABELS`), then dispatch the lane. No
code or secret work remains.
