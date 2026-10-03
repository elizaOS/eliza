from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


REFERENCE_SCHEMA = "eliza.meeting_corpus_reference.v1"
MANIFEST_SCHEMA = "eliza.meeting_corpus_manifest.v1"


@dataclass(frozen=True)
class CorpusSpec:
    corpus_id: str
    name: str
    priority: str
    license: str
    citation: str
    required_paths: tuple[str, ...]
    annotation_coverage: dict[str, bool]
    metrics_supported: tuple[str, ...]


def _coverage(
    *,
    transcript: bool = False,
    word_timestamps: bool = False,
    speaker_turns: bool = False,
    overlap_labels: bool = False,
    channels: bool = False,
    video_frames: bool = False,
    noise_music: bool = False,
) -> dict[str, bool]:
    return {
        "transcript": transcript,
        "wordTimestamps": word_timestamps,
        "speakerTurns": speaker_turns,
        "overlapLabels": overlap_labels,
        "channels": channels,
        "videoFrames": video_frames,
        "noiseMusic": noise_music,
    }


P0_CORPUS_IDS = (
    "ami",
    "chime6",
    "chime7_dasr",
    "dipco",
    "libricss",
    "voxconverse",
    "dihard",
    "musan",
    "whamr",
    "librimix",
)

P1_CORPUS_IDS = ("aishell4", "alimeeting", "icsi", "misp2025", "ava_active_speaker", "easycom")


