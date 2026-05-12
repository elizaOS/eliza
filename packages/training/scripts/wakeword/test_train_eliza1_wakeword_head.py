"""Unit tests for the Eliza-1 wake-word head trainer (no network / no audio).

Covers the pure pieces — head architecture, the threshold picker, the ONNX
export shape (the runtime contract `[1, 16, 96]` → scalar), and a tiny
end-to-end fit on synthetic embedding windows so a real run on the training box
is exercised here in miniature. Skips cleanly when torch/onnx aren't installed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.wakeword import train_eliza1_wakeword_head as tw

torch = pytest.importorskip("torch")


def test_default_phrase_is_hey_eliza() -> None:
    assert tw.DEFAULT_PHRASE == "hey eliza"


def test_runtime_window_constants_match_wakeword_ts() -> None:
    # These mirror voice/wake-word.ts; if the runtime changes the head window
    # this test fails and the trainer must be re-pointed.
    assert (tw.HEAD_WINDOW_EMBEDDINGS, tw.EMBEDDING_DIM) == (16, 96)
    assert tw.SAMPLE_RATE == 16_000


def test_head_forward_shape() -> None:
    model = tw.build_head_module()
    x = torch.zeros(3, tw.HEAD_WINDOW_EMBEDDINGS, tw.EMBEDDING_DIM, dtype=torch.float32)
    out = model(x)
    assert out.shape == (3,)
    assert ((out >= 0) & (out <= 1)).all()


def test_threshold_picker_prefers_low_false_accept() -> None:
    # Negatives clustered low, positives high → a clean separation; the picker
    # returns the smallest threshold keeping held-out FA <= 0.5%.
    pos = [0.92, 0.95, 0.88, 0.99]
    neg = [0.01, 0.02, 0.05, 0.03, 0.0]
    t = tw._pick_threshold(pos, neg)
    assert 0.1 <= t <= 0.95
    fa = sum(1 for s in neg if s >= t) / len(neg)
    assert fa <= 0.005


def test_export_head_onnx_shape(tmp_path: Path) -> None:
    onnx = pytest.importorskip("onnx")
    model = tw.build_head_module()
    out = tmp_path / "head.onnx"
    tw.export_head_onnx(model, out)
    assert out.is_file() and out.stat().st_size > 0
    m = onnx.load(str(out))
    inp = m.graph.input[0]
    dims = [d.dim_value for d in inp.type.tensor_type.shape.dim]
    # [batch(dynamic→0), 16, 96]
    assert dims[1:] == [tw.HEAD_WINDOW_EMBEDDINGS, tw.EMBEDDING_DIM]


def test_tiny_real_fit_separates_synthetic_classes(tmp_path: Path) -> None:
    """A miniature real run: positives = a fixed pattern + noise, negatives = noise.

    Not a wake-word model — just proof the train→export path produces a head
    that fits and exports. The training box runs the same code at scale.
    """
    torch.manual_seed(0)
    base = torch.randn(tw.HEAD_WINDOW_EMBEDDINGS, tw.EMBEDDING_DIM)
    pos = [(base + 0.1 * torch.randn_like(base)).tolist() for _ in range(120)]
    neg = [(0.1 * torch.randn_like(base)).tolist() for _ in range(120)]
    model, metrics = tw.train_head(pos, neg, epochs=8, seed=0)
    assert 0.1 <= metrics["threshold"] <= 0.95
    assert metrics["trueAcceptRate"] >= 0.5  # the pattern is learnable in 8 epochs
    out = tmp_path / "tiny-head.onnx"
    try:
        import onnx  # noqa: F401
    except ImportError:
        out = None  # ONNX export needs `onnx` (not in the lean test env)
    else:
        tw.export_head_onnx(model, out)
        assert out.is_file()
    prov = tmp_path / "tiny.provenance.json"
    tw.write_provenance(
        prov,
        phrase="hey eliza",
        head_onnx=out or tmp_path / "missing.onnx",
        metrics=metrics,
        tts_source="synthetic (unit test)",
        n_positives=120,
        n_negatives=120,
    )
    import json

    blob = json.loads(prov.read_text())
    assert blob["wakePhrase"] == "hey eliza"
    assert blob["runtimeContract"]["inputShape"] == [1, 16, 96]
