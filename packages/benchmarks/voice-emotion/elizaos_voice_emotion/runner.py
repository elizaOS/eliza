"""Runner — orchestrates the three bench modes.

The heavy phases (`run_intrinsic` against MSP-Podcast / MELD / IEMOCAP,
`run_fidelity` against a live duet harness, `run_text_intrinsic` against
GoEmotions) require corpora + a running eliza-1 API + onnxruntime. Until
the operator stages those, the runner raises `BenchUnavailable` with a
clear message — explicit failure over silent success.

The smoke test in `tests/test_runner.py` exercises:

  - `BenchOutput.as_dict` round-trips,
  - `run_intrinsic(suite='fixture')` evaluates a small bundled fixture,
  - the unsupported corpora raise `BenchUnavailable`.
"""

from __future__ import annotations

import dataclasses
import pathlib
from collections.abc import Sequence
from typing import Any

from elizaos_voice_emotion.metrics import (
    EXPRESSIVE_EMOTION_TAGS,
    confusion_matrix,
    macro_f1,
    per_class_f1,
)


class BenchUnavailable(RuntimeError):
    """Raised when the bench can't run on this box (missing corpora,
    missing onnxruntime, missing duet pair). The CLI surfaces the message
    verbatim — no silent fallback per AGENTS.md §3.
    """


@dataclasses.dataclass
class BenchOutput:
    schema_version: int
    suite: str
    model: str
    macro_f1: float
    per_class_f1: dict[str, float]
    confusion: list[list[int]]
    mean_latency_ms: float
    n: int
    run_started_at: str
    elapsed_seconds: float = 0.0
    abstention_rate: float = 0.0
    notes: list[str] = dataclasses.field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "suite": self.suite,
            "model": self.model,
            "macroF1": self.macro_f1,
            "perClassF1": self.per_class_f1,
            "confusion": self.confusion,
            "meanLatencyMs": self.mean_latency_ms,
            "n": self.n,
            "runStartedAt": self.run_started_at,
            "elapsedSeconds": self.elapsed_seconds,
            "abstentionRate": self.abstention_rate,
            "notes": list(self.notes),
        }


# ---------------------------------------------------------------------------
# Fixture corpus — tiny smoke set the CI run uses.
# ---------------------------------------------------------------------------

# Each row is `(gold_label, predicted_label)`. The fixture pretends our
# Wav2Small adapter has perfect accuracy on a 14-sample symmetric corpus —
# the smoke test asserts macro_f1 == 1.0 against it. A trained adapter on a
# real corpus will land lower (MELD bar is 0.35); the fixture is here so
# CI exercises the metric pipeline end-to-end without dragging in the gold
# corpora.
_FIXTURE_ROWS: tuple[tuple[str, str], ...] = (
    ("happy", "happy"),
    ("happy", "happy"),
    ("sad", "sad"),
    ("sad", "sad"),
    ("angry", "angry"),
    ("angry", "angry"),
    ("nervous", "nervous"),
    ("nervous", "nervous"),
    ("calm", "calm"),
    ("calm", "calm"),
    ("excited", "excited"),
    ("excited", "excited"),
    ("whisper", "whisper"),
    ("whisper", "whisper"),
)


def _build_output(
    *,
    suite: str,
    model: str,
    rows: Sequence[tuple[str, str]],
    latencies_ms: Sequence[float],
    run_started_at: str,
    abstentions: int = 0,
) -> BenchOutput:
    y_true = [row[0] for row in rows]
    y_pred = [row[1] for row in rows]
    confusion = confusion_matrix(y_true, y_pred, EXPRESSIVE_EMOTION_TAGS)
    per_f1 = per_class_f1(y_true, y_pred, EXPRESSIVE_EMOTION_TAGS)
    f1 = macro_f1(y_true, y_pred, EXPRESSIVE_EMOTION_TAGS)
    mean_latency = (
        round(sum(latencies_ms) / len(latencies_ms), 3) if latencies_ms else 0.0
    )
    return BenchOutput(
        schema_version=1,
        suite=suite,
        model=model,
        macro_f1=f1,
        per_class_f1=per_f1,
        confusion=confusion,
        mean_latency_ms=mean_latency,
        n=len(rows),
        run_started_at=run_started_at,
        abstention_rate=round(
            abstentions / (len(rows) + abstentions),
            6,
        )
        if (len(rows) + abstentions) > 0
        else 0.0,
        notes=[],
    )


def _now_iso() -> str:
    import datetime

    return datetime.datetime.now(tz=datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------


def run_intrinsic(
    *,
    suite: str,
    model: str,
    onnx_path: pathlib.Path | None = None,
    corpus_manifest: pathlib.Path | None = None,
) -> BenchOutput:
    """Run acoustic classifier intrinsic accuracy.

    `suite='fixture'` runs against the bundled symmetric fixture (CI smoke).
    The other suites require the operator to stage the corpus + the ONNX
    model and pass `--onnx` + `--corpus-manifest`; the heavy paths raise
    `BenchUnavailable` here until that operator path lands.
    """
    if suite == "fixture":
        return _build_output(
            suite=suite,
            model=model,
            rows=_FIXTURE_ROWS,
            latencies_ms=[4.2 for _ in _FIXTURE_ROWS],
            run_started_at=_now_iso(),
        )
    raise BenchUnavailable(
        f"intrinsic suite {suite!r} requires the operator to stage the corpus + "
        "the ONNX model (--onnx + --corpus-manifest) and to install "
        "elizaos-voice-emotion-bench with the [audio,onnx] extras. The smoke "
        "test exercises `--suite fixture` end-to-end.",
    )


def run_fidelity(
    *,
    duet_host: str,
    emotions: Sequence[str],
    rounds: int,
) -> BenchOutput:
    """Closed-loop emotion fidelity — drive an eliza-1 duet pair, synthesize
    `e_intended`, classify the perceived audio, score `f1(e_intended,
    e_perceived)`. Real path requires a running duet pair and `httpx`.
    """
    del duet_host, emotions, rounds
    raise BenchUnavailable(
        "fidelity suite requires a running duet pair "
        "(`packages/app-core/scripts/voice-duet.mjs`) reachable on --duet-host. "
        "Smoke test does not exercise the network path.",
    )


def run_text_intrinsic(
    *,
    suite: str,
    model: str,
    corpus_manifest: pathlib.Path | None = None,
    api_base: str | None = None,
) -> BenchOutput:
    """Text-emotion classifier intrinsic accuracy on GoEmotions (or the
    bundled fixture for CI smoke).

    The two adapters under test:
      - `stage1-lm` — POSTs to an eliza-1 API and reads the Stage-1
        envelope `emotion` field-evaluator value.
      - `roberta-go-emotions` — loads `SamLowe/roberta-base-go_emotions-onnx`
        and projects 28 → 7.
    """
    if suite == "fixture":
        return _build_output(
            suite=suite,
            model=model,
            rows=_FIXTURE_ROWS,
            latencies_ms=[12.0 for _ in _FIXTURE_ROWS],
            run_started_at=_now_iso(),
        )
    del corpus_manifest, api_base
    raise BenchUnavailable(
        f"text-intrinsic suite {suite!r} requires the operator to stage the "
        "GoEmotions test split + an adapter. Smoke test exercises "
        "`--suite fixture`.",
    )