_REGISTRY: dict[str, CorpusSpec] = {
    "ami": CorpusSpec(
        "ami",
        "AMI Meeting Corpus",
        "P0",
        "AMI license / local acceptance required",
        "Carletta et al., The AMI Meeting Corpus",
        ("audio", "annotations/segments.json"),
        _coverage(transcript=True, word_timestamps=True, speaker_turns=True, channels=True),
        ("WER", "DER", "JER", "cpWER", "WDER"),
    ),
    "chime6": CorpusSpec(
        "chime6",
        "CHiME-6",
        "P0",
        "CHiME data license / local acceptance required",
        "CHiME-6 challenge corpus",
        ("audio", "transcriptions"),
        _coverage(transcript=True, speaker_turns=True, overlap_labels=True, channels=True),
        ("WER", "DER", "JER", "cpWER", "WDER", "overlapDER"),
    ),
    "chime7_dasr": CorpusSpec(
        "chime7_dasr",
        "CHiME-7 DASR",
        "P0",
        "CHiME data license / local acceptance required",
        "CHiME-7 DASR challenge corpus",
        ("audio", "annotations"),
        _coverage(transcript=True, speaker_turns=True, overlap_labels=True, channels=True),
        ("WER", "DER", "JER", "cpWER", "WDER", "overlapDER"),
    ),
    "dipco": CorpusSpec(
        "dipco",
        "DiPCo",
        "P0",
        "DiPCo license / local acceptance required",
        "Dinner Party Corpus",
        ("audio", "annotations"),
        _coverage(transcript=True, speaker_turns=True, overlap_labels=True, channels=True),
        ("WER", "DER", "JER", "cpWER", "WDER", "overlapDER"),
    ),
    "libricss": CorpusSpec(
        "libricss",
        "LibriCSS",
        "P0",
        "LibriCSS license / local acceptance required",
        "LibriCSS overlapped speech corpus",
        ("audio", "rttm"),
        _coverage(transcript=True, speaker_turns=True, overlap_labels=True, channels=True),
        ("WER", "DER", "JER", "cpWER", "WDER", "overlapDER"),
    ),
    "voxconverse": CorpusSpec(
        "voxconverse",
        "VoxConverse",
        "P0",
        "VoxConverse license / local acceptance required",
        "VoxConverse speaker diarization corpus",
        ("audio", "rttm"),
        _coverage(speaker_turns=True, overlap_labels=True),
        ("DER", "JER", "overlapDER"),
    ),
    "dihard": CorpusSpec(
        "dihard",
        "DIHARD",
        "P0",
        "DIHARD license / local acceptance required",
        "DIHARD diarization challenge corpus",
        ("audio", "rttm"),
        _coverage(speaker_turns=True, overlap_labels=True, channels=True),
        ("DER", "JER", "overlapDER"),
    ),
    "musan": CorpusSpec(
        "musan",
        "MUSAN",
        "P0",
        "MUSAN license / local acceptance required",
        "MUSAN music, speech, and noise corpus",
        ("music", "noise", "speech"),
        _coverage(noise_music=True),
        ("noiseCoverage", "snr"),
    ),
    "whamr": CorpusSpec(
        "whamr",
        "WHAM!/WHAMR!",
        "P0",
        "WHAMR license / local acceptance required",
        "WHAMR noisy reverberant speech separation corpus",
        ("audio", "metadata"),
        _coverage(transcript=True, speaker_turns=True, overlap_labels=True),
        ("WER", "DER", "cpWER", "WDER", "reverbStress"),
    ),
    "librimix": CorpusSpec(
        "librimix",
        "LibriMix / Libri2Mix / Libri3Mix",
        "P0",
        "LibriMix license / local acceptance required",
        "LibriMix multi-speaker mixture corpus",
        ("audio", "metadata"),
        _coverage(transcript=True, speaker_turns=True, overlap_labels=True),
        ("WER", "DER", "cpWER", "WDER", "overlapDER"),
    ),
    "aishell4": CorpusSpec(
        "aishell4",
        "AISHELL-4",
        "P1",
        "AISHELL-4 license / local acceptance required",
        "AISHELL-4 Mandarin meeting corpus",
        ("audio", "transcripts"),
        _coverage(transcript=True, speaker_turns=True, channels=True),
        ("WER", "CER", "DER", "JER"),
    ),
    "alimeeting": CorpusSpec(
        "alimeeting",
        "AliMeeting",
        "P1",
        "AliMeeting license / local acceptance required",
        "AliMeeting Mandarin meeting corpus",
        ("audio", "transcripts"),
        _coverage(transcript=True, speaker_turns=True, overlap_labels=True),
        ("WER", "CER", "DER", "JER", "cpWER"),
    ),
    "icsi": CorpusSpec(
        "icsi",
        "ICSI Meeting Corpus",
        "P1",
        "ICSI license / local acceptance required",
        "ICSI Meeting Corpus",
        ("audio", "annotations"),
        _coverage(transcript=True, speaker_turns=True, channels=True),
        ("WER", "DER", "JER", "cpWER"),
    ),
    "misp2025": CorpusSpec(
        "misp2025",
        "MISP 2025",
        "P1",
        "MISP terms / local acceptance required",
        "MISP 2025 challenge corpus",
        ("audio", "annotations"),
        _coverage(transcript=True, speaker_turns=True, overlap_labels=True, video_frames=True),
        ("WER", "CER", "DER", "activeSpeaker"),
    ),
    "ava_active_speaker": CorpusSpec(
        "ava_active_speaker",
        "AVA-ActiveSpeaker",
        "P1",
        "AVA terms / local acceptance required",
        "AVA-ActiveSpeaker dataset",
        ("video", "annotations"),
        _coverage(speaker_turns=True, video_frames=True),
        ("activeSpeaker",),
    ),
    "easycom": CorpusSpec(
        "easycom",
        "EasyCom",
        "P1",
        "EasyCom license / local acceptance required",
        "EasyCom egocentric communication corpus",
        ("audio", "video", "annotations"),
        _coverage(transcript=True, speaker_turns=True, channels=True, video_frames=True),
        ("WER", "DER", "activeSpeaker"),
    ),
}


def registry() -> dict[str, CorpusSpec]:
    return dict(_REGISTRY)


def build_cache_manifest(
    cache_root: Path | str,
    corpus_ids: Iterable[str] = P0_CORPUS_IDS,
) -> dict[str, Any]:
    root = Path(cache_root)
    entries = []
    for corpus_id in corpus_ids:
        spec = _REGISTRY[corpus_id]
        missing_paths = [
            relative for relative in spec.required_paths if not (root / corpus_id / relative).exists()
        ]
        status = "available" if not missing_paths else "missing"
        entries.append(
            {
                "corpusId": corpus_id,
                "name": spec.name,
                "priority": spec.priority,
                "status": status,
                "canRun": status == "available",
                "root": str(root / corpus_id),
                "requiredPaths": list(spec.required_paths),
                "missingPaths": missing_paths,
                "license": spec.license,
                "citation": spec.citation,
                "annotationCoverage": spec.annotation_coverage,
                "metricsSupported": list(spec.metrics_supported),
            }
        )
    return {
        "schemaVersion": MANIFEST_SCHEMA,
        "cacheRoot": str(root),
        "entries": entries,
    }


