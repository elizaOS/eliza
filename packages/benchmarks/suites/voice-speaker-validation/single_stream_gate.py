"""Single-stream multi-speaker meeting gate.

This module validates diarization artifacts for the case where one platform
participant/tile contains several acoustic speakers, such as a conference-room
microphone or shared laptop. It is intentionally artifact-level: real audio and
model runs can feed the same schema, while deterministic tests prove that the
gate catches the two regressions called out in #12493.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from itertools import count
from typing import Any


REQUIRED_SPEAKER_COUNTS = (2, 3, 5, 8)
REQUIRED_VARIANTS = ("clean", "music", "babble", "overlap", "far_field", "reverberant")
ROOM_FEED_FLAGS = ("room_feed_suspected", "multi_speaker_room")
PLATFORM_PARTICIPANT_ID = "platform-room-tile-1"


@dataclass(frozen=True)
class ReferenceTurn:
    speaker_id: str
    start_ms: int
    end_ms: int
    text: str
    overlaps: bool = False


@dataclass(frozen=True)
class HypothesisTurn:
    diarized_speaker_id: str
    platform_participant_id: str
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class SingleStreamScenario:
    scenario_id: str
    speaker_count: int
    acoustic_variant: str
    source_platform_participant_id: str
    source_stream_id: str
    room_feed_evidence: tuple[str, ...]
    reference_turns: tuple[ReferenceTurn, ...]


def build_single_stream_scenarios() -> list[SingleStreamScenario]:
    """Build the deterministic #12493 scenario matrix."""
    scenarios: list[SingleStreamScenario] = []
    for speaker_count in REQUIRED_SPEAKER_COUNTS:
        for variant in REQUIRED_VARIANTS:
            scenario_id = f"single_stream_{speaker_count}spk_{variant}"
            source_stream_id = _source_stream_id(variant)
            scenarios.append(
                SingleStreamScenario(
                    scenario_id=scenario_id,
                    speaker_count=speaker_count,
                    acoustic_variant=variant,
                    source_platform_participant_id=PLATFORM_PARTICIPANT_ID,
                    source_stream_id=source_stream_id,
                    room_feed_evidence=ROOM_FEED_FLAGS,
                    reference_turns=tuple(_build_reference_turns(speaker_count, variant)),
                )
            )
    return scenarios


def build_reference_hypothesis(scenario: SingleStreamScenario) -> list[HypothesisTurn]:
    """Create a perfect hypothesis artifact for a scenario."""
    return [
        HypothesisTurn(
            diarized_speaker_id=f"{scenario.source_platform_participant_id}/{turn.speaker_id}",
            platform_participant_id=scenario.source_platform_participant_id,
            start_ms=turn.start_ms,
            end_ms=turn.end_ms,
            text=turn.text,
        )
        for turn in scenario.reference_turns
    ]


