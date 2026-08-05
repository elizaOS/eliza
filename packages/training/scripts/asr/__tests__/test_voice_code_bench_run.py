"""Deterministic tests for the registered real-ASR VoiceCodeBench runner.

The suite uses in-memory WAV and provider responses to verify cache isolation,
dataset adaptation, byte hashes, partial-report behavior, and raw error capture
without contacting Hugging Face or an ASR provider.
"""

from __future__ import annotations

import io
import json
import sys
import wave
from pathlib import Path

import pytest

ASR_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ASR_DIR))

import voice_code_bench_run as runner  # noqa: E402


def _wav() -> bytes:
    destination = io.BytesIO()
    with wave.open(destination, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(b"\x00\x00" * 160)
    return destination.getvalue()


def _metadata() -> bytes:
    rows = []
    for index in range(1, 301):
        audio_id = f"code_{index:03d}"
        rows.append(
            {
                "file_name": f"audio/{index:03d}.wav",
                "audio_id": audio_id,
                "language": "en",
                "duration": 1.0,
                "domain": "coding",
                "scenario": "command",
                "difficulty": "light",
                "transcripts": {
                    "template": f"Run <{audio_id}_e01>",
                    "acoustic": "Run git status",
                    "canonical": "Run git status",
                },
                "entities": [
                    {
                        "id": f"{audio_id}_e01",
                        "type": "command",
                        "role": "command",
                        "acoustic": "git status",
                        "canonical": "git status",
                    }
                ],
            }
        )
    return "".join(json.dumps(row) + "\n" for row in rows).encode()


def test_registry_pins_public_dataset_and_runner() -> None:
    entry = runner.load_registry_entry()

    assert entry.id == "voice-code-bench"
    assert entry.dataset_revision == "af309592118b83fdf9b0ad896b564a142657aac8"
    assert entry.row_count == 300
    assert entry.providers == ("elevenlabs",)
    assert entry.runner.endswith("voice_code_bench_run.py")


def test_cache_and_output_must_stay_outside_repository() -> None:
    with pytest.raises(runner.VoiceCodeBenchError, match="outside the git repository"):
        runner.require_outside_repo(ASR_DIR / "cache", label="--cache-dir")

    with pytest.raises(runner.VoiceCodeBenchError, match="40-character Git commit SHA"):
        runner.validate_dataset_revision("main")


def test_metadata_rejects_audio_path_traversal() -> None:
    row = json.loads(_metadata().splitlines()[0])
    row["file_name"] = "audio/../secret.wav"
    payload = (json.dumps(row) + "\n").encode()

    with pytest.raises(runner.VoiceCodeBenchError, match="Invalid file_name"):
        runner.adapt_metadata(payload, expected_rows=1)


def test_adapt_metadata_requires_exact_registered_row_count() -> None:
    rows = runner.adapt_metadata(_metadata(), expected_rows=300)

    assert len(rows) == 300
    assert rows[0].score_row.audio_id == "code_001"
    assert rows[0].score_row.reference == "Run git status"
    assert rows[0].score_row.entities[0].canonical == "git status"
    assert len(rows[0].reference_sha256) == 64
    assert len(rows[0].entities_sha256) == 64


def test_run_row_records_real_byte_provenance_and_provider_result(
    tmp_path: Path,
) -> None:
    entry = runner.load_registry_entry()
    row = runner.adapt_metadata(_metadata(), expected_rows=300)[0]
    audio = _wav()

    def fake_fetch(_url: str, _timeout: float) -> tuple[bytes, dict[str, str]]:
        return audio, {"x-repo-commit": entry.dataset_revision}

    def fake_transcribe(
        value: bytes, model: str, filename: str, _timeout: float
    ) -> dict[str, object]:
        assert value == audio
        assert model == "scribe_v2"
        assert filename == "001.wav"
        return {"transcript": "Run git status", "request_id": "req-test"}

    record = runner.run_row(
        row=row,
        entry=entry,
        revision=entry.dataset_revision,
        cache_root=tmp_path,
        model="scribe_v2",
        timeout_seconds=1,
        max_attempts=1,
        fetcher=fake_fetch,
        transcriber=fake_transcribe,
    )

    assert record["status"] == "ok"
    assert record["sample_rate_hz"] == 16_000
    assert record["hashes"]["audio_sha256"] == runner.sha256_bytes(audio)
    assert record["provider_metadata"]["request_id"] == "req-test"


def test_dataset_download_retries_transient_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry = runner.load_registry_entry()
    attempts = 0
    monkeypatch.setattr(runner.time, "sleep", lambda _seconds: None)

    def flaky_fetch(_url: str, _timeout: float) -> tuple[bytes, dict[str, str]]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise runner.DatasetDownloadError("timeout", retryable=True)
        return b"dataset", {"x-repo-commit": entry.dataset_revision}

    destination = tmp_path / "metadata.jsonl"
    payload = runner.cached_download(
        url="https://example.invalid/metadata.jsonl",
        destination=destination,
        revision=entry.dataset_revision,
        timeout_seconds=1,
        fetcher=flaky_fetch,
        max_attempts=2,
    )

    assert attempts == 2
    assert payload == b"dataset"
    assert destination.read_bytes() == payload


def test_provider_error_retains_raw_response(tmp_path: Path) -> None:
    entry = runner.load_registry_entry()
    row = runner.adapt_metadata(_metadata(), expected_rows=300)[0]
    audio = _wav()

    def fake_fetch(_url: str, _timeout: float) -> tuple[bytes, dict[str, str]]:
        return audio, {"x-repo-commit": entry.dataset_revision}

    def fake_transcribe(
        _value: bytes, _model: str, _filename: str, _timeout: float
    ) -> dict[str, object]:
        raise runner.ProviderError(
            "quota exhausted",
            status=429,
            body='{"detail":"quota"}',
            request_id="req-429",
        )

    record = runner.run_row(
        row=row,
        entry=entry,
        revision=entry.dataset_revision,
        cache_root=tmp_path,
        model="scribe_v2",
        timeout_seconds=1,
        max_attempts=1,
        fetcher=fake_fetch,
        transcriber=fake_transcribe,
    )

    assert record["status"] == "provider_error"
    assert record["provider_error"] == {
        "message": "quota exhausted",
        "http_status": 429,
        "raw_body": '{"detail":"quota"}',
        "request_id": "req-429",
    }


def test_partial_report_is_scored_but_never_publishable(tmp_path: Path) -> None:
    entry = runner.load_registry_entry()
    row = runner.adapt_metadata(_metadata(), expected_rows=300)[0]
    record = {
        "audio_id": row.score_row.audio_id,
        "status": "ok",
        "transcript": "Run git status",
        "sample_rate_hz": 16_000,
        "duration_seconds": 1.0,
        "latency_ms": 10,
        "hashes": {
            "row_id": runner.sha256_bytes(row.score_row.audio_id.encode()),
            "audio_sha256": "a" * 64,
            "reference_sha256": row.reference_sha256,
            "entities_sha256": row.entities_sha256,
        },
    }

    report = runner.build_report(
        entry=entry,
        revision=entry.dataset_revision,
        model="scribe_v2",
        started_at="2026-08-05T00:00:00Z",
        rows=[row],
        records={row.score_row.audio_id: record},
        adapter_config={"provider": "elevenlabs"},
        log_sha256="b" * 64,
    )

    assert report["publishable"] is False
    assert report["row_count"] == 1
    assert report["metrics"] == {"ctem": 1.0, "tsr": 1.0, "wer": 0.0, "cer": 0.0}
    assert report["hashes"]["dataset_revision"] == entry.dataset_revision
    assert report["provider_metadata"]["artifact_revision"].endswith(
        "immutable-revision-unavailable-from-provider"
    )
