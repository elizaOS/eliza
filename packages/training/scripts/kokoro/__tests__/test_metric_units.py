"""Unit tests for the metric helpers in `eval_kokoro.py`.

The Q1 metric audit (see `.swarm/impl/Q1-quality.md`) re-grounded the
kokoro eval on three corrections:

  1. UTMOS fallback flipped from `SQUIM_OBJECTIVE` (returns SI-SDR) to
     `SQUIM_SUBJECTIVE` (returns MOS).
  2. Synth audio is resampled from 24 kHz → 16 kHz before Whisper +
     ECAPA-TDNN.
  3. WER inputs go through text normalization before edit-distance.

This module pins the math for the three helpers that landed during
that fix so they cannot regress silently. The pipeline-level eval is
covered by `test_baseline_eval.py`; here we only exercise the pure
functions (no torch / kokoro / whisper / speechbrain imports).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

# `conftest.py` puts `packages/training/scripts/kokoro/` on `sys.path`
# so we can import the module by name.
import eval_kokoro  # type: ignore  # noqa: E402


# ---------------------------------------------------------------------------
# _normalize_text_for_wer
# ---------------------------------------------------------------------------


class TestNormalizeTextForWer:
    """Pin the normalizer's behaviour.

    The contract is: lowercase, strip punctuation (including unicode
    quotes / em-dashes / CJK punctuation), collapse whitespace,
    preserve apostrophes inside contractions. The last point matters
    because Whisper emits "don't" / "I'm" as single tokens — we want
    the reference text to match that tokenization rather than splitting
    on the apostrophe.
    """

    def test_lowercases_and_strips_basic_punctuation(self) -> None:
        assert eval_kokoro._normalize_text_for_wer("Hi.") == "hi"
        assert eval_kokoro._normalize_text_for_wer("Hello, World!") == "hello world"
        assert (
            eval_kokoro._normalize_text_for_wer("Wait... what?")
            == "wait what"
        )

    def test_strips_unicode_quotes_and_em_dashes(self) -> None:
        # Smart quotes + em-dash + en-dash.
        src = "“Hi,” he said—really–really fast."
        assert eval_kokoro._normalize_text_for_wer(src) == "hi he said really really fast"

    def test_strips_cjk_punctuation(self) -> None:
        # Full-width period + comma + question mark.
        src = "Hello， world。 Are you there？"
        assert eval_kokoro._normalize_text_for_wer(src) == "hello world are you there"

    def test_collapses_whitespace(self) -> None:
        assert (
            eval_kokoro._normalize_text_for_wer("  too    much   space\t\there ")
            == "too much space here"
        )

    def test_preserves_apostrophe_in_contractions(self) -> None:
        # Pinned convention: apostrophes stay so "I'm" remains one token.
        # Whisper emits "I'm" as one token; the reference must match.
        assert eval_kokoro._normalize_text_for_wer("I'm fine.") == "i'm fine"
        assert eval_kokoro._normalize_text_for_wer("Don't go.") == "don't go"
        assert eval_kokoro._normalize_text_for_wer("It's a test.") == "it's a test"

    def test_empty_string_returns_empty(self) -> None:
        assert eval_kokoro._normalize_text_for_wer("") == ""
        assert eval_kokoro._normalize_text_for_wer("   ") == ""
        # Pure punctuation collapses to empty.
        assert eval_kokoro._normalize_text_for_wer("!!!??? ...") == ""


# ---------------------------------------------------------------------------
# _word_error_rate
# ---------------------------------------------------------------------------


class TestWordErrorRate:
    """Pin the Wagner–Fischer WER on normalized inputs.

    The contract: WER = edits / len(ref_tokens). Edits = sum of
    substitutions + insertions + deletions. Normalization happens
    inside `_word_error_rate` so callers do not need to pre-normalize.
    """

    def test_identical_strings_after_normalization_return_zero(self) -> None:
        assert eval_kokoro._word_error_rate("Hi.", "hi") == 0.0
        assert eval_kokoro._word_error_rate("Hello, world!", "hello world") == 0.0
        # Identical even before normalization.
        assert eval_kokoro._word_error_rate("a b c", "a b c") == 0.0

    def test_empty_hypothesis_against_nonempty_reference_returns_one(self) -> None:
        # 3 deletions / 3 ref tokens = 1.0.
        assert eval_kokoro._word_error_rate("alpha beta gamma", "") == 1.0
        # Same when the hypothesis normalizes to empty.
        assert eval_kokoro._word_error_rate("alpha beta gamma", "...") == 1.0

    def test_empty_reference_against_empty_hypothesis_returns_zero(self) -> None:
        assert eval_kokoro._word_error_rate("", "") == 0.0
        # Pure punctuation in both collapses to empty.
        assert eval_kokoro._word_error_rate(".", "?") == 0.0

    def test_empty_reference_against_nonempty_hypothesis_returns_one(self) -> None:
        # The convention for ref=∅, hyp≠∅ is WER=1 — surfaces the bad
        # input rather than dividing by zero.
        assert eval_kokoro._word_error_rate("", "spurious words") == 1.0

    def test_single_substitution_in_three_word_sentence(self) -> None:
        # ref = "the quick fox"  (3 tokens)
        # hyp = "the slow fox"   (1 substitution: quick→slow)
        # WER = 1/3 ≈ 0.3333
        wer = eval_kokoro._word_error_rate("the quick fox", "the slow fox")
        assert math.isclose(wer, 1.0 / 3.0, rel_tol=1e-9)

    def test_single_deletion_in_three_word_sentence(self) -> None:
        # ref = "the quick fox", hyp = "the fox" → 1 deletion → 1/3.
        wer = eval_kokoro._word_error_rate("the quick fox", "the fox")
        assert math.isclose(wer, 1.0 / 3.0, rel_tol=1e-9)

    def test_single_insertion_in_three_word_sentence(self) -> None:
        # ref = "the quick fox", hyp = "the quick brown fox" → 1 insertion
        # → 1/3.
        wer = eval_kokoro._word_error_rate("the quick fox", "the quick brown fox")
        assert math.isclose(wer, 1.0 / 3.0, rel_tol=1e-9)

    def test_punctuation_does_not_inflate_wer(self) -> None:
        # Pre-Q1 fix this would have counted as a substitution per period.
        # Post-Q1 fix both sides normalize to the same tokens.
        assert eval_kokoro._word_error_rate("Hi, there.", "hi there") == 0.0


# ---------------------------------------------------------------------------
# _resample_audio
# ---------------------------------------------------------------------------


class TestResampleAudio:
    """Pin the resample helper's length contract.

    Kokoro emits 24 kHz; Whisper + ECAPA-TDNN want 16 kHz. The Q1 fix
    routes synth audio through `_resample_audio` before either model.
    """

    def test_identity_when_rates_match(self) -> None:
        audio = np.linspace(-1.0, 1.0, 24_000, dtype=np.float32)
        out = eval_kokoro._resample_audio(audio, src_sr=24_000, dst_sr=24_000)
        # Identity return — the helper short-circuits when src==dst.
        assert out is audio

    def test_24k_to_16k_length(self) -> None:
        # librosa is an optional dep — the rest of the kokoro test
        # suite does not require it, so skip when missing.
        librosa = pytest.importorskip("librosa")
        n_src = 24_000  # 1 second @ 24 kHz
        audio = np.zeros(n_src, dtype=np.float32)
        out = eval_kokoro._resample_audio(audio, src_sr=24_000, dst_sr=16_000)
        # Expected: ceil(N * 16000/24000) ± 1.
        expected = math.ceil(n_src * 16_000 / 24_000)
        assert abs(len(out) - expected) <= 1, (
            f"len(out)={len(out)} expected≈{expected} (librosa={librosa.__version__})"
        )

    def test_24k_to_16k_short_clip(self) -> None:
        # Smaller window to keep the test fast — 0.1 s at 24 kHz.
        pytest.importorskip("librosa")
        n_src = 2_400
        audio = np.zeros(n_src, dtype=np.float32)
        out = eval_kokoro._resample_audio(audio, src_sr=24_000, dst_sr=16_000)
        expected = math.ceil(n_src * 16_000 / 24_000)
        assert abs(len(out) - expected) <= 1


# ---------------------------------------------------------------------------
# RTF math via _measure_rtf
# ---------------------------------------------------------------------------


class TestRtfMath:
    """Pin the sign convention: RTF = synth_seconds / wall_seconds.

    Higher RTF = faster than realtime. Gate threshold (rtf_min ≥ 5.0)
    requires the synth to render at least 5× faster than realtime.
    """

    def test_rtf_is_audio_seconds_over_wall_seconds(self, monkeypatch) -> None:
        # Fake `time.time()` to step deterministically: each synth call
        # advances wall-clock by 0.5 s.
        ticks = iter([0.0, 0.5, 1.0, 1.5, 2.0])

        def fake_time() -> float:
            return next(ticks)

        monkeypatch.setattr(eval_kokoro.time, "time", fake_time)

        # Fake synth: returns 5 s of audio at 16 kHz on every call.
        # Two calls → total_audio=10s, total_wall=1.0s → RTF=10.0.
        audio = np.zeros(80_000, dtype=np.float32)

        def fake_synth(_prompt: str) -> tuple[np.ndarray, int]:
            return audio, 16_000

        rtf, total_audio = eval_kokoro._measure_rtf(
            fake_synth, ["p1", "p2"], device="cpu"
        )
        assert math.isclose(total_audio, 10.0, rel_tol=1e-9)
        assert math.isclose(rtf, 10.0, rel_tol=1e-9)

    def test_rtf_above_one_is_faster_than_realtime(self, monkeypatch) -> None:
        # 1 s of audio rendered in 0.1 s wall → RTF=10.0 (10× realtime).
        ticks = iter([0.0, 0.1])
        monkeypatch.setattr(eval_kokoro.time, "time", lambda: next(ticks))
        audio = np.zeros(16_000, dtype=np.float32)
        rtf, total_audio = eval_kokoro._measure_rtf(
            lambda _p: (audio, 16_000), ["p"], device="cpu"
        )
        assert math.isclose(total_audio, 1.0, rel_tol=1e-9)
        assert math.isclose(rtf, 10.0, rel_tol=1e-9)
        # Sign convention: RTF ≥ 5.0 passes the gate.
        assert rtf >= 5.0

    def test_rtf_below_one_is_slower_than_realtime(self, monkeypatch) -> None:
        # 1 s of audio rendered in 4 s wall → RTF=0.25 (slow).
        ticks = iter([0.0, 4.0])
        monkeypatch.setattr(eval_kokoro.time, "time", lambda: next(ticks))
        audio = np.zeros(16_000, dtype=np.float32)
        rtf, _ = eval_kokoro._measure_rtf(
            lambda _p: (audio, 16_000), ["p"], device="cpu"
        )
        assert math.isclose(rtf, 0.25, rel_tol=1e-9)
        # Sign convention: RTF < 5.0 fails the gate.
        assert rtf < 5.0

    def test_rtf_zero_wall_returns_zero(self, monkeypatch) -> None:
        # Degenerate: instantaneous synth. Helper returns 0.0 to avoid
        # division-by-zero rather than raising.
        ticks = iter([0.0, 0.0])
        monkeypatch.setattr(eval_kokoro.time, "time", lambda: next(ticks))
        audio = np.zeros(16_000, dtype=np.float32)
        rtf, _ = eval_kokoro._measure_rtf(
            lambda _p: (audio, 16_000), ["p"], device="cpu"
        )
        assert rtf == 0.0