def evaluate_single_stream_gate(
    scenario: SingleStreamScenario,
    hypothesis_turns: list[HypothesisTurn],
) -> dict[str, Any]:
    """Evaluate one single-stream diarization artifact and return a report dict."""
    diarized_speaker_ids = tuple(
        dict.fromkeys(turn.diarized_speaker_id for turn in hypothesis_turns)
    )
    platform_ids = tuple(dict.fromkeys(turn.platform_participant_id for turn in hypothesis_turns))
    mapping = _map_hypothesis_speakers(scenario.reference_turns, hypothesis_turns)
    coverage = _speaker_coverage(scenario.reference_turns, hypothesis_turns, mapping)
    disappeared = tuple(
        speaker_id
        for speaker_id, covered_ratio in coverage.items()
        if covered_ratio < 0.5
    )

    der, overlap_der = _der_metrics(scenario.reference_turns, hypothesis_turns, mapping)
    jer = _jer(scenario.reference_turns, hypothesis_turns, mapping)
    speaker_attribution_errors = _speaker_attribution_errors(
        scenario.reference_turns, hypothesis_turns, mapping
    )
    total_ref_words = sum(len(_tokens(turn.text)) for turn in scenario.reference_turns)
    wder = speaker_attribution_errors / max(total_ref_words, 1)
    cpwer = _word_error_rate(scenario.reference_turns, hypothesis_turns, mapping)
    boundary_error_ms = _turn_boundary_error_ms(
        scenario.reference_turns, hypothesis_turns, mapping
    )
    tcpwer = min(1.0, cpwer + boundary_error_ms / 100_000)

    failures = _gate_failures(
        scenario=scenario,
        detected_speaker_count=len(diarized_speaker_ids),
        platform_ids=platform_ids,
        disappeared_speakers=disappeared,
        der=der,
        overlap_der=overlap_der,
    )

    return {
        "scenario_id": scenario.scenario_id,
        "source_platform_participant_id": scenario.source_platform_participant_id,
        "source_stream_id": scenario.source_stream_id,
        "acoustic_variant": scenario.acoustic_variant,
        "expected_speaker_count": scenario.speaker_count,
        "detected_speaker_count": len(diarized_speaker_ids),
        "diarized_speaker_ids": list(diarized_speaker_ids),
        "platform_participant_ids": list(platform_ids),
        "room_feed_evidence": list(scenario.room_feed_evidence),
        "metrics": {
            "speaker_count_accuracy": 1.0
            if len(diarized_speaker_ids) == scenario.speaker_count
            else 0.0,
            "der": round(der, 4),
            "jer": round(jer, 4),
            "wder": round(wder, 4),
            "overlap_der": round(overlap_der, 4),
            "cpwer": round(cpwer, 4),
            "tcpwer": round(tcpwer, 4),
            "speaker_attribution_errors": speaker_attribution_errors,
            "disappeared_speaker_count": len(disappeared),
            "over_split_count": max(0, len(diarized_speaker_ids) - scenario.speaker_count),
            "under_split_count": max(0, scenario.speaker_count - len(diarized_speaker_ids)),
            "speaker_turn_boundary_timing_error_ms": round(boundary_error_ms, 2),
        },
        "disappeared_speakers": list(disappeared),
        "speaker_mapping": dict(mapping),
        "pass": not failures,
        "failures": failures,
    }


def scenario_to_manifest(scenario: SingleStreamScenario) -> dict[str, Any]:
    """Serialize a scenario for fixture/report artifacts."""
    payload = asdict(scenario)
    payload["room_feed_evidence"] = list(scenario.room_feed_evidence)
    payload["reference_turns"] = [asdict(turn) for turn in scenario.reference_turns]
    return payload


def _source_stream_id(variant: str) -> str:
    if variant == "far_field":
        return "room-mic-far-field"
    if variant == "reverberant":
        return "room-mic-reverb"
    return "room-mic-mixed"


def _build_reference_turns(speaker_count: int, variant: str) -> list[ReferenceTurn]:
    turns: list[ReferenceTurn] = []
    cursor = 0
    turn_counter = count(1)
    for index in range(speaker_count * 2):
        speaker_number = index % speaker_count + 1
        duration = 900 + (index % 3) * 180
        overlaps = variant == "overlap" and index % 2 == 1
        start_ms = max(0, cursor - 320) if overlaps else cursor
        end_ms = start_ms + duration
        speaker_id = f"room_speaker_{speaker_number}"
        turns.append(
            ReferenceTurn(
                speaker_id=speaker_id,
                start_ms=start_ms,
                end_ms=end_ms,
                text=(
                    f"{speaker_id} turn {next(turn_counter)} "
                    f"{variant.replace('_', ' ')} checkpoint"
                ),
                overlaps=overlaps,
            )
        )
        cursor = end_ms + 160
    return turns


def _intersection_ms(
    left_start_ms: int,
    left_end_ms: int,
    right_start_ms: int,
    right_end_ms: int,
) -> int:
    return max(0, min(left_end_ms, right_end_ms) - max(left_start_ms, right_start_ms))


def _duration_ms(turn: ReferenceTurn | HypothesisTurn) -> int:
    return max(0, turn.end_ms - turn.start_ms)


def _tokens(text: str) -> list[str]:
    return [part for part in text.lower().replace("/", " ").split() if part]


