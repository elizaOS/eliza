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

from scripts.wakeword import train_eliza1_wakeword_head as tw  # noqa: E402

torch = pytest.importorskip("torch")


def test_default_phrase_is_hey_eliza() -> None:
    assert tw.DEFAULT_PHRASE == "hey eliza"


def test_runtime_window_constants_match_wakeword_ts() -> None:
    # These mirror voice/wake-word.ts; if the runtime changes the head window
    # this test fails and the trainer must be re-pointed.
    assert (tw.HEAD_WINDOW_EMBEDDINGS, tw.EMBEDDING_DIM) == (16, 96)
    assert tw.SAMPLE_RATE == 16_000


def test_mel_rescale_flag_controls_front_end_preprocessing(monkeypatch) -> None:
    """`mel_rescale` toggles openWakeWord's `mel/10 + 2` step.

    The wakeword-cpp C runtime feeds the raw log-mel into the embedding model
    (no rescale), so a head meant for that runtime must be trained with
    `mel_rescale=False`. A head trained with the rescale fires on only a
    fraction of positives through that runtime (measured ~31% true-accept vs
    ~99% once parity is restored). This guards the plumbing without needing
    onnxruntime: a fake mel session lets us observe the embedding input.

    """
    np = pytest.importorskip("numpy")

    class _FakeSession:
        def __init__(self, out):
            self._out = out

        def get_inputs(self):
            class _I:
                name = "x"

            return [_I()]

        def run(self, _names, _feed):
            return [self._out]

    # mel session returns a fixed [n_frames, 32] block; emb session echoes the
    # mean of its input window so we can read back what scale it received.
    n_frames = tw.EMBEDDING_WINDOW_FRAMES + 8
    raw_mel = np.full((n_frames, tw.MEL_BINS), -40.0, dtype=np.float32)
    captured: dict[str, float] = {}

    class _EmbSession(_FakeSession):
        def run(self, _names, feed):
            win = list(feed.values())[0]
            captured["mean"] = float(np.asarray(win).mean())
            return [np.zeros((1, tw.EMBEDDING_DIM), dtype=np.float32)]

    def _make(rescale: bool):
        fe = tw.OpenWakeWordFrontEnd.__new__(tw.OpenWakeWordFrontEnd)
        fe.mel = _FakeSession(raw_mel[None, :, :])
        fe.emb = _EmbSession(None)
        fe.mel_rescale = rescale
        return fe

    _make(rescale=True).embedding_windows([0.0] * 100)
    with_rescale = captured["mean"]
    _make(rescale=False).embedding_windows([0.0] * 100)
    without_rescale = captured["mean"]

    # raw mel is -40; without rescale the embedding sees ~-40, with rescale it
    # sees -40/10 + 2 = -2.
    assert without_rescale == pytest.approx(-40.0, abs=1e-3)
    assert with_rescale == pytest.approx(-2.0, abs=1e-3)


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
        mel_rescale=False,
    )
    import json

    blob = json.loads(prov.read_text())
    assert blob["wakePhrase"] == "hey eliza"
    assert blob["runtimeContract"]["inputShape"] == [1, 16, 96]
    # The provenance must honestly record the mel preprocessing — a head trained
    # `--no-mel-rescale` (runtime parity) must not claim the upstream rescale.
    assert blob["melRescale"] is False
    assert "no rescale" in blob["runtimeContract"]["frontEnd"]
