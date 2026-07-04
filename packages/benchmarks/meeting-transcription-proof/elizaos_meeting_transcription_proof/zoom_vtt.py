"""Zoom / zoomGroupStats WebVTT transcript importer.

Parses a Zoom cloud-recording ``transcript.vtt`` (the same format the MIT-licensed
zoomGroupStats R package ingests, https://zoomgroupstats.org) into the canonical
elizaOS meeting-artifact transcript shape: one speaker turn per cue, with
millisecond offsets and a diarized-speaker roster derived from the cue labels.

Zoom cues come in two flavours, both handled here:

  * inline label  — ``Speaker Name: spoken text`` in the cue body (classic export,
    what zoomGroupStats' ``processZoomTranscript`` reads);
  * WebVTT voice tag — ``<v Speaker Name>spoken text</v>`` (newer exports).

A cue with no resolvable label maps to the ``UNIDENTIFIED`` speaker, mirroring
zoomGroupStats' ``userName`` NA handling, so downstream diarization scoring can
still count the turn. This module is pure/deterministic and does no network I/O:
the raw corpus is downloaded at run time or read from a fixture and is never
committed (per the dataset adapter contract).

Output records are intentionally the transcript-span subset of
``eliza.meeting_artifact.v1`` (packages/shared/src/meeting-artifacts.ts) that a
``.vtt`` can support: ``startMs``/``endMs``/``text``/``speakerId``. Fields that a
raw transcript cannot supply (word-level timing, confidence, overlap, media
provenance) are left to the emitting product runtime, not fabricated here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

# ``HH:MM:SS.mmm`` (Zoom always emits the hours field and 3-digit millis).
_TIMESTAMP = re.compile(r"^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$")
_CUE_TIMING = re.compile(
    r"^\s*(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})"
)
_VOICE_TAG = re.compile(r"^<v\s+([^>]+)>(.*?)(?:</v>)?\s*$", re.DOTALL)
_INLINE_LABEL = re.compile(r"^([^:]{1,80}?):\s+(.*)$", re.DOTALL)

UNIDENTIFIED = "UNIDENTIFIED"


@dataclass(frozen=True)
class TranscriptSpan:
    """One speaker turn — the canonical meeting-artifact transcript-span subset."""

    start_ms: int
    end_ms: int
    text: str
    speaker_label: str

    def to_artifact_span(self, span_id: str, speaker_id: str) -> dict:
        """Render as an ``eliza.meeting_artifact.v1`` transcriptSpans[] entry."""
        return {
            "id": span_id,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "text": self.text,
            "speakerId": speaker_id,
        }


@dataclass
class ParsedTranscript:
    spans: list[TranscriptSpan] = field(default_factory=list)

    @property
    def speaker_labels(self) -> list[str]:
        """Distinct speaker labels in first-appearance order (diarization roster)."""
        seen: dict[str, None] = {}
        for span in self.spans:
            seen.setdefault(span.speaker_label, None)
        return list(seen)

    def to_meeting_artifact_segments(self) -> dict:
        """Canonical transcriptSpans[] + diarizedSpeakers[] for a MeetingArtifact.

        Speaker ids are stable (``speaker-<slug>``) so repeated runs over the same
        transcript produce identical foreign keys — required for deterministic
        diarization scoring.
        """
        speaker_ids = {
            label: f"speaker-{_slug(label)}" for label in self.speaker_labels
        }
        diarized = [
            {
                "id": speaker_ids[label],
                "sourceStreamIds": [],
                "name": {
                    "displayName": None if label == UNIDENTIFIED else label,
                    "provenance": "unknown" if label == UNIDENTIFIED else "platform",
                    "confidence": 0.0 if label == UNIDENTIFIED else 1.0,
                },
                "status": "unresolved" if label == UNIDENTIFIED else "resolved",
            }
            for label in self.speaker_labels
        ]
        spans = [
            span.to_artifact_span(f"span-{index}", speaker_ids[span.speaker_label])
            for index, span in enumerate(self.spans)
        ]
        return {"transcriptSpans": spans, "diarizedSpeakers": diarized}


def _slug(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    return slug or "unidentified"


def _timestamp_to_ms(value: str) -> int:
    match = _TIMESTAMP.match(value)
    if not match:
        raise ValueError(f"invalid WebVTT timestamp: {value!r}")
    hours, minutes, seconds, millis = (int(part) for part in match.groups())
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def _split_label(body: str) -> tuple[str, str]:
    """Return ``(speaker_label, text)`` for a cue body, falling back to UNIDENTIFIED."""
    voice = _VOICE_TAG.match(body)
    if voice:
        label = voice.group(1).strip()
        return (label or UNIDENTIFIED, voice.group(2).strip())
    inline = _INLINE_LABEL.match(body)
    if inline:
        label = inline.group(1).strip()
        # Reject a timestamp-looking prefix (rare malformed cue) as a non-label.
        if label and not _TIMESTAMP.match(label):
            return (label, inline.group(2).strip())
    return (UNIDENTIFIED, body.strip())


def parse_zoom_vtt(text: str) -> ParsedTranscript:
    """Parse a Zoom ``transcript.vtt`` string into ordered speaker-turn spans.

    Tolerant of the ``WEBVTT`` header, blank separators, optional numeric cue ids,
    and multi-line cue bodies. End timestamps are clamped to be >= start so a
    malformed cue never yields a negative-duration span.
    """
    transcript = ParsedTranscript()
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    index = 0
    total = len(lines)
    while index < total:
        line = lines[index].strip()
        index += 1
        timing = _CUE_TIMING.match(line)
        if not timing:
            continue
        start_ms = _timestamp_to_ms(timing.group(1))
        end_ms = max(_timestamp_to_ms(timing.group(2)), start_ms)
        body_lines: list[str] = []
        while index < total and lines[index].strip() != "":
            body_lines.append(lines[index].strip())
            index += 1
        if not body_lines:
            continue
        speaker_label, spoken = _split_label("\n".join(body_lines))
        if not spoken:
            continue
        transcript.spans.append(
            TranscriptSpan(
                start_ms=start_ms,
                end_ms=end_ms,
                text=spoken,
                speaker_label=speaker_label,
            )
        )
    return transcript


def iter_speaker_turns(text: str) -> Iterable[TranscriptSpan]:
    """Convenience generator over parsed speaker turns."""
    yield from parse_zoom_vtt(text).spans
