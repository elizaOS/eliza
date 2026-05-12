#!/usr/bin/env python3
"""Eliza-1 bundle eval suite.

This is the runnable harness behind the publish-blocking eval gates in
``packages/inference/AGENTS.md`` §8 and ``packages/training/AGENTS.md`` §6/§8.
Given a staged Eliza-1 bundle directory it runs every applicable gate, writes
the per-eval JSON blobs into ``<bundle>/evals/`` (``text-eval.json``,
``voice-rtf.json``, ``asr-wer.json``, ``vad.json``, ``e2e-loop.json``,
``dflash-accept.json``, ``endurance.json``, ``dispatch.json``) plus the
``aggregate.json`` that the publish orchestrator
(``scripts/publish/orchestrator.py``) loads and gates on, and prints a summary.

Honesty rules (mirrors AGENTS.md §3/§7 — no fabricated passes):

* A gate whose artifact is a local stand-in / missing, or whose runtime
  engine is not present on this host, is recorded with ``status: "not-run"``
  and a ``reason``. Its metric is ``null``; the orchestrator's gate engine
  treats a missing required measurement as a fail (publish-blocking).
* A device-bound gate (mobile peak RSS / thermal) on a non-device host is
  recorded with ``status: "needs-hardware"`` and a ``null`` metric. The gate
  engine skips ``needs_hardware`` gates that have no measurement; the CI matrix
  runs them on real hardware.
* Where a gate *can* be measured here (CPU/Vulkan), it is measured for real:
  the text eval is a held-out perplexity → 0..1 score via the bundle's text
  GGUF; TTS RTF / ASR WER / VAD / e2e-loop / 30-turn endurance / DFlash
  acceptance drive the bundle's fused llama.cpp binaries (``llama-cli``,
  ``llama-omnivoice-server``, ``llama-speculative-simple``); the dispatch eval
  runs ``make -C packages/inference/verify kernel-contract reference-test``.

Run it::

    uv run --extra train python -m scripts.eval.eliza1_eval_suite \
        --bundle-dir ~/.eliza/local-inference/models/eliza-1-0_6b.bundle \
        --tier 0_6b

Or against the in-repo defaults (auto-discovers the engine bin dir and the
held-out text-eval corpus).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

# .../packages/training/scripts/eval/eliza1_eval_suite.py → packages/training
_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from benchmarks.eliza1_gates import (  # noqa: E402
    GateReport,
    apply_gates,
    normalize_tier,
)

SCHEMA_VERSION = 1

# Held-out text-eval corpus. A small fixed paragraph set; kept tiny so the
# eval is CPU-runnable. Replace with a larger held-out split when training
# ships one — the score (mean per-token NLL → mapped to a 0..1 scale) is
# what the gate compares.
DEFAULT_TEXT_EVAL_CORPUS: tuple[str, ...] = (
    "The capital of France is Paris, a city on the Seine known for the "
    "Louvre, the Eiffel Tower, and a long tradition of philosophy.",
    "Speculative decoding lets a small draft model propose several tokens "
    "that a larger target model verifies in a single forward pass, trading "
    "extra compute for lower latency.",
    "An on-device assistant keeps user data local: speech recognition, "
    "language understanding, and text-to-speech all run on the phone rather "
    "than streaming audio to a remote server.",
    "Quantization compresses neural-network weights to fewer bits per value "
    "so a model that needs sixteen gigabytes at full precision can fit in "
    "four gigabytes on a laptop with only a small drop in quality.",
    "Voice activity detection finds the boundaries of speech in an audio "
    "stream so the recognizer can skip silence and the system can react the "
    "moment the speaker stops talking.",
)

# Map mean per-token negative log-likelihood to a 0..1 "text quality" score:
# score = exp(-_NLL_DECAY * meanNll). Lower NLL → higher score. Calibrated so a
# competent fine-tuned small model (meanNll ≈ 2.0 nats/token ≈ ppl 7.4) lands
# around the 0_6b gate threshold (0.55), an un-fine-tuned base model
# (meanNll ≈ 4 nats ≈ ppl 55) lands ≈ 0.37, and a strong model (meanNll ≈ 1.3
# ≈ ppl 3.7) lands ≈ 0.72. The decay is the only knob; the per-tier gate
# thresholds in eliza1_gates.yaml are what actually decide pass/fail.
_NLL_DECAY = 0.30  # score = exp(-_NLL_DECAY * meanNll)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _json_write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Bundle + engine discovery
# ---------------------------------------------------------------------------


def _platform_tag() -> str:
    sysname = platform.system().lower()
    machine = platform.machine().lower()
    osmap = {"darwin": "darwin", "linux": "linux", "windows": "windows"}
    archmap = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}
    return f"{osmap.get(sysname, sysname)}-{archmap.get(machine, machine)}"


def _engine_bin_root() -> Path:
    state = (
        os.environ.get("ELIZA_STATE_DIR")
        or os.environ.get("MILADY_STATE_DIR")
        or str(Path.home() / ".eliza")
    )
    return Path(state).expanduser() / "local-inference" / "bin" / "dflash"


def _eliza_lib_name() -> str:
    sysname = platform.system().lower()
    if sysname == "darwin":
        return "libelizainference.dylib"
    if sysname == "windows":
        return "libelizainference.dll"
    return "libelizainference.so"


@dataclass
class Engine:
    """A discovered fused llama.cpp build directory + its binaries.

    ``llama_server`` is the fused ``llama-server`` (omnivoice-grafted: serves
    ``/v1/audio/speech`` + ``/completion`` + the in-process DFlash loop). It is
    the canonical voice runtime per AGENTS.md §4. ``eliza_lib`` is the fused
    ``libelizainference.{so,dylib}`` used for the ASR FFI. ``speculative`` may
    resolve from a *sibling* non-fused build dir when the fused build does not
    ship ``llama-speculative-simple`` (the fused omnivoice graft drops it).
    """

    backend: str  # "cpu" / "vulkan" / "cpu-fused" / ...
    bin_dir: Path
    llama_cli: Path | None
    speculative: Path | None
    omnivoice_server: Path | None
    llama_server: Path | None = None
    eliza_lib: Path | None = None
    is_fused: bool = False

    @property
    def available(self) -> bool:
        return self.bin_dir.is_dir()


def _read_caps(bin_dir: Path) -> dict | None:
    p = bin_dir / "CAPABILITIES.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def discover_engine(prefer_backend: str | None = None) -> Engine | None:
    root = _engine_bin_root()
    if not root.is_dir():
        return None
    plat = _platform_tag()
    # Prefer a fused build (serves /v1/audio/speech) on this platform, then a
    # plain build. Within each, honour ``prefer_backend`` if given.
    candidates: list[Path] = []
    for d in sorted(root.iterdir()):
        if not d.is_dir() or not d.name.startswith(plat):
            continue
        candidates.append(d)
    if not candidates:
        return None

    def rank(d: Path) -> tuple[int, int, int]:
        fused = 1 if "fused" in d.name else 0
        backend_match = 1 if (prefer_backend and prefer_backend in d.name) else 0
        # cpu over vulkan when nothing requested (cpu is the safest verify path).
        cpu = 1 if d.name.endswith("cpu") else 0
        return (backend_match, fused, cpu)

    best = max(candidates, key=rank)
    backend = best.name[len(plat) + 1 :] if len(best.name) > len(plat) + 1 else "cpu"

    def _bin(directory: Path, name: str) -> Path | None:
        p = directory / name
        return p if p.is_file() and os.access(p, os.X_OK) else None

    # llama-speculative-simple: prefer the picked dir, then any sibling build
    # on this platform (the fused omnivoice graft drops it from its bin/).
    spec = _bin(best, "llama-speculative-simple")
    if spec is None:
        for d in candidates:
            cand = _bin(d, "llama-speculative-simple")
            if cand is not None:
                spec = cand
                break

    caps = _read_caps(best)
    is_fused = bool(caps and (caps.get("fused") is True or caps.get("omnivoice"))) or "fused" in best.name
    lib = best / _eliza_lib_name()

    return Engine(
        backend=backend,
        bin_dir=best,
        llama_cli=_bin(best, "llama-cli"),
        speculative=spec,
        omnivoice_server=_bin(best, "llama-omnivoice-server"),
        llama_server=_bin(best, "llama-server"),
        eliza_lib=lib if lib.is_file() else None,
        is_fused=is_fused,
    )


def _bundle_file(
    bundle_dir: Path, subdir: str, *exts: str, contains: str | None = None
) -> Path | None:
    d = bundle_dir / subdir
    if not d.is_dir():
        return None
    for p in sorted(d.iterdir()):
        if not p.is_file():
            continue
        if exts and p.suffix.lower() not in exts:
            continue
        if contains and contains.lower() not in p.name.lower():
            continue
        return p
    return None


def _bundle_voice(bundle_dir: Path) -> tuple[Path | None, Path | None]:
    """Return ``(voice_gguf, voice_tokenizer_gguf)`` from ``tts/``.

    The tokenizer file has "token" in its name; the voice file is the other
    GGUF. If only one GGUF exists it is treated as the voice model.
    """
    d = bundle_dir / "tts"
    if not d.is_dir():
        return None, None
    ggufs = sorted(p for p in d.iterdir() if p.is_file() and p.suffix.lower() == ".gguf")
    if not ggufs:
        return None, None
    tok = next((p for p in ggufs if "token" in p.name.lower()), None)
    voice = next((p for p in ggufs if "token" not in p.name.lower()), None)
    if voice is None:
        voice = ggufs[0]
    return voice, tok


def _is_real_gguf(path: Path | None, min_bytes: int = 1_000_000) -> bool:
    """A real GGUF: starts with ``GGUF`` magic and is bigger than a stub."""
    if path is None or not path.is_file():
        return False
    try:
        if path.stat().st_size < min_bytes:
            return False
        with path.open("rb") as fh:
            return fh.read(4) == b"GGUF"
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Eval context
# ---------------------------------------------------------------------------


@dataclass
class EvalContext:
    bundle_dir: Path
    tier: str
    engine: Engine | None
    text_model: Path | None  # bundle text gguf (may be a stand-in)
    text_eval_model: Path | None  # gguf actually usable for the text eval
    voice_model: Path | None
    voice_tokenizer: Path | None
    asr_model: Path | None
    vad_model: Path | None
    drafter_model: Path | None
    text_eval_corpus: tuple[str, ...]
    threads: int
    timeout_s: int
    peak_rss_mb: float = 0.0
    notes: list[str] = field(default_factory=list)

    def llama_env(self) -> dict[str, str]:
        env = dict(os.environ)
        if self.engine is not None:
            ld = str(self.engine.bin_dir)
            env["LD_LIBRARY_PATH"] = (
                f"{ld}:{env['LD_LIBRARY_PATH']}" if env.get("LD_LIBRARY_PATH") else ld
            )
            env["DYLD_LIBRARY_PATH"] = (
                f"{ld}:{env['DYLD_LIBRARY_PATH']}"
                if env.get("DYLD_LIBRARY_PATH")
                else ld
            )
        return env

    def track_rss(self) -> None:
        try:
            import resource

            kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            # Linux reports kB; macOS reports bytes.
            mb = kb / 1024 if platform.system() == "Linux" else kb / (1024 * 1024)
            self.peak_rss_mb = max(self.peak_rss_mb, mb)
        except Exception:  # noqa: BLE001 - rss tracking is best-effort
            pass


def _run_llama(
    ctx: EvalContext, bin_path: Path, args: list[str], timeout_s: int | None = None
) -> tuple[int, str]:
    """Run a llama.cpp binary, return ``(returncode, combined output)``."""
    proc = subprocess.run(  # noqa: S603 - bin_path is a discovered local binary
        [str(bin_path), *args],
        capture_output=True,
        text=True,
        env=ctx.llama_env(),
        timeout=timeout_s or ctx.timeout_s,
        cwd=str(bin_path.parent),
    )
    ctx.track_rss()
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


# ---------------------------------------------------------------------------
# e2e voice-loop bench bridge
#
# The TTS-RTF / ASR-WER / e2e-loop / 30-turn runners all drive the same
# real fused runtime (the omnivoice-grafted ``llama-server`` + the ASR FFI),
# so they share one bench run: ``packages/inference/verify/e2e_loop_bench.mjs``.
# That harness already does WAV → ASR → DFlash-spec-decode → phrase chunker →
# OmniVoice TTS → PCM and reports every metric. We invoke it once per
# (tier, backend, turns) and cache the parsed JSON on the EvalContext.
# ---------------------------------------------------------------------------

_BUN = shutil.which("bun")


def _e2e_loop_bench_path() -> Path | None:
    for c in (
        _TRAINING_ROOT.parent / "inference" / "verify" / "e2e_loop_bench.mjs",
        _TRAINING_ROOT.parent.parent / "packages" / "inference" / "verify" / "e2e_loop_bench.mjs",
    ):
        if c.is_file():
            return c
    return None


def _run_e2e_loop_bench(ctx: EvalContext, turns: int) -> dict[str, Any]:
    """Run e2e_loop_bench.mjs for ``turns`` turns; return its parsed JSON report.

    Cached per ``turns`` on ``ctx`` (a 1-turn run feeds voice_rtf / asr_wer /
    e2e_loop; a 30-turn run feeds the endurance gate). On any failure to even
    start the bench, returns ``{"status": "not-run", "reason": ...}``.
    """
    cache: dict[int, dict[str, Any]] = getattr(ctx, "_e2e_cache", None) or {}
    if turns in cache:
        return cache[turns]
    if not hasattr(ctx, "_e2e_cache"):
        ctx._e2e_cache = cache  # type: ignore[attr-defined]
    if _BUN is None:
        result: dict[str, Any] = {"status": "not-run", "reason": "bun not on PATH; cannot run e2e_loop_bench.mjs"}
        cache[turns] = result
        return result
    bench = _e2e_loop_bench_path()
    if bench is None:
        result = {"status": "not-run", "reason": "packages/inference/verify/e2e_loop_bench.mjs not found"}
        cache[turns] = result
        return result
    backend = (ctx.engine.backend if ctx.engine else "cpu") or "cpu"
    # strip the "-fused" suffix the CAPABILITIES backend never carries, but the
    # discovered dir name might; e2e_loop_bench resolves the fused dir itself.
    backend = backend.replace("-fused", "")
    out_json = ctx.bundle_dir / "evals" / f"e2e-loop-bench-{turns}turn.json"
    args = [
        _BUN, str(bench),
        "--bundle", str(ctx.bundle_dir),
        "--tier", ctx.tier,
        "--backend", backend,
        "--turns", str(turns),
        "--report", str(out_json),
        "--quiet",
    ]
    if ctx.engine is not None:
        args += ["--bin-dir", str(ctx.engine.bin_dir)]
    # An endurance run on CPU is many minutes; give it room (the harness has
    # its own per-turn timeout, this is just the outer wall-clock cap).
    timeout_s = max(ctx.timeout_s, 90 * max(1, turns))
    try:
        proc = subprocess.run(  # noqa: S603 - bun + a repo-local script
            args,
            capture_output=True,
            text=True,
            env=ctx.llama_env(),
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        result = {"status": "not-run", "reason": f"e2e_loop_bench.mjs ({turns} turns) exceeded {timeout_s}s on this host"}
        cache[turns] = result
        return result
    ctx.track_rss()
    if not out_json.is_file():
        tail = "\n".join(((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()[-25:])
        result = {"status": "not-run", "reason": f"e2e_loop_bench.mjs produced no report (rc={proc.returncode})", "outputTail": tail}
        cache[turns] = result
        return result
    try:
        report = json.loads(out_json.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        result = {"status": "not-run", "reason": f"could not parse e2e_loop_bench report: {exc}"}
        cache[turns] = result
        return result
    cache[turns] = report
    return report


def _e2e_summary(report: dict[str, Any]) -> dict[str, Any] | None:
    return report.get("summary") if isinstance(report, dict) and report.get("status") == "ok" else None


# ---------------------------------------------------------------------------
# Eval: text quality (held-out perplexity → 0..1 score)
# ---------------------------------------------------------------------------


def eval_text(ctx: EvalContext) -> dict[str, Any]:
    base = {"schemaVersion": SCHEMA_VERSION, "metric": "text_eval", "op": ">="}
    model = ctx.text_eval_model
    if not _is_real_gguf(model):
        return {
            **base,
            "status": "not-run",
            "score": None,
            "passed": None,
            "reason": (
                "no usable text GGUF (bundle text artifact is a local stand-in "
                "and no --text-eval-model override given)"
            ),
        }
    try:
        from llama_cpp import Llama
    except ImportError:
        return {
            **base,
            "status": "not-run",
            "score": None,
            "passed": None,
            "reason": "llama-cpp-python not installed; cannot compute perplexity",
        }

    import numpy as np

    n_ctx = 2048
    # Discard the first ``warmup_skip`` predictions from each sequence: the
    # token right after BOS is essentially unconditioned and dominates the
    # mean otherwise. Standard "stride" perplexity practice.
    warmup_skip = 2
    llm = Llama(
        model_path=str(model),
        n_ctx=n_ctx,
        n_gpu_layers=0,
        n_threads=ctx.threads,
        logits_all=True,
        verbose=False,
    )
    total_nll = 0.0
    total_tokens = 0
    per_text: list[dict[str, Any]] = []
    try:
        for text in ctx.text_eval_corpus:
            toks = llm.tokenize(text.encode("utf-8"), add_bos=True)
            if len(toks) < warmup_skip + 2:
                continue
            toks = toks[: n_ctx - 1]
            llm.reset()
            llm.eval(toks)
            scores = np.asarray(llm._scores, dtype=np.float64)  # (n_tokens, n_vocab)
            nll = 0.0
            cnt = 0
            for i in range(warmup_skip, len(toks) - 1):
                row = scores[i]
                row = row - row.max()
                probs = np.exp(row)
                probs /= probs.sum()
                nll += -math.log(float(probs[toks[i + 1]]) + 1e-12)
                cnt += 1
            if cnt == 0:
                continue
            total_nll += nll
            total_tokens += cnt
            per_text.append({"tokens": cnt, "ppl": round(math.exp(nll / cnt), 4)})
    finally:
        try:
            llm.close()
        except Exception:  # noqa: BLE001
            pass
    ctx.track_rss()
    if total_tokens == 0:
        return {
            **base,
            "status": "not-run",
            "score": None,
            "passed": None,
            "reason": "text-eval corpus produced no tokens",
        }
    mean_nll = total_nll / total_tokens
    ppl = math.exp(mean_nll)
    score = round(math.exp(-_NLL_DECAY * mean_nll), 4)
    return {
        **base,
        "status": "ok",
        "score": score,
        "perplexity": round(ppl, 4),
        "meanNllNats": round(mean_nll, 4),
        "tokens": total_tokens,
        "model": str(model),
        "modelIsBundleText": model == ctx.text_model,
        "perText": per_text,
        "scoring": f"score = exp(-{_NLL_DECAY} * meanNll); see eliza1_eval_suite.py header",
    }


# ---------------------------------------------------------------------------
# Eval: TTS real-time factor
# ---------------------------------------------------------------------------

_TTS_PHRASES = (
    "Sure, I can help with that.",
    "One moment while I look that up.",
    "The capital of France is Paris.",
    "I have scheduled the meeting for tomorrow at three o'clock.",
    "Here is a short summary of the document you asked about.",
)


def eval_voice_rtf(ctx: EvalContext) -> dict[str, Any]:
    base = {"schemaVersion": SCHEMA_VERSION, "metric": "voice_rtf", "op": "<="}
    if not _is_real_gguf(ctx.voice_model) or not _is_real_gguf(ctx.voice_tokenizer):
        return {
            **base,
            "status": "not-run",
            "rtf": None,
            "passed": None,
            "reason": "bundle TTS artifacts are local stand-ins / missing",
        }
    if ctx.engine is None or not ctx.engine.is_fused or ctx.engine.llama_server is None:
        return {
            **base,
            "status": "not-run",
            "rtf": None,
            "passed": None,
            "reason": (
                "no fused llama-server (omnivoice-grafted, serves /v1/audio/speech) "
                f"on this host (looked under {_engine_bin_root()})"
            ),
        }
    # Drive the real fused runtime: the e2e bench synthesizes a fixed phrase
    # set through /v1/audio/speech and reports audio-sec / wall-sec per phrase.
    report = _run_e2e_loop_bench(ctx, turns=1)
    summary = _e2e_summary(report)
    if summary is None:
        return {
            **base,
            "status": "not-run",
            "rtf": None,
            "passed": None,
            "reason": report.get("reason") if isinstance(report, dict) else "e2e bench did not complete",
            "benchStatus": report.get("status") if isinstance(report, dict) else None,
        }
    rtf = summary.get("ttsRtfMedian")
    if rtf is None:
        return {
            **base,
            "status": "not-run",
            "rtf": None,
            "passed": None,
            "reason": "fused TTS synthesized no audio in the e2e bench run",
        }
    return {
        **base,
        "status": "ok",
        "rtf": round(float(rtf), 4),
        "rtfMean": summary.get("ttsRtfMean"),
        "backend": (ctx.engine.backend if ctx.engine else None),
        "binary": str(ctx.engine.llama_server),
        "benchReport": str(ctx.bundle_dir / "evals" / "e2e-loop-bench-1turn.json"),
        "phrases": list(_TTS_PHRASES),
        "note": (
            "TTS RTF = wall-seconds / audio-seconds over the e2e bench phrase "
            "set, synthesized through the fused llama-server /v1/audio/speech "
            "route on this host's backend"
        ),
    }


# ---------------------------------------------------------------------------
# Eval: ASR WER
# ---------------------------------------------------------------------------


def eval_asr_wer(ctx: EvalContext) -> dict[str, Any]:
    base = {"schemaVersion": SCHEMA_VERSION, "metric": "asr_wer", "op": "<="}
    if ctx.asr_model is None or not ctx.asr_model.is_file() or ctx.asr_model.stat().st_size < 100_000:
        return {
            **base,
            "status": "not-run",
            "wer": None,
            "passed": None,
            "reason": "bundle ASR artifact is a local stand-in / missing",
        }
    if ctx.engine is None or ctx.engine.eliza_lib is None:
        return {
            **base,
            "status": "not-run",
            "wer": None,
            "passed": None,
            "reason": (
                "no fused libelizainference.{so,dylib} (ASR FFI) on this host "
                f"(looked under {_engine_bin_root()})"
            ),
        }
    # The labelled speech set is *synthesized* from a fixed reference-phrase
    # set via the bundle's own OmniVoice TTS (the same fused build), then fed
    # back through the ASR FFI; WER is the normalized word error rate of the
    # transcript against the phrase that produced the audio. This is a
    # round-trip eval: it surfaces ASR quality (a stand-in ASR GGUF transcribes
    # garbage and lands wer≈1.0) without needing an external corpus. Source +
    # method are recorded on the blob.
    report = _run_e2e_loop_bench(ctx, turns=1)
    summary = _e2e_summary(report)
    if summary is None:
        return {
            **base,
            "status": "not-run",
            "wer": None,
            "passed": None,
            "reason": report.get("reason") if isinstance(report, dict) else "e2e bench did not complete",
            "benchStatus": report.get("status") if isinstance(report, dict) else None,
        }
    wer = summary.get("asrWerMean")
    if wer is None:
        return {
            **base,
            "status": "not-run",
            "wer": None,
            "passed": None,
            "reason": "e2e bench produced no ASR transcript / reference pair",
        }
    return {
        **base,
        "status": "ok",
        "wer": round(float(wer), 4),
        "werByTurn": summary.get("asrWerByTurn"),
        "asrLatencyMsMedian": summary.get("asrLatencyMsMedian"),
        "asrArtifact": str(ctx.asr_model),
        "ffiLibrary": str(ctx.engine.eliza_lib),
        "benchReport": str(ctx.bundle_dir / "evals" / "e2e-loop-bench-1turn.json"),
        "corpus": "synthesized from a fixed reference-phrase set via the bundle's OmniVoice TTS, transcribed back through the ASR FFI (round-trip WER)",
    }


# ---------------------------------------------------------------------------
# Eval: VAD precision/recall + latency
# ---------------------------------------------------------------------------


def eval_vad(ctx: EvalContext) -> dict[str, Any]:
    base = {"schemaVersion": SCHEMA_VERSION, "metric": "vad_latency_ms", "op": "<="}
    if ctx.vad_model is None or not ctx.vad_model.is_file() or ctx.vad_model.stat().st_size < 100_000:
        return {
            **base,
            "status": "not-run",
            "median": None,
            "precision": None,
            "recall": None,
            "passed": None,
            "reason": "bundle VAD artifact is a local stand-in / missing",
        }
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return {
            **base,
            "status": "not-run",
            "median": None,
            "passed": None,
            "reason": "onnxruntime not installed; cannot run the Silero VAD model",
        }
    # A real VAD eval streams a labelled-segment audio set through the ONNX
    # Silero model and measures speech-onset latency + segment precision/recall.
    # The labelled audio set is not staged on this host. Coordinated with the
    # E3/voice-vad sibling's VAD impl (packages/app-core/scripts/voice-vad-smoke.ts):
    # when that lands a labelled corpus, point --vad-corpus at it.
    return {
        **base,
        "status": "not-run",
        "median": None,
        "precision": None,
        "recall": None,
        "passed": None,
        "reason": (
            "VAD ONNX model present and onnxruntime available, but no labelled "
            "speech-segment corpus on this host (see voice-vad-smoke.ts — wire "
            "--vad-corpus when the sibling ships the labelled set)"
        ),
        "vadModel": str(ctx.vad_model),
    }


# ---------------------------------------------------------------------------
# Eval: e2e voice loop + 30-turn endurance
# ---------------------------------------------------------------------------


def eval_e2e_and_endurance(ctx: EvalContext) -> tuple[dict[str, Any], dict[str, Any]]:
    e2e_base = {"schemaVersion": SCHEMA_VERSION, "metric": "e2e_loop_ok", "op": "bool"}
    end_base = {
        "schemaVersion": SCHEMA_VERSION,
        "metric": "thirty_turn_ok",
        "op": "bool",
    }
    have_text = _is_real_gguf(ctx.text_model)
    have_voice = _is_real_gguf(ctx.voice_model) and _is_real_gguf(ctx.voice_tokenizer)
    have_asr = ctx.asr_model is not None and ctx.asr_model.is_file() and ctx.asr_model.stat().st_size > 100_000
    if not (have_text and have_voice and have_asr):
        reason = (
            "e2e voice loop needs real text + TTS + ASR bundle artifacts; "
            "current bundle has stand-ins"
        )
        e2e = {**e2e_base, "status": "not-run", "e2eLoopOk": False, "passed": None, "reason": reason}
        end = {
            **end_base,
            "status": "not-run",
            "thirtyTurnOk": False,
            "turns": 0,
            "peakRssMb": round(ctx.peak_rss_mb, 1) if ctx.peak_rss_mb else None,
            "passed": None,
            "reason": reason,
        }
        return e2e, end
    if ctx.engine is None or not ctx.engine.is_fused or ctx.engine.llama_server is None or ctx.engine.eliza_lib is None:
        reason = "no fused llama.cpp build (omnivoice-grafted llama-server + libelizainference) on this host"
        e2e = {**e2e_base, "status": "not-run", "e2eLoopOk": False, "passed": None, "reason": reason}
        end = {**end_base, "status": "not-run", "thirtyTurnOk": False, "turns": 0, "passed": None, "reason": reason}
        return e2e, end

    # --- one e2e turn: WAV → ASR → DFlash-spec text → phrase chunker → TTS → PCM
    one = _run_e2e_loop_bench(ctx, turns=1)
    one_summary = _e2e_summary(one)
    if one_summary is None:
        reason = one.get("reason") if isinstance(one, dict) else "e2e bench did not complete"
        e2e = {**e2e_base, "status": "not-run", "e2eLoopOk": False, "passed": None, "reason": reason}
        end = {**end_base, "status": "not-run", "thirtyTurnOk": False, "turns": 0, "passed": None, "reason": reason}
        return e2e, end
    e2e_ok = bool(one.get("e2eLoopOk"))
    e2e = {
        **e2e_base,
        "status": "ok",
        "e2eLoopOk": e2e_ok,
        "passed": e2e_ok,
        "firstTokenMsMedian": one_summary.get("firstTokenMsMedian"),
        "firstAudioFromMicMsMedian": one_summary.get("firstAudioFromMicMsMedian"),
        "firstAudioFromTokenMsMedian": one_summary.get("firstAudioFromTokenMsMedian"),
        "ttsRtfMedian": one_summary.get("ttsRtfMedian"),
        "asrLatencyMsMedian": one_summary.get("asrLatencyMsMedian"),
        "decodeTokPerSecMedian": one_summary.get("decodeTokPerSecMedian"),
        "totalTurnMsMedian": one_summary.get("totalTurnMsMedian"),
        "bargeInCancelMs": one_summary.get("bargeInCancelMs"),
        "serverPeakRssMb": one_summary.get("serverPeakRssMb"),
        "backend": ctx.engine.backend,
        "benchReport": str(ctx.bundle_dir / "evals" / "e2e-loop-bench-1turn.json"),
    }

    # --- 30-turn endurance: loop 30 turns, assert no crash / no leak / peak RSS
    #     within manifest ramBudgetMb.recommended. Slow on CPU (~minutes/turn for
    #     the MaskGIT TTS forward); ELIZA_EVAL_ENDURANCE_TURNS can shrink it for
    #     CI smoke runs (the gate name is thirty_turn_ok — a <30 run is recorded
    #     honestly as the run length and never as thirty_turn_ok=true).
    end_turns = int(os.environ.get("ELIZA_EVAL_ENDURANCE_TURNS", "30"))
    many = _run_e2e_loop_bench(ctx, turns=end_turns)
    many_summary = _e2e_summary(many)
    if many_summary is None:
        end = {
            **end_base,
            "status": "not-run",
            "thirtyTurnOk": False,
            "turns": 0,
            "passed": None,
            "reason": many.get("reason") if isinstance(many, dict) else "endurance bench did not complete",
        }
        return e2e, end
    thirty_ok = bool(many.get("thirtyTurnOk")) if many.get("thirtyTurnOk") is not None else (
        end_turns >= 30
        and bool(many.get("e2eLoopOk"))
        and not many_summary.get("leakSuspected")
        and many_summary.get("ramWithinBudget") is not False
    )
    end = {
        **end_base,
        "status": "ok",
        "thirtyTurnOk": thirty_ok,
        "passed": thirty_ok,
        "turns": end_turns,
        "leakSuspected": many_summary.get("leakSuspected"),
        "ramWithinBudget": many_summary.get("ramWithinBudget"),
        "ramBudgetRecommendedMb": many_summary.get("ramBudgetRecommendedMb"),
        "serverPeakRssMb": many_summary.get("serverPeakRssMb"),
        "peakRssMb": many_summary.get("serverPeakRssMb"),
        "e2eLoopOk": many.get("e2eLoopOk"),
        "backend": ctx.engine.backend,
        "benchReport": str(ctx.bundle_dir / "evals" / f"e2e-loop-bench-{end_turns}turn.json"),
        "note": (
            "30-turn endurance via e2e_loop_bench.mjs --turns 30 (turn 1 full, "
            "later turns lighter); thirtyTurnOk requires 30 turns completed with "
            "no crash, no RSS leak, peak RSS within manifest ramBudgetMb.recommended"
            if end_turns >= 30
            else f"shortened endurance run ({end_turns} turns) via ELIZA_EVAL_ENDURANCE_TURNS — not a thirty_turn_ok pass"
        ),
    }
    return e2e, end


# ---------------------------------------------------------------------------
# Eval: expressive voice (emotion/singing tag faithfulness + MOS + leakage)
# ---------------------------------------------------------------------------


def eval_expressive(ctx: EvalContext) -> dict[str, Any]:
    base = {"schemaVersion": SCHEMA_VERSION, "metric": "expressive", "op": "composite"}
    if not _is_real_gguf(ctx.voice_model):
        return {
            **base,
            "status": "not-run",
            "tagFaithfulness": None,
            "mosExpressive": None,
            "tagLeakage": None,
            "passed": None,
            "reason": "bundle TTS artifact is a local stand-in / missing",
        }
    if ctx.engine is None or ctx.engine.omnivoice_server is None:
        return {
            **base,
            "status": "not-run",
            "tagFaithfulness": None,
            "mosExpressive": None,
            "tagLeakage": None,
            "passed": None,
            "reason": "no fused llama-omnivoice-server binary on this host",
        }
    # Tag faithfulness needs an affect classifier over synthesized audio; MOS
    # needs human (or proxy-model) ratings; leakage needs ASR over the audio to
    # detect literal tag tokens. None of those graders are wired here. Record
    # not-run with the binary present.
    return {
        **base,
        "status": "not-run",
        "tagFaithfulness": None,
        "mosExpressive": None,
        "tagLeakage": None,
        "passed": None,
        "reason": (
            "TTS server present but the expressive graders (affect classifier, "
            "MOS proxy, ASR leakage check) are not wired on this host; needs an "
            "ABI-verified fused build"
        ),
        "binary": str(ctx.engine.omnivoice_server),
    }


# ---------------------------------------------------------------------------
# Eval: DFlash speculative-decode acceptance rate
# ---------------------------------------------------------------------------

_PARSE_DRAFTED = ("n_drafted", "n_draft")
_PARSE_ACCEPTED = ("n_drafted_accepted", "n_accept_total", "n_accept")


def _parse_spec_counters(text: str) -> tuple[int | None, int | None]:
    import re

    drafted = None
    accepted = None
    for key in _PARSE_DRAFTED:
        m = re.search(rf"{key}\s*[:=]\s*(\d+)", text, re.I)
        if m:
            drafted = int(m.group(1))
            break
    for key in _PARSE_ACCEPTED:
        m = re.search(rf"{key}\s*[:=]\s*(\d+)", text, re.I)
        if m:
            accepted = int(m.group(1))
            break
    return drafted, accepted


def eval_dflash_accept(ctx: EvalContext) -> dict[str, Any]:
    base = {"schemaVersion": SCHEMA_VERSION, "metric": "dflash_acceptance", "op": ">="}
    target = ctx.text_model
    drafter = ctx.drafter_model
    if not _is_real_gguf(target) or not _is_real_gguf(drafter, min_bytes=10_000_000):
        return {
            **base,
            "status": "not-run",
            "acceptanceRate": None,
            "speedup": None,
            "passed": None,
            "reason": "bundle text/drafter GGUFs are local stand-ins / missing",
        }
    if ctx.engine is None or ctx.engine.speculative is None:
        return {
            **base,
            "status": "not-run",
            "acceptanceRate": None,
            "speedup": None,
            "passed": None,
            "reason": (
                "no llama-speculative-simple binary on this host "
                f"(looked under {_engine_bin_root()})"
            ),
        }
    spec = ctx.engine.speculative
    n_predict = int(os.environ.get("ELIZA_EVAL_DFLASH_TOKENS", "48"))
    args = [
        "-m", str(target),
        "-md", str(drafter),
        "-p", "Write a short paragraph explaining speculative decoding.",
        "-n", str(n_predict),
        "-c", "1024", "-cd", "1024",
        "-ngl", "0", "-ngld", "0",
        "--draft-min", "2", "--draft-max", "6",
        "--device", "none", "--device-draft", "none",
    ]
    started = time.monotonic()
    try:
        rc, out = _run_llama(ctx, spec, args, timeout_s=min(ctx.timeout_s, 600))
    except subprocess.TimeoutExpired:
        return {
            **base,
            "status": "not-run",
            "acceptanceRate": None,
            "speedup": None,
            "passed": None,
            "reason": (
                f"llama-speculative-simple timed out after {min(ctx.timeout_s, 600)}s "
                f"on the {ctx.tier} target (4B-class target on CPU is slow on this "
                "host); rerun with a higher --timeout or on a GPU host"
            ),
            "binary": str(spec),
        }
    wall_s = time.monotonic() - started
    drafted, accepted = _parse_spec_counters(out)
    if rc != 0:
        return {
            **base,
            "status": "not-run",
            "acceptanceRate": None,
            "speedup": None,
            "passed": None,
            "reason": f"llama-speculative-simple exited {rc}",
            "outputTail": "\n".join(out.strip().splitlines()[-30:]),
            "binary": str(spec),
        }
    if not drafted or accepted is None:
        return {
            **base,
            "status": "not-run",
            "acceptanceRate": None,
            "speedup": None,
            "passed": None,
            "reason": "could not parse n_drafted / n_drafted_accepted from speculative run",
            "outputTail": "\n".join(out.strip().splitlines()[-30:]),
            "binary": str(spec),
        }
    rate = round(accepted / drafted, 4)
    return {
        **base,
        "status": "ok",
        "acceptanceRate": rate,
        "drafted": drafted,
        "accepted": accepted,
        "tokensPredicted": n_predict,
        "wallSeconds": round(wall_s, 2),
        "target": str(target),
        "drafter": str(drafter),
        "binary": str(spec),
    }


# ---------------------------------------------------------------------------
# Eval: per-backend kernel dispatch (the make verify targets)
# ---------------------------------------------------------------------------

REQUIRED_GRAPH_CACHE_FAMILIES = ("turbo3", "turbo4", "qjl", "polarquant")


def _find_verify_dir() -> Path | None:
    # packages/training → packages/inference/verify is a sibling package.
    candidates = [
        _TRAINING_ROOT.parent / "inference" / "verify",
        _TRAINING_ROOT.parent.parent / "packages" / "inference" / "verify",
    ]
    for c in candidates:
        if (c / "Makefile").is_file():
            return c
    return None


def eval_dispatch(ctx: EvalContext) -> dict[str, Any]:
    base = {"schemaVersion": SCHEMA_VERSION, "backend": "cpu"}
    verify_dir = _find_verify_dir()
    if verify_dir is None:
        return {
            **base,
            "status": "not-run",
            "runtimeReady": False,
            "passed": None,
            "reason": "packages/inference/verify/Makefile not found",
        }
    git_sha = "unknown"
    try:
        git_sha = subprocess.run(  # noqa: S603,S607
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            cwd=str(verify_dir),
        ).stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        pass
    targets = ["kernel-contract", "reference-test"]
    logs: list[str] = []
    ok = True
    for tgt in targets:
        try:
            proc = subprocess.run(  # noqa: S603,S607
                ["make", "-C", str(verify_dir), tgt],
                capture_output=True,
                text=True,
                timeout=min(ctx.timeout_s, 600),
            )
        except subprocess.TimeoutExpired:
            ok = False
            logs.append(f"$ make -C {verify_dir} {tgt}  [TIMEOUT]")
            continue
        out = (proc.stdout or "") + (proc.stderr or "")
        logs.append(f"$ make -C {verify_dir} {tgt}  [rc={proc.returncode}]")
        logs.extend(out.strip().splitlines()[-12:])
        if proc.returncode != 0:
            ok = False
    return {
        **base,
        "status": "pass" if ok else "fail",
        "runtimeReady": ok,
        "atCommit": git_sha,
        "generatedAt": _utc_now(),
        "report": "packages/inference/verify (make kernel-contract reference-test)",
        "kernelSet": list(REQUIRED_GRAPH_CACHE_FAMILIES) + ["dflash"],
        "kernelFamilies": list(REQUIRED_GRAPH_CACHE_FAMILIES),
        "targets": targets,
        "logs": logs,
        "note": (
            "C-reference + kernel-contract verification only — full graph "
            "dispatch against a real GGUF needs the fused build and a host with "
            "the target backend (Metal/Vulkan/CUDA)"
        ),
    }


# ---------------------------------------------------------------------------
# Aggregate + gates
# ---------------------------------------------------------------------------


def _metric_value(eval_blob: dict[str, Any]) -> Any:
    """Extract the gate-relevant scalar from an eval blob (None if not-run)."""
    metric = eval_blob.get("metric")
    if metric == "text_eval":
        return eval_blob.get("score")
    if metric == "voice_rtf":
        return eval_blob.get("rtf")
    if metric == "asr_wer":
        return eval_blob.get("wer")
    if metric == "vad_latency_ms":
        return eval_blob.get("median")
    if metric == "e2e_loop_ok":
        return eval_blob.get("e2eLoopOk")
    if metric == "thirty_turn_ok":
        return eval_blob.get("thirtyTurnOk")
    if metric == "dflash_acceptance":
        return eval_blob.get("acceptanceRate")
    return None


def run_suite(ctx: EvalContext) -> dict[str, Any]:
    ctx.track_rss()
    text = eval_text(ctx)
    voice = eval_voice_rtf(ctx)
    asr = eval_asr_wer(ctx)
    vad = eval_vad(ctx)
    e2e, endurance = eval_e2e_and_endurance(ctx)
    expressive = eval_expressive(ctx)
    dflash = eval_dflash_accept(ctx)
    dispatch = eval_dispatch(ctx)
    ctx.track_rss()

    # When the endurance runner did not measure the runtime's RSS (bench did
    # not run), fall back to the suite's own peak so the field is populated
    # with the right shape; a real run already filled it from the server VmHWM.
    if endurance.get("peakRssMb") is None:
        endurance["peakRssMb"] = round(ctx.peak_rss_mb, 1) if ctx.peak_rss_mb else None

    evals = {
        "text-eval.json": text,
        "voice-rtf.json": voice,
        "asr-wer.json": asr,
        "vad.json": vad,
        "e2e-loop.json": e2e,
        "endurance.json": endurance,
        "expressive.json": expressive,
        "dflash-accept.json": dflash,
        "dispatch.json": dispatch,
    }

    # e2e_loop_ok / thirty_turn_ok are independent contract booleans; when the
    # loop did not run they are recorded as null — a required gate with a null
    # measurement is publish-blocking, exactly what we want for stand-ins.
    # peak_rss / thermal are device-bound (mobile): null → the gate engine
    # records them as needs-hardware (skipped), not a fake pass.
    results: dict[str, Any] = {
        "text_eval": _metric_value(text),
        "voice_rtf": _metric_value(voice),
        "asr_wer": _metric_value(asr),
        "vad_latency_ms": _metric_value(vad),
        "e2e_loop_ok": (
            bool(e2e.get("e2eLoopOk")) if e2e.get("status") == "ok" else None
        ),
        "thirty_turn_ok": (
            bool(endurance.get("thirtyTurnOk"))
            if endurance.get("status") == "ok"
            else None
        ),
        "dflash_acceptance": _metric_value(dflash),
        # Expressive-voice triad (the orchestrator's manifest assembler reads
        # all three from results when stage 3 has passed). null until the
        # expressive graders are wired against an ABI-verified fused build.
        "expressive_tag_faithfulness": expressive.get("tagFaithfulness"),
        "expressive_mos": expressive.get("mosExpressive"),
        "expressive_tag_leakage": expressive.get("tagLeakage"),
        "peak_rss_mb": None,
        "thermal_throttle_pct": None,
    }

    bundle_is_standin = not _is_real_gguf(ctx.text_model)
    aggregate = {
        "schemaVersion": SCHEMA_VERSION,
        "tier": ctx.tier,
        "mode": "full",
        "generatedAt": _utc_now(),
        "host": f"{_platform_tag()} ({platform.processor() or platform.machine()})",
        "engine": (
            {"backend": ctx.engine.backend, "binDir": str(ctx.engine.bin_dir)}
            if ctx.engine
            else None
        ),
        "bundleIsLocalStandin": bundle_is_standin,
        "results": results,
        "evalBlobs": {name: blob.get("status") for name, blob in evals.items()},
        "peakRssMb": round(ctx.peak_rss_mb, 1) if ctx.peak_rss_mb else None,
        "notes": ctx.notes,
    }

    report: GateReport = apply_gates(aggregate, ctx.tier, mode="full")
    aggregate["gateReport"] = report.to_dict()
    aggregate["passed"] = report.passed

    # Fill the per-eval ``passed`` from the gate verdict where the gate ran.
    gate_by_metric = {g.metric: g for g in report.gates if g.metric}
    for blob in evals.values():
        m = blob.get("metric")
        g = gate_by_metric.get(m)
        if g is not None and not g.skipped:
            blob["passed"] = bool(g.passed)
            blob["gateThreshold"] = g.threshold
            blob["gateReason"] = g.reason

    # Write everything into <bundle>/evals/.
    evals_dir = ctx.bundle_dir / "evals"
    for name, blob in evals.items():
        _json_write(evals_dir / name, blob)
    _json_write(evals_dir / "aggregate.json", aggregate)
    return aggregate


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _default_text_corpus(path: Path | None) -> tuple[str, ...]:
    if path is None:
        return DEFAULT_TEXT_EVAL_CORPUS
    if not path.is_file():
        raise SystemExit(f"--text-corpus not found: {path}")
    if path.suffix == ".jsonl":
        out: list[str] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            text = obj.get("text") if isinstance(obj, dict) else line
            if isinstance(text, str) and text.strip():
                out.append(text)
        return tuple(out) or DEFAULT_TEXT_EVAL_CORPUS
    return tuple(
        ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()
    ) or DEFAULT_TEXT_EVAL_CORPUS


def build_context(args: argparse.Namespace) -> EvalContext:
    bundle_dir = args.bundle_dir.expanduser().resolve()
    if not bundle_dir.is_dir():
        raise SystemExit(f"bundle dir not found: {bundle_dir}")
    tier = normalize_tier(args.tier)
    engine = discover_engine(args.backend)
    text_model = _bundle_file(bundle_dir, "text", ".gguf")
    text_eval_model: Path | None = None
    if args.text_eval_model:
        p = args.text_eval_model.expanduser().resolve()
        text_eval_model = p if _is_real_gguf(p) else None
    elif _is_real_gguf(text_model):
        text_eval_model = text_model
    voice_model, voice_tokenizer = _bundle_voice(bundle_dir)
    return EvalContext(
        bundle_dir=bundle_dir,
        tier=tier,
        engine=engine,
        text_model=text_model,
        text_eval_model=text_eval_model,
        voice_model=voice_model,
        voice_tokenizer=voice_tokenizer,
        asr_model=_bundle_file(bundle_dir, "asr"),
        vad_model=_bundle_file(bundle_dir, "vad"),
        drafter_model=_bundle_file(bundle_dir, "dflash", ".gguf"),
        text_eval_corpus=_default_text_corpus(args.text_corpus),
        threads=args.threads,
        timeout_s=args.timeout,
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bundle-dir", type=Path, required=True, help="Staged Eliza-1 bundle directory.")
    ap.add_argument("--tier", required=True, help="Tier id (0_6b / 1_7b / 9b / ...) or eliza-1-<tier>.")
    ap.add_argument("--backend", default=None, help="Prefer this engine backend dir (cpu / vulkan / ...).")
    ap.add_argument("--text-eval-model", type=Path, default=None, help="Override text GGUF used for the perplexity eval (e.g. a small reference Qwen3 GGUF when the bundle text artifact is a stand-in).")
    ap.add_argument("--text-corpus", type=Path, default=None, help="Held-out text-eval corpus (.txt one-per-line or .jsonl with a 'text' field). Defaults to the bundled small set.")
    ap.add_argument("--threads", type=int, default=min(os.cpu_count() or 4, 8))
    ap.add_argument("--timeout", type=int, default=int(os.environ.get("ELIZA_EVAL_TIMEOUT", "300")), help="Per-subprocess timeout in seconds.")
    args = ap.parse_args(argv)

    ctx = build_context(args)
    print(f"[eliza1-eval] tier={ctx.tier} bundle={ctx.bundle_dir}")
    print(f"[eliza1-eval] engine={'%s @ %s' % (ctx.engine.backend, ctx.engine.bin_dir) if ctx.engine else 'none'}")
    print(f"[eliza1-eval] text-model={ctx.text_model} (real={_is_real_gguf(ctx.text_model)})  text-eval-model={ctx.text_eval_model}")
    agg = run_suite(ctx)
    print(f"[eliza1-eval] wrote {ctx.bundle_dir / 'evals'}/{{text-eval,voice-rtf,asr-wer,vad,e2e-loop,endurance,dflash-accept,dispatch,aggregate}}.json")
    print("[eliza1-eval] results:")
    for k, v in agg["results"].items():
        print(f"    {k:24s} = {v}")
    rep = agg["gateReport"]
    print(f"[eliza1-eval] gate verdict: passed={rep['passed']}  ({len(rep['failures'])} required gate failures)")
    for f in rep["failures"]:
        print(f"    FAIL {f}")
    # The suite itself does not exit non-zero on gate failure — the publish
    # orchestrator is the enforcement point. Exit 0 if the suite produced its
    # outputs; exit 1 only on a harness error (handled by exceptions above).
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
