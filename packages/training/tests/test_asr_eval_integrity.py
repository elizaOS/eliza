"""ASR metrics must cover the validation set and use measured word errors."""

from types import SimpleNamespace

import pytest

from eliza_training.asr import finetune_asr


def test_wer_requires_metric_dependency_and_validation_records():
    kwargs = dict(model=None, processor=None, records=[], cfg={}, device="cpu")
    with pytest.raises(RuntimeError, match="requires jiwer"):
        finetune_asr._evaluate_wer(**kwargs, jiwer=None)
    with pytest.raises(ValueError, match="non-empty"):
        finetune_asr._evaluate_wer(**kwargs, jiwer=SimpleNamespace())


def test_wer_does_not_drop_failed_validation_examples(monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("invalid audio")

    monkeypatch.setattr(finetune_asr, "_extract_features", fail)
    with pytest.raises(
        RuntimeError, match="ASR evaluation failed for broken"
    ) as raised:
        finetune_asr._evaluate_wer(
            model=None,
            processor=None,
            records=[{"id": "broken", "wav": "bad.wav"}],
            cfg={"sample_rate": 16000, "mel_bins": 80},
            device="cpu",
            jiwer=SimpleNamespace(),
        )
    assert isinstance(raised.value.__cause__, OSError)