def _map_hypothesis_speakers(
    reference_turns: tuple[ReferenceTurn, ...],
    hypothesis_turns: list[HypothesisTurn],
) -> dict[str, str]:
    confusion: dict[tuple[str, str], int] = {}
    for hyp in hypothesis_turns:
        for ref in reference_turns:
            overlap = _intersection_ms(hyp.start_ms, hyp.end_ms, ref.start_ms, ref.end_ms)
            if overlap:
                key = (hyp.diarized_speaker_id, ref.speaker_id)
                confusion[key] = confusion.get(key, 0) + overlap

    mapping: dict[str, str] = {}
    for hyp_id in dict.fromkeys(turn.diarized_speaker_id for turn in hypothesis_turns):
        best_ref = ""
        best_overlap = -1
        for ref in dict.fromkeys(turn.speaker_id for turn in reference_turns):
            overlap = confusion.get((hyp_id, ref), 0)
            if overlap > best_overlap:
                best_ref = ref
                best_overlap = overlap
        if best_ref:
            mapping[hyp_id] = best_ref
    return mapping


def _speaker_coverage(
    reference_turns: tuple[ReferenceTurn, ...],
    hypothesis_turns: list[HypothesisTurn],
    mapping: dict[str, str],
) -> dict[str, float]:
    coverage: dict[str, int] = {
        speaker_id: 0 for speaker_id in dict.fromkeys(turn.speaker_id for turn in reference_turns)
    }
    totals: dict[str, int] = {speaker_id: 0 for speaker_id in coverage}
    for ref in reference_turns:
        totals[ref.speaker_id] += _duration_ms(ref)
        for hyp in hypothesis_turns:
            if mapping.get(hyp.diarized_speaker_id) != ref.speaker_id:
                continue
            coverage[ref.speaker_id] += _intersection_ms(
                ref.start_ms,
                ref.end_ms,
                hyp.start_ms,
                hyp.end_ms,
            )
    return {
        speaker_id: min(1.0, coverage[speaker_id] / max(total_ms, 1))
        for speaker_id, total_ms in totals.items()
    }


def _der_metrics(
    reference_turns: tuple[ReferenceTurn, ...],
    hypothesis_turns: list[HypothesisTurn],
    mapping: dict[str, str],
) -> tuple[float, float]:
    missed = 0
    speaker_error = 0
    overlap_missed = 0
    overlap_error = 0
    overlap_total = 0
    total_ref = sum(_duration_ms(turn) for turn in reference_turns)
    total_hyp = sum(_duration_ms(turn) for turn in hypothesis_turns)
    hyp_ref_overlap = 0

    for ref in reference_turns:
        ref_correct = 0
        ref_wrong = 0
        for hyp in hypothesis_turns:
            intersection = _intersection_ms(ref.start_ms, ref.end_ms, hyp.start_ms, hyp.end_ms)
            if not intersection:
                continue
            hyp_ref_overlap += intersection
            if mapping.get(hyp.diarized_speaker_id) != ref.speaker_id:
                ref_wrong += intersection
            else:
                ref_correct += intersection
        ref_missed = max(0, _duration_ms(ref) - min(_duration_ms(ref), ref_correct))
        ref_error = 0 if ref_missed == 0 else min(ref_wrong, ref_missed)
        missed += ref_missed
        speaker_error += ref_error
        if ref.overlaps:
            overlap_total += _duration_ms(ref)
            overlap_missed += ref_missed
            overlap_error += ref_error

    false_alarm = max(0, total_hyp - hyp_ref_overlap)
    der = (missed + speaker_error + false_alarm) / max(total_ref, 1)
    overlap_der = (
        (overlap_missed + overlap_error) / max(overlap_total, 1)
        if overlap_total
        else 0.0
    )
    return min(1.0, der), min(1.0, overlap_der)


def _jer(
    reference_turns: tuple[ReferenceTurn, ...],
    hypothesis_turns: list[HypothesisTurn],
    mapping: dict[str, str],
) -> float:
    speaker_ids = tuple(dict.fromkeys(turn.speaker_id for turn in reference_turns))
    errors: list[float] = []
    for speaker_id in speaker_ids:
        ref_duration = sum(
            _duration_ms(turn)
            for turn in reference_turns
            if turn.speaker_id == speaker_id
        )
        hyp_duration = sum(
            _duration_ms(turn)
            for turn in hypothesis_turns
            if mapping.get(turn.diarized_speaker_id) == speaker_id
        )
        intersection = 0
        for ref in reference_turns:
            if ref.speaker_id != speaker_id:
                continue
            for hyp in hypothesis_turns:
                if mapping.get(hyp.diarized_speaker_id) != speaker_id:
                    continue
                intersection += _intersection_ms(
                    ref.start_ms,
                    ref.end_ms,
                    hyp.start_ms,
                    hyp.end_ms,
                )
        union = max(ref_duration + hyp_duration - intersection, 1)
        errors.append(1.0 - min(1.0, intersection / union))
    return sum(errors) / max(len(errors), 1)


