"""Deterministic meeting transcription/diarization scoring + baseline comparison.

Model-free metric computation for the meeting benchmark: given a *reference*
speaker-turn set (e.g. a Zoom ``transcript.vtt`` parsed by ``zoom_vtt.py``) and a
*hypothesis* set (a system-under-test's transcript/diarization output), compute:

  * ``word_error_rate`` — token-level Levenshtein / reference length (the
    ``voicebench`` definition);
  * ``diarization_error_rate`` — (missed + false-alarm + confusion) time over
    total reference speech time, under the speaker label mapping that maximises
    overlap (the standard DER shape used by ``voice-speaker-validation`` /
    pyannote; mapping here is greedy, which matches optimal for the
    non-overlapping meeting-turn case);
  * ``speaker_attribution_accuracy`` — fraction of reference speech time whose
    mapped hypothesis speaker is correct.

``compare_to_baseline`` renders a ``compare.py``-style report (candidate vs a
reference/baseline system, with per-metric deltas and an overall pass), so a
publishable run compares an elizaOS transcript/diarization path to a Whisper/
pyannote baseline rather than to a fabricated number.

Everything here is deterministic and needs no model or audio — the scoring is
exercised against synthetic span sets in the tests. Producing the *hypothesis*
from real audio (running an ASR/diarizer) is the human-gated publishable step.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

# A scored span is any object exposing start_ms/end_ms/text/speaker; we accept
# either the zoom_vtt.TranscriptSpan dataclass or a plain dict-like via keys.


@dataclass(frozen=True)
class Span:
    start_ms: int
    end_ms: int
    text: str
    speaker: str

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)


def _coerce(span: object) -> Span:
    if isinstance(span, Span):
        return span
    if isinstance(span, dict):
        return Span(
            start_ms=int(span["startMs" if "startMs" in span else "start_ms"]),
            end_ms=int(span["endMs" if "endMs" in span else "end_ms"]),
            text=str(span.get("text", "")),
            speaker=str(
                span.get("speakerId")
                or span.get("speaker")
                or span.get("speaker_label")
                or "UNIDENTIFIED"
            ),
        )
    # zoom_vtt.TranscriptSpan (has speaker_label, no speaker field)
    return Span(
        start_ms=int(getattr(span, "start_ms")),
        end_ms=int(getattr(span, "end_ms")),
        text=str(getattr(span, "text", "")),
        speaker=str(getattr(span, "speaker_label", getattr(span, "speaker", "UNIDENTIFIED"))),
    )


def _spans(seq: Iterable[object]) -> list[Span]:
    return [_coerce(s) for s in seq]


def _tokenize(text: str) -> list[str]:
    return text.lower().split()


def _levenshtein(ref: Sequence[str], hyp: Sequence[str]) -> int:
    """Edit distance (substitutions + insertions + deletions) over token lists."""
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, start=1):
        cur = [i]
        for j, h in enumerate(hyp, start=1):
            cost = 0 if r == h else 1
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[-1]


def word_error_rate(reference_text: str, hypothesis_text: str) -> float:
    ref = _tokenize(reference_text)
    hyp = _tokenize(hypothesis_text)
    if not ref:
        return 0.0 if not hyp else 1.0
    return _levenshtein(ref, hyp) / len(ref)


def transcript_wer(reference: Iterable[object], hypothesis: Iterable[object]) -> float:
    """WER over the concatenated span texts (turn order preserved)."""
    ref_text = " ".join(s.text for s in _spans(reference))
    hyp_text = " ".join(s.text for s in _spans(hypothesis))
    return word_error_rate(ref_text, hyp_text)


def _overlap_ms(a: Span, b: Span) -> int:
    return max(0, min(a.end_ms, b.end_ms) - max(a.start_ms, b.start_ms))


def _greedy_speaker_mapping(
    ref: list[Span], hyp: list[Span]
) -> dict[str, str]:
    """Map each hyp speaker to the ref speaker it overlaps most (greedy, 1:1)."""
    overlap: dict[tuple[str, str], int] = {}
    for h in hyp:
        for r in ref:
            ms = _overlap_ms(h, r)
            if ms:
                overlap[(h.speaker, r.speaker)] = overlap.get((h.speaker, r.speaker), 0) + ms
    mapping: dict[str, str] = {}
    used_ref: set[str] = set()
    for (h_spk, r_spk), _ms in sorted(overlap.items(), key=lambda kv: -kv[1]):
        if h_spk in mapping or r_spk in used_ref:
            continue
        mapping[h_spk] = r_spk
        used_ref.add(r_spk)
    return mapping


def diarization_error_rate(reference: Iterable[object], hypothesis: Iterable[object]) -> float:
    """Standard DER = (missed + false_alarm + confusion) / total reference speech.

    Assumes non-overlapping turns (the meeting-transcript case): at each instant
    at most one reference and one hypothesis speaker are active.
    """
    ref = _spans(reference)
    hyp = _spans(hypothesis)
    total_ref = sum(s.duration_ms for s in ref)
    if total_ref == 0:
        return 0.0
    mapping = _greedy_speaker_mapping(ref, hyp)

    missed = 0
    confusion = 0
    for r in ref:
        covered = 0
        correct = 0
        for h in hyp:
            ms = _overlap_ms(r, h)
            if not ms:
                continue
            covered += ms
            if mapping.get(h.speaker) == r.speaker:
                correct += ms
        missed += r.duration_ms - covered  # ref speech with no hyp
        confusion += covered - correct  # covered but wrong speaker
    total_hyp = sum(s.duration_ms for s in hyp)
    # False alarm: hyp speech outside any ref span.
    fa = 0
    for h in hyp:
        overlapped = sum(_overlap_ms(h, r) for r in ref)
        fa += h.duration_ms - overlapped
    _ = total_hyp
    return (missed + fa + confusion) / total_ref


def speaker_attribution_accuracy(
    reference: Iterable[object], hypothesis: Iterable[object]
) -> float:
    """Fraction of reference speech time whose mapped hyp speaker is correct."""
    ref = _spans(reference)
    hyp = _spans(hypothesis)
    total_ref = sum(s.duration_ms for s in ref)
    if total_ref == 0:
        return 1.0
    mapping = _greedy_speaker_mapping(ref, hyp)
    correct = 0
    for r in ref:
        for h in hyp:
            ms = _overlap_ms(r, h)
            if ms and mapping.get(h.speaker) == r.speaker:
                correct += ms
    return correct / total_ref


def score_transcript(reference: Iterable[object], hypothesis: Iterable[object]) -> dict:
    """All three deterministic metrics for one (reference, hypothesis) pair."""
    ref = list(reference)
    hyp = list(hypothesis)
    return {
        "transcript_word_error_rate": round(transcript_wer(ref, hyp), 6),
        "diarization_error_rate": round(diarization_error_rate(ref, hyp), 6),
        "speaker_attribution_accuracy": round(speaker_attribution_accuracy(ref, hyp), 6),
    }


# Lower-is-better metrics (a smaller candidate value is an improvement).
_LOWER_IS_BETTER = {"transcript_word_error_rate", "diarization_error_rate"}


def compare_to_baseline(
    reference: Iterable[object],
    candidate_hypothesis: Iterable[object],
    baseline_hypothesis: Iterable[object],
    noise_threshold: float = 0.01,
) -> dict:
    """compare.py-style report: candidate vs a baseline system on the same reference.

    ``baseline_hypothesis`` is a reference system's output (e.g. Whisper +
    pyannote), NOT a fabricated number. ``passed`` is True when the candidate is
    no worse than the baseline beyond ``noise_threshold`` on every metric.
    """
    ref = list(reference)
    cand = score_transcript(ref, list(candidate_hypothesis))
    base = score_transcript(ref, list(baseline_hypothesis))
    metrics = {}
    overall_pass = True
    for name in cand:
        c, b = cand[name], base[name]
        # Normalise so "delta >= -threshold means pass" holds for both directions.
        improvement = (b - c) if name in _LOWER_IS_BETTER else (c - b)
        passed = improvement >= -noise_threshold
        overall_pass = overall_pass and passed
        metrics[name] = {
            "candidate": c,
            "baseline": b,
            "improvement": round(improvement, 6),
            "lower_is_better": name in _LOWER_IS_BETTER,
            "passed": passed,
        }
    return {
        "metrics": metrics,
        "noise_threshold": noise_threshold,
        "passed": overall_pass,
    }