def load_fixture_references(path: Path | str) -> list[dict[str, Any]]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    fixtures = data.get("fixtures")
    if not isinstance(fixtures, list):
        raise ValueError("fixture file must contain a fixtures array")
    return [parse_fixture_reference(fixture) for fixture in fixtures]


def parse_fixture_reference(raw: dict[str, Any]) -> dict[str, Any]:
    corpus_id = _required_str(raw, "corpusId")
    if corpus_id not in _REGISTRY:
        raise ValueError(f"unknown corpusId: {corpus_id}")
    spec = _REGISTRY[corpus_id]
    recording_id = _required_str(raw, "recordingId")
    license_value = _required_str(raw, "license")
    citation = _required_str(raw, "citation")
    audio = _required_dict(raw, "audio")
    source_streams = _required_list(raw, "sourceStreams")
    transcript = _required_list(raw, "transcript")
    speaker_turns = _required_list(raw, "speakerTurns")
    _validate_turns(speaker_turns, "speakerTurns")
    _validate_turns(transcript, "transcript")
    reference = {
        "schemaVersion": REFERENCE_SCHEMA,
        "corpusId": corpus_id,
        "recordingId": recording_id,
        "license": license_value,
        "citation": citation,
        "declaredLicense": spec.license,
        "declaredCitation": spec.citation,
        "audio": {
            "uri": _required_str(audio, "uri"),
            "durationMs": _required_int(audio, "durationMs"),
            "sampleRateHz": _required_int(audio, "sampleRateHz"),
            "channels": _required_int(audio, "channels"),
        },
        "sourceStreams": source_streams,
        "transcript": transcript,
        "speakerTurns": speaker_turns,
        "rttm": reference_to_rttm(
            {"recordingId": recording_id, "speakerTurns": speaker_turns}
        ),
        "annotationCoverage": spec.annotation_coverage,
        "metricsSupported": list(spec.metrics_supported),
        "metadata": raw.get("metadata", {}),
    }
    return reference


def reference_to_rttm(reference: dict[str, Any]) -> str:
    recording_id = _required_str(reference, "recordingId")
    turns = _required_list(reference, "speakerTurns")
    lines: list[str] = []
    for turn in turns:
        if not isinstance(turn, dict):
            raise ValueError("speaker turn must be an object")
        speaker_id = _required_str(turn, "speakerId")
        start_ms = _required_int(turn, "startMs")
        end_ms = _required_int(turn, "endMs")
        if end_ms <= start_ms:
            raise ValueError("speaker turn endMs must be greater than startMs")
        start_s = start_ms / 1000
        duration_s = (end_ms - start_ms) / 1000
        lines.append(
            f"SPEAKER {recording_id} 1 {start_s:.3f} {duration_s:.3f} <NA> <NA> {speaker_id} <NA> <NA>"
        )
    return "\n".join(lines)


def _required_str(row: dict[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value


def _required_int(row: dict[str, Any], key: str) -> int:
    value = row.get(key)
    if not isinstance(value, int) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


def _required_dict(row: dict[str, Any], key: str) -> dict[str, Any]:
    value = row.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be an object")
    return value


def _required_list(row: dict[str, Any], key: str) -> list[Any]:
    value = row.get(key)
    if not isinstance(value, list) or not value:
        raise ValueError(f"{key} must be a non-empty array")
    return value


def _validate_turns(turns: list[Any], key: str) -> None:
    for index, turn in enumerate(turns):
        if not isinstance(turn, dict):
            raise ValueError(f"{key}[{index}] must be an object")
        _required_str(turn, "speakerId")
        start_ms = _required_int(turn, "startMs")
        end_ms = _required_int(turn, "endMs")
        if end_ms <= start_ms:
            raise ValueError(f"{key}[{index}].endMs must be greater than startMs")