def _speaker_attribution_errors(
    reference_turns: tuple[ReferenceTurn, ...],
    hypothesis_turns: list[HypothesisTurn],
    mapping: dict[str, str],
) -> int:
    errors = 0
    for hyp in hypothesis_turns:
        best_ref: ReferenceTurn | None = None
        best_overlap = 0
        for ref in reference_turns:
            overlap = _intersection_ms(hyp.start_ms, hyp.end_ms, ref.start_ms, ref.end_ms)
            if overlap > best_overlap:
                best_ref = ref
                best_overlap = overlap
        if best_ref and mapping.get(hyp.diarized_speaker_id) != best_ref.speaker_id:
            errors += len(_tokens(hyp.text))
    return errors


def _word_error_rate(
    reference_turns: tuple[ReferenceTurn, ...],
    hypothesis_turns: list[HypothesisTurn],
    mapping: dict[str, str],
) -> float:
    speaker_ids = tuple(dict.fromkeys(turn.speaker_id for turn in reference_turns))
    edits = 0
    ref_words = 0
    for speaker_id in speaker_ids:
        reference_tokens = _tokens(
            " ".join(turn.text for turn in reference_turns if turn.speaker_id == speaker_id)
        )
        hypothesis_tokens = _tokens(
            " ".join(
                turn.text
                for turn in hypothesis_turns
                if mapping.get(turn.diarized_speaker_id) == speaker_id
            )
        )
        edits += _levenshtein(reference_tokens, hypothesis_tokens)
        ref_words += len(reference_tokens)
    return min(1.0, edits / max(ref_words, 1))


def _levenshtein(left: list[str], right: list[str]) -> int:
    previous = list(range(len(right) + 1))
    for i, left_token in enumerate(left, start=1):
        current = [i]
        for j, right_token in enumerate(right, start=1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (0 if left_token == right_token else 1),
                )
            )
        previous = current
    return previous[-1]


def _turn_boundary_error_ms(
    reference_turns: tuple[ReferenceTurn, ...],
    hypothesis_turns: list[HypothesisTurn],
    mapping: dict[str, str],
) -> float:
    errors: list[int] = []
    for ref in reference_turns:
        candidates = [
            hyp
            for hyp in hypothesis_turns
            if mapping.get(hyp.diarized_speaker_id) == ref.speaker_id
        ]
        if not candidates:
            continue
        best = max(
            candidates,
            key=lambda hyp: _intersection_ms(ref.start_ms, ref.end_ms, hyp.start_ms, hyp.end_ms),
        )
        errors.append(abs(ref.start_ms - best.start_ms) + abs(ref.end_ms - best.end_ms))
    return sum(errors) / max(len(errors), 1)


def _gate_failures(
    *,
    scenario: SingleStreamScenario,
    detected_speaker_count: int,
    platform_ids: tuple[str, ...],
    disappeared_speakers: tuple[str, ...],
    der: float,
    overlap_der: float,
) -> list[str]:
    failures: list[str] = []
    if detected_speaker_count < scenario.speaker_count:
        failures.append(
            f"detected {detected_speaker_count} speakers; expected {scenario.speaker_count}"
        )
    if detected_speaker_count > scenario.speaker_count:
        failures.append(
            f"detected {detected_speaker_count} speakers; expected no over-split"
        )
    if disappeared_speakers:
        failures.append(f"secondary speaker disappeared: {', '.join(disappeared_speakers)}")
    if scenario.acoustic_variant == "overlap" and detected_speaker_count == 1:
        failures.append("overlapping speech collapsed into one speaker")
    if platform_ids != (scenario.source_platform_participant_id,):
        failures.append(
            "source platform participant id was not preserved on every diarized turn"
        )
    for required_flag in ROOM_FEED_FLAGS:
        if required_flag not in scenario.room_feed_evidence:
            failures.append(f"missing room-feed evidence flag: {required_flag}")
    if der > 0.45:
        failures.append(f"DER {der:.3f} exceeds 0.45 gate")
    if scenario.acoustic_variant == "overlap" and overlap_der > 0.55:
        failures.append(f"overlap DER {overlap_der:.3f} exceeds 0.55 gate")
    return failures
