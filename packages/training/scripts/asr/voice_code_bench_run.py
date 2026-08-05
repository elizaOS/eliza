#!/usr/bin/env python3
"""Run pinned VoiceCodeBench audio through a real ASR provider.

The runner downloads the public test split into a revision-keyed cache outside
the repository, records byte-level provenance, invokes bounded real provider
requests, and emits resumable logs plus a gate-compatible score report. It
never treats provider failures or partial runs as publishable evidence.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

ASR_DIR = Path(__file__).resolve().parent
REPO_ROOT = ASR_DIR.parents[3]
REGISTRY_PATH = ASR_DIR / "voice_code_bench_registry.json"
sys.path.insert(0, str(ASR_DIR))

import voice_code_bench_gate as gate  # noqa: E402


class VoiceCodeBenchError(RuntimeError):
    """A benchmark boundary failed without producing valid evidence."""


class ProviderError(VoiceCodeBenchError):
    """A real ASR request failed and retains its raw provider response."""

    def __init__(
        self, message: str, *, status: int | None, body: str, request_id: str | None
    ):
        super().__init__(message)
        self.status = status
        self.body = body
        self.request_id = request_id


class DatasetDownloadError(VoiceCodeBenchError):
    """A dataset request failed and records whether retry is safe."""

    def __init__(self, message: str, *, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class RegistryEntry:
    id: str
    source_url: str
    dataset_revision: str
    license: str
    split: str
    row_count: int
    runner: str
    providers: tuple[str, ...]
    output_schema: str


@dataclass(frozen=True)
class AdaptedRow:
    score_row: gate.VoiceCodeBenchRow
    file_name: str
    language: str
    duration_seconds: float
    reference_sha256: str
    entities_sha256: str


FetchBytes = Callable[[str, float], tuple[bytes, dict[str, str]]]
Transcriber = Callable[[bytes, str, str, float], dict[str, Any]]


def utc_now() -> str:
    return (
        dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def aggregate_hash(items: Iterable[tuple[str, str]]) -> str:
    payload = "".join(f"{key}:{value}\n" for key, value in items).encode("utf-8")
    return f"sha256:{sha256_bytes(payload)}"


def validate_dataset_revision(revision: str) -> str:
    if len(revision) != 40 or any(
        character not in "0123456789abcdef" for character in revision
    ):
        raise VoiceCodeBenchError(
            "--dataset-revision must be a lowercase 40-character Git commit SHA"
        )
    return revision


def load_registry_entry(path: Path = REGISTRY_PATH) -> RegistryEntry:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != "elizaos.asr_benchmark_registry.v1":
        raise VoiceCodeBenchError(f"Unsupported benchmark registry schema in {path}")
    entries = data.get("benchmarks")
    if not isinstance(entries, list):
        raise VoiceCodeBenchError(f"Benchmark registry has no benchmarks list: {path}")
    raw = next((item for item in entries if item.get("id") == "voice-code-bench"), None)
    if not isinstance(raw, dict):
        raise VoiceCodeBenchError("voice-code-bench is not registered")
    entry = RegistryEntry(
        id=str(raw["id"]),
        source_url=str(raw["source_url"]),
        dataset_revision=str(raw["dataset_revision"]),
        license=str(raw["license"]),
        split=str(raw["split"]),
        row_count=int(raw["row_count"]),
        runner=str(raw["runner"]),
        providers=tuple(str(item) for item in raw["providers"]),
        output_schema=str(raw["output_schema"]),
    )
    if (
        entry.source_url != gate.DATASET_SOURCE_URL
        or entry.row_count != gate.DATASET_ROWS
    ):
        raise VoiceCodeBenchError(
            "Registry entry disagrees with the VoiceCodeBench gate contract"
        )
    validate_dataset_revision(entry.dataset_revision)
    return entry


def require_outside_repo(path: Path, *, label: str) -> Path:
    resolved = path.expanduser().resolve()
    if resolved == REPO_ROOT or resolved.is_relative_to(REPO_ROOT):
        raise VoiceCodeBenchError(
            f"{label} must be outside the git repository: {resolved}"
        )
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def fetch_bytes(url: str, timeout_seconds: float) -> tuple[bytes, dict[str, str]]:
    request = urllib.request.Request(
        url, headers={"User-Agent": "elizaOS-VoiceCodeBench/1"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return response.read(), {
                key.lower(): value for key, value in response.headers.items()
            }
    except urllib.error.HTTPError as error:
        # error-policy:J2 transport context is preserved for the benchmark boundary.
        body = error.read(65_536).decode("utf-8", errors="replace")
        raise DatasetDownloadError(
            f"Dataset download HTTP {error.code} for {url}: {body}",
            retryable=error.code == 429 or error.code >= 500,
        ) from error
    except urllib.error.URLError as error:
        # error-policy:J2 transport context is preserved for the benchmark boundary.
        raise DatasetDownloadError(
            f"Dataset download failed for {url}: {error.reason}", retryable=True
        ) from error


def cached_download(
    *,
    url: str,
    destination: Path,
    revision: str,
    timeout_seconds: float,
    fetcher: FetchBytes = fetch_bytes,
    max_attempts: int = 3,
) -> bytes:
    if destination.is_file():
        return destination.read_bytes()
    for attempt in range(1, max_attempts + 1):
        try:
            payload, headers = fetcher(url, timeout_seconds)
            break
        except DatasetDownloadError as error:
            # error-policy:J1 retry only transient dataset-boundary failures.
            if not error.retryable or attempt == max_attempts:
                raise
            time.sleep(min(2 ** (attempt - 1), 8))
    else:
        raise VoiceCodeBenchError("Dataset retry loop ended unexpectedly")
    response_revision = headers.get("x-repo-commit")
    if response_revision is not None and response_revision != revision:
        raise VoiceCodeBenchError(
            f"Dataset response resolved to {response_revision}, expected {revision}"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    temporary.write_bytes(payload)
    temporary.replace(destination)
    return payload


def dataset_file_url(entry: RegistryEntry, revision: str, relative_path: str) -> str:
    encoded_path = urllib.parse.quote(relative_path, safe="/")
    return f"{entry.source_url}/resolve/{revision}/{encoded_path}"


def adapt_metadata(metadata_bytes: bytes, *, expected_rows: int) -> list[AdaptedRow]:
    rows: list[AdaptedRow] = []
    seen: set[str] = set()
    for line_number, raw_line in enumerate(
        metadata_bytes.decode("utf-8").splitlines(), start=1
    ):
        if not raw_line.strip():
            continue
        raw = json.loads(raw_line)
        audio_id = raw.get("audio_id")
        if not isinstance(audio_id, str) or not audio_id or audio_id in seen:
            raise VoiceCodeBenchError(
                f"Invalid or duplicate audio_id at metadata line {line_number}"
            )
        file_name = raw.get("file_name")
        transcripts = raw.get("transcripts")
        entities = raw.get("entities")
        file_path = Path(file_name) if isinstance(file_name, str) else None
        if (
            file_path is None
            or file_path.is_absolute()
            or len(file_path.parts) != 2
            or file_path.parts[0] != "audio"
            or file_path.parts[1] in {"", ".", ".."}
        ):
            raise VoiceCodeBenchError(f"Invalid file_name for {audio_id}")
        if not isinstance(transcripts, dict) or any(
            not isinstance(transcripts.get(layer), str)
            for layer in ("template", "acoustic", "canonical")
        ):
            raise VoiceCodeBenchError(f"Missing transcript layer for {audio_id}")
        if not isinstance(entities, list) or not entities:
            raise VoiceCodeBenchError(f"Missing entities for {audio_id}")
        adapted_entities: list[gate.VoiceCodeBenchEntity] = []
        for entity in entities:
            entity_type = entity.get("type")
            if entity_type not in gate.ENTITY_TYPES:
                raise VoiceCodeBenchError(
                    f"Invalid entity type for {audio_id}: {entity_type!r}"
                )
            adapted_entities.append(
                gate.VoiceCodeBenchEntity(
                    id=str(entity["id"]),
                    type=str(entity_type),
                    canonical=str(entity["canonical"]),
                    acoustic=str(entity["acoustic"]),
                )
            )
        reference = transcripts["canonical"]
        rows.append(
            AdaptedRow(
                score_row=gate.VoiceCodeBenchRow(
                    audio_id=audio_id,
                    domain=str(raw["domain"]),
                    scenario=str(raw["scenario"]),
                    difficulty=str(raw["difficulty"]),
                    reference=reference,
                    entities=tuple(adapted_entities),
                    acoustic_reference=transcripts["acoustic"],
                ),
                file_name=file_name,
                language=str(raw.get("language") or "en"),
                duration_seconds=float(raw["duration"]),
                reference_sha256=sha256_bytes(canonical_json_bytes(transcripts)),
                entities_sha256=sha256_bytes(canonical_json_bytes(entities)),
            )
        )
        seen.add(audio_id)
    if len(rows) != expected_rows:
        raise VoiceCodeBenchError(
            f"Metadata has {len(rows)} rows, expected {expected_rows}"
        )
    return rows


def wav_sample_rate(audio: bytes) -> int:
    import io

    try:
        with wave.open(io.BytesIO(audio), "rb") as source:
            sample_rate = source.getframerate()
            if source.getnchannels() <= 0 or sample_rate <= 0:
                raise VoiceCodeBenchError(
                    "WAV has invalid channel or sample-rate metadata"
                )
            return sample_rate
    except (EOFError, wave.Error) as error:
        # error-policy:J2 malformed benchmark audio cannot become valid evidence.
        raise VoiceCodeBenchError(
            f"Benchmark audio is not a valid WAV: {error}"
        ) from error


def multipart_body(audio: bytes, *, model: str, filename: str) -> tuple[bytes, str]:
    boundary = f"eliza-vcb-{sha256_bytes(audio)[:24]}"
    chunks = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\n{model}\r\n'.encode(),
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
            f'filename="{filename}"\r\nContent-Type: audio/wav\r\n\r\n'
        ).encode(),
        audio,
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    return b"".join(chunks), boundary


def elevenlabs_transcribe(
    audio: bytes,
    model: str,
    filename: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    key = (
        os.environ.get("ELEVENLABS_API_KEY")
        or os.environ.get("ELEVENLABS_XI_API_KEY")
        or ""
    ).strip()
    if not key:
        raise VoiceCodeBenchError(
            "ELEVENLABS_API_KEY or ELEVENLABS_XI_API_KEY is required"
        )
    body, boundary = multipart_body(audio, model=model, filename=filename)
    request = urllib.request.Request(
        "https://api.elevenlabs.io/v1/speech-to-text",
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
            "User-Agent": "elizaOS-VoiceCodeBench/1",
            "xi-api-key": key,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
            transcript = payload.get("text")
            if not isinstance(transcript, str):
                raise ProviderError(
                    "ElevenLabs response omitted text",
                    status=response.status,
                    body=json.dumps(payload, ensure_ascii=False)[:65_536],
                    request_id=response.headers.get("request-id")
                    or response.headers.get("x-request-id"),
                )
            return {
                "transcript": transcript,
                "language_code": payload.get("language_code"),
                "language_probability": payload.get("language_probability"),
                "request_id": response.headers.get("request-id")
                or response.headers.get("x-request-id"),
            }
    except urllib.error.HTTPError as error:
        # error-policy:J2 retain the provider body and request identity for evidence.
        body_text = error.read(65_536).decode("utf-8", errors="replace")
        raise ProviderError(
            f"ElevenLabs STT HTTP {error.code}",
            status=error.code,
            body=body_text,
            request_id=error.headers.get("request-id")
            or error.headers.get("x-request-id"),
        ) from error
    except urllib.error.URLError as error:
        # error-policy:J2 retain the transport cause for evidence and bounded retry.
        raise ProviderError(
            f"ElevenLabs STT transport failure: {error.reason}",
            status=None,
            body=str(error.reason),
            request_id=None,
        ) from error


def transcribe_with_retries(
    *,
    audio: bytes,
    model: str,
    filename: str,
    timeout_seconds: float,
    max_attempts: int,
    transcriber: Transcriber,
) -> dict[str, Any]:
    last_error: ProviderError | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            result = transcriber(audio, model, filename, timeout_seconds)
            return {**result, "attempts": attempt}
        except ProviderError as error:
            # error-policy:J1 retry only transient provider-boundary failures.
            last_error = error
            retryable = (
                error.status is None or error.status == 429 or error.status >= 500
            )
            if not retryable or attempt == max_attempts:
                raise
            time.sleep(min(2 ** (attempt - 1), 8))
    raise VoiceCodeBenchError(f"Retry loop ended unexpectedly: {last_error}")


def run_row(
    *,
    row: AdaptedRow,
    entry: RegistryEntry,
    revision: str,
    cache_root: Path,
    model: str,
    timeout_seconds: float,
    max_attempts: int,
    fetcher: FetchBytes,
    transcriber: Transcriber,
) -> dict[str, Any]:
    started = time.monotonic()
    audio_path = cache_root / revision / "data" / row.file_name
    audio = cached_download(
        url=dataset_file_url(entry, revision, f"data/{row.file_name}"),
        destination=audio_path,
        revision=revision,
        timeout_seconds=timeout_seconds,
        fetcher=fetcher,
        max_attempts=max_attempts,
    )
    audio_hash = sha256_bytes(audio)
    sample_rate = wav_sample_rate(audio)
    try:
        provider = transcribe_with_retries(
            audio=audio,
            model=model,
            filename=Path(row.file_name).name,
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
            transcriber=transcriber,
        )
        return {
            "audio_id": row.score_row.audio_id,
            "status": "ok",
            "transcript": provider["transcript"],
            "provider_metadata": {
                key: value for key, value in provider.items() if key != "transcript"
            },
            "sample_rate_hz": sample_rate,
            "duration_seconds": row.duration_seconds,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "hashes": {
                "row_id": sha256_bytes(row.score_row.audio_id.encode("utf-8")),
                "audio_sha256": audio_hash,
                "reference_sha256": row.reference_sha256,
                "entities_sha256": row.entities_sha256,
            },
        }
    except ProviderError as error:
        # error-policy:J1 translate the final provider failure into a failed row.
        return {
            "audio_id": row.score_row.audio_id,
            "status": "provider_error",
            "transcript": "",
            "provider_error": {
                "message": str(error),
                "http_status": error.status,
                "raw_body": error.body,
                "request_id": error.request_id,
            },
            "sample_rate_hz": sample_rate,
            "duration_seconds": row.duration_seconds,
            "latency_ms": round((time.monotonic() - started) * 1000),
            "hashes": {
                "row_id": sha256_bytes(row.score_row.audio_id.encode("utf-8")),
                "audio_sha256": audio_hash,
                "reference_sha256": row.reference_sha256,
                "entities_sha256": row.entities_sha256,
            },
        }


def load_checkpoint(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    records: dict[str, dict[str, Any]] = {}
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not raw_line.strip():
            continue
        record = json.loads(raw_line)
        audio_id = record.get("audio_id")
        if not isinstance(audio_id, str):
            raise VoiceCodeBenchError(f"Checkpoint line {line_number} has no audio_id")
        records[audio_id] = record
    return records


def append_json_line(path: Path, record: dict[str, Any], lock: threading.Lock) -> None:
    line = json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
    with lock:
        with path.open("a", encoding="utf-8") as destination:
            destination.write(line)
            destination.flush()


def build_report(
    *,
    entry: RegistryEntry,
    revision: str,
    model: str,
    started_at: str,
    rows: list[AdaptedRow],
    records: dict[str, dict[str, Any]],
    adapter_config: dict[str, Any],
    log_sha256: str,
) -> dict[str, Any]:
    ordered_records = []
    for row in rows:
        record = records[row.score_row.audio_id]
        ordered_records.append(
            {
                **record,
                "hashes": {
                    **record["hashes"],
                    "row_id": sha256_bytes(row.score_row.audio_id.encode("utf-8")),
                    "reference_sha256": row.reference_sha256,
                    "entities_sha256": row.entities_sha256,
                },
            }
        )
    hypotheses = {
        record["audio_id"]: record.get("transcript", "") for record in ordered_records
    }
    scores = gate.score_voice_code_bench_rows(
        (row.score_row for row in rows), hypotheses
    )
    error_count = sum(record.get("status") != "ok" for record in ordered_records)
    sample_rates = {record["sample_rate_hz"] for record in ordered_records}
    sample_rate = next(iter(sample_rates)) if len(sample_rates) == 1 else 0
    full_run = len(rows) == entry.row_count
    report = {
        "schema": entry.output_schema,
        "publishable": full_run and error_count == 0 and sample_rate > 0,
        "source_url": entry.source_url,
        "license": entry.license,
        "split": entry.split,
        "row_count": len(rows),
        "provider_error_count": error_count,
        "provider_metadata": {
            "asr_provider": "elevenlabs",
            "asr_model": model,
            "artifact_revision": (
                f"hosted:{model}:immutable-revision-unavailable-from-provider"
            ),
            "sample_rate_hz": sample_rate,
            "run_started_at": started_at,
        },
        "hashes": {
            "dataset_revision": revision,
            "row_id": aggregate_hash(
                (record["audio_id"], record["hashes"]["row_id"])
                for record in ordered_records
            ),
            "audio_sha256": aggregate_hash(
                (record["audio_id"], record["hashes"]["audio_sha256"])
                for record in ordered_records
            ),
            "reference_sha256": aggregate_hash(
                (record["audio_id"], record["hashes"]["reference_sha256"])
                for record in ordered_records
            ),
            "entities_sha256": aggregate_hash(
                (record["audio_id"], record["hashes"]["entities_sha256"])
                for record in ordered_records
            ),
            "adapter_config_sha256": f"sha256:{sha256_bytes(canonical_json_bytes(adapter_config))}",
            "backend_log_sha256": f"sha256:{log_sha256}",
        },
        "metrics": scores["metrics"],
        "rows": [
            {
                **score,
                "transcript": record.get("transcript", ""),
                "status": record["status"],
                "provider_error": record.get("provider_error"),
                "sample_rate_hz": record["sample_rate_hz"],
                "duration_seconds": record["duration_seconds"],
                "latency_ms": record["latency_ms"],
                "hashes": record["hashes"],
            }
            for score, record in zip(scores["rows"], ordered_records, strict=True)
        ],
    }
    report["validation_errors"] = (
        gate.validate_publishable_report(report) if full_run else []
    )
    if report["publishable"] and report["validation_errors"]:
        report["publishable"] = False
    return report


def write_failure_review(path: Path, report: dict[str, Any]) -> None:
    failures = sorted(
        (row for row in report["rows"] if row["tsr"] < 1.0),
        key=lambda row: (row["ctem"], -row["wer"], row["audio_id"]),
    )
    lines = [
        "# VoiceCodeBench failure review",
        "",
        f"Generated: {utc_now()}",
        f"Rows missing at least one exact entity: {len(failures)}/{report['row_count']}",
        "",
    ]
    for row in failures[:30]:
        missed = [
            f"{entity['type']}={entity['canonical']}"
            for entity in row["entities"]
            if not entity["matched"]
        ]
        lines.extend(
            [
                f"## {row['audio_id']} ({row['difficulty']})",
                "",
                f"- CTEM: {row['ctem']:.3f}; WER: {row['wer']:.3f}; CER: {row['cer']:.3f}",
                f"- Missed exact entities: {', '.join(missed) if missed else 'none'}",
                f"- Provider status: {row['status']}",
                f"- Transcript: {row['transcript']}",
                "",
            ]
        )
    path.write_text("\n".join(lines), encoding="utf-8")


def run(args: argparse.Namespace) -> Path:
    entry = load_registry_entry()
    if args.provider not in entry.providers:
        raise VoiceCodeBenchError(
            f"Provider {args.provider!r} is not registered for {entry.id}"
        )
    revision = validate_dataset_revision(
        args.dataset_revision or entry.dataset_revision
    )
    cache_root = require_outside_repo(args.cache_dir, label="--cache-dir")
    metadata_path = cache_root / revision / "data" / "metadata.jsonl"
    metadata_bytes = cached_download(
        url=dataset_file_url(entry, revision, "data/metadata.jsonl"),
        destination=metadata_path,
        revision=revision,
        timeout_seconds=args.timeout_seconds,
    )
    all_rows = adapt_metadata(metadata_bytes, expected_rows=entry.row_count)
    rows = all_rows[: args.limit] if args.limit is not None else all_rows
    requested_adapter_config = {
        "provider": args.provider,
        "model": args.model,
        "endpoint": "https://api.elevenlabs.io/v1/speech-to-text",
        "timeout_seconds": args.timeout_seconds,
        "max_attempts": args.max_attempts,
        "dataset_revision": revision,
        "row_limit": args.limit,
    }
    if args.run_dir is not None:
        run_dir = require_outside_repo(args.run_dir, label="--run-dir")
        config_path = run_dir / "adapter-config.json"
        if config_path.is_file():
            adapter_config = json.loads(config_path.read_text(encoding="utf-8"))
            comparable = {
                key: adapter_config.get(key) for key in requested_adapter_config
            }
            if comparable != requested_adapter_config:
                raise VoiceCodeBenchError(
                    f"Existing run configuration does not match requested configuration: {config_path}"
                )
            started_at = str(adapter_config["run_started_at"])
        elif any(run_dir.iterdir()):
            raise VoiceCodeBenchError(
                f"Existing --run-dir has no adapter-config.json: {run_dir}"
            )
        else:
            started_at = utc_now()
            adapter_config = {**requested_adapter_config, "run_started_at": started_at}
            config_path.write_text(
                json.dumps(adapter_config, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
    else:
        output_dir = require_outside_repo(args.output_dir, label="--output-dir")
        started_at = utc_now()
        run_dir = (
            output_dir
            / f"voice-code-bench-{started_at.replace(':', '').replace('-', '')}"
        )
        run_dir.mkdir(parents=True, exist_ok=False)
        adapter_config = {**requested_adapter_config, "run_started_at": started_at}
        (run_dir / "adapter-config.json").write_text(
            json.dumps(adapter_config, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    checkpoint_path = run_dir / "backend.jsonl"
    records = load_checkpoint(checkpoint_path)
    pending = [
        row
        for row in rows
        if records.get(row.score_row.audio_id, {}).get("status") != "ok"
    ]
    lock = threading.Lock()
    print(
        f"voice_code_bench_start rows={len(rows)} provider={args.provider} model={args.model} "
        f"revision={revision} concurrency={args.concurrency}",
        flush=True,
    )
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=args.concurrency
    ) as executor:
        futures = {
            executor.submit(
                run_row,
                row=row,
                entry=entry,
                revision=revision,
                cache_root=cache_root,
                model=args.model,
                timeout_seconds=args.timeout_seconds,
                max_attempts=args.max_attempts,
                fetcher=fetch_bytes,
                transcriber=elevenlabs_transcribe,
            ): row
            for row in pending
        }
        for future in concurrent.futures.as_completed(futures):
            row = futures[future]
            try:
                record = future.result()
            except Exception as error:
                # error-policy:J1 the CLI boundary records a hard row failure and exits nonzero.
                record = {
                    "audio_id": row.score_row.audio_id,
                    "status": "runner_error",
                    "transcript": "",
                    "runner_error": {
                        "type": type(error).__name__,
                        "message": str(error),
                    },
                }
            records[row.score_row.audio_id] = record
            append_json_line(checkpoint_path, record, lock)
            completed = len(
                [item for item in rows if item.score_row.audio_id in records]
            )
            print(
                f"voice_code_bench_row completed={completed}/{len(rows)} "
                f"audio_id={row.score_row.audio_id} status={record['status']}",
                flush=True,
            )
    incomplete = [
        row.score_row.audio_id for row in rows if row.score_row.audio_id not in records
    ]
    malformed = [
        row.score_row.audio_id
        for row in rows
        if "hashes" not in records[row.score_row.audio_id]
        or "sample_rate_hz" not in records[row.score_row.audio_id]
    ]
    if incomplete or malformed:
        raise VoiceCodeBenchError(
            f"Run cannot be scored; incomplete={incomplete[:5]} malformed={malformed[:5]}"
        )
    log_hash = sha256_bytes(checkpoint_path.read_bytes())
    report = build_report(
        entry=entry,
        revision=revision,
        model=args.model,
        started_at=started_at,
        rows=rows,
        records=records,
        adapter_config=adapter_config,
        log_sha256=log_hash,
    )
    report_path = run_dir / "report.json"
    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    write_failure_review(run_dir / "failure-review.md", report)
    print(
        f"voice_code_bench_finish report={report_path} publishable={str(report['publishable']).lower()} "
        f"errors={report['provider_error_count']} metrics={json.dumps(report['metrics'], sort_keys=True)}",
        flush=True,
    )
    if any(
        record["status"] != "ok"
        for record in records.values()
        if record["audio_id"] in {row.score_row.audio_id for row in rows}
    ):
        raise VoiceCodeBenchError(
            f"Real provider failures are recorded in {checkpoint_path}"
        )
    return report_path


def parser() -> argparse.ArgumentParser:
    entry = load_registry_entry()
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("--cache-dir", type=Path, required=True)
    output = command.add_mutually_exclusive_group(required=True)
    output.add_argument("--output-dir", type=Path)
    output.add_argument(
        "--run-dir",
        type=Path,
        help="Create or resume one exact run directory; failed provider rows are retried.",
    )
    command.add_argument("--dataset-revision", default=entry.dataset_revision)
    command.add_argument("--provider", choices=entry.providers, default="elevenlabs")
    command.add_argument("--model", default="scribe_v2")
    command.add_argument("--limit", type=int)
    command.add_argument("--concurrency", type=int, default=2)
    command.add_argument("--timeout-seconds", type=float, default=300.0)
    command.add_argument("--max-attempts", type=int, default=3)
    return command


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.limit is not None and args.limit <= 0:
        raise VoiceCodeBenchError("--limit must be positive")
    if args.concurrency <= 0 or args.max_attempts <= 0 or args.timeout_seconds <= 0:
        raise VoiceCodeBenchError("concurrency, attempts, and timeout must be positive")
    try:
        run(args)
    except VoiceCodeBenchError as error:
        # error-policy:J1 the CLI returns a nonzero process result with typed context.
        print(
            f"voice_code_bench_error type={type(error).__name__} message={error}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
