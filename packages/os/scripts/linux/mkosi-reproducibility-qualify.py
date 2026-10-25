#!/usr/bin/env python3
"""Compare two isolated release builds at the canonical root-partition boundary."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


SCHEMA = "ai.elizaos.mkosi-reproducibility-evidence.v1"
BUILD_SCHEMA = "ai.elizaos.mkosi-build-evidence.v1"
BUILD_CLAIM = "mkosi_disk_assembly_only_no_boot_or_hardware_claim"
CLAIM = "two_build_root_partition_reproducibility_only_no_boot_installer_or_hardware_claim"
SHA256_RE = re.compile(r"[0-9a-f]{64}")
SNAPSHOT_RE = re.compile(
    r"https://snapshot\.debian\.org/archive/debian/\d{8}T\d{6}Z/?"
)
ROOT_PARTITION_TYPES = {
    "amd64": "4f68bce3-e8cd-4db1-96e7-fbcaf984b709",
    "arm64": "b921b045-1df0-41c3-af44-4c6f280d3fae",
    "riscv64": "72ec70a6-cf74-40e6-bd49-4bda08e8f224",
}


class QualificationError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_evidence(path: Path, document: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(json.dumps(document, indent=2, sort_keys=True) + "\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.link(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def regular_file(path: Path, label: str) -> dict[str, object]:
    if not path.is_file() or path.is_symlink():
        raise QualificationError(f"{label} must be a regular non-symlink file: {path}")
    size = path.stat().st_size
    if size <= 0:
        raise QualificationError(f"{label} must be nonempty: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(path.resolve()), "size": size, "sha256": digest.hexdigest()}


def json_file(path: Path, label: str) -> tuple[dict[str, object], dict[str, object]]:
    record = regular_file(path, label)
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise QualificationError(f"{label} is not valid UTF-8 JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise QualificationError(f"{label} must contain a JSON object")
    return record, document


def canonical_desktop_inputs(value: object) -> list[tuple[str, int, str]]:
    if not isinstance(value, list) or len(value) != 5:
        raise QualificationError("release build evidence must bind exactly five desktop inputs")
    inputs: list[tuple[str, int, str]] = []
    for item in value:
        if not isinstance(item, dict):
            raise QualificationError("desktop input evidence entry is invalid")
        path = item.get("path")
        size = item.get("size")
        sha256 = item.get("sha256")
        if (
            not isinstance(path, str)
            or not path
            or Path(path).name != path
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size <= 0
            or not isinstance(sha256, str)
            or not SHA256_RE.fullmatch(sha256)
        ):
            raise QualificationError("desktop input evidence entry is invalid")
        inputs.append((path, size, sha256))
    if len({item[0] for item in inputs}) != len(inputs):
        raise QualificationError("desktop input evidence contains duplicate filenames")
    return sorted(inputs)


def validate_build(
    document: dict[str, object], compressed: dict[str, object], label: str
) -> dict[str, object]:
    if document.get("schema") != BUILD_SCHEMA or document.get("claimBoundary") != BUILD_CLAIM:
        raise QualificationError(f"{label} schema or claim boundary is invalid")
    if (
        document.get("success") is not True
        or document.get("preflightOnly") is not False
        or document.get("buildMode") != "release"
        or document.get("sourceDirty") is not False
        or document.get("returnCode") != 0
        or document.get("errors") != []
    ):
        raise QualificationError(f"{label} is not a successful clean release build")
    required_strings = (
        "architecture",
        "profile",
        "sourceCommit",
        "configurationSha256",
        "sourceDateEpoch",
        "debianSnapshotUrl",
        "mkosiVersion",
    )
    identity: dict[str, object] = {}
    for field in required_strings:
        value = document.get(field)
        if not isinstance(value, str) or not value:
            raise QualificationError(f"{label} lacks reproducibility input {field}")
        identity[field] = value
    if not re.fullmatch(r"[0-9a-f]{40}", str(identity["sourceCommit"])):
        raise QualificationError(f"{label} source commit is invalid")
    if not SHA256_RE.fullmatch(str(identity["configurationSha256"])):
        raise QualificationError(f"{label} configuration digest is invalid")
    if not str(identity["sourceDateEpoch"]).isdigit():
        raise QualificationError(f"{label} SOURCE_DATE_EPOCH is invalid")
    if identity["architecture"] not in {"amd64", "arm64", "riscv64"}:
        raise QualificationError(f"{label} architecture is invalid")
    if identity["profile"] not in {"default", "gui", "secure", "secure-gui"}:
        raise QualificationError(f"{label} profile is invalid")
    if not SNAPSHOT_RE.fullmatch(str(identity["debianSnapshotUrl"])):
        raise QualificationError(f"{label} Debian snapshot URL is invalid")
    identity["desktopArtifactInputs"] = canonical_desktop_inputs(
        document.get("desktopArtifactInputs")
    )
    artifacts = document.get("artifacts")
    if not isinstance(artifacts, list):
        raise QualificationError(f"{label} artifact evidence is invalid")
    matches = [
        artifact
        for artifact in artifacts
        if isinstance(artifact, dict)
        and str(artifact.get("path", "")).endswith(".raw.zst")
        and artifact.get("size") == compressed["size"]
        and artifact.get("sha256") == compressed["sha256"]
    ]
    if len(matches) != 1:
        raise QualificationError(f"{label} does not bind the exact compressed image")
    return identity


def verify_expansion(compressed_path: Path, expanded: dict[str, object], zstd: str) -> None:
    with tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen(
            [zstd, "--decompress", "--stdout", "--", str(compressed_path)],
            stdout=subprocess.PIPE,
            stderr=stderr,
        )
        assert process.stdout is not None
        digest = hashlib.sha256()
        size = 0
        for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
        process.stdout.close()
        return_code = process.wait()
        stderr.seek(0)
        detail = stderr.read(64 * 1024).decode("utf-8", errors="replace").strip()
    if return_code != 0:
        raise QualificationError(f"zstd expansion failed: {detail}")
    if size != expanded["size"] or digest.hexdigest() != expanded["sha256"]:
        raise QualificationError("expanded image does not match its compressed build artifact")


def root_partition(path: Path, sfdisk: str, architecture: str) -> dict[str, int | str]:
    result = subprocess.run(
        [sfdisk, "--json", str(path)],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise QualificationError(f"cannot inspect GPT for {path}: {result.stderr.strip()}")
    try:
        table = json.loads(result.stdout)["partitiontable"]
        sector_size = table["sectorsize"]
        expected_type = ROOT_PARTITION_TYPES[architecture]
        matches = [
            item
            for item in table["partitions"]
            if str(item.get("type", "")).lower() == expected_type
        ]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise QualificationError(f"sfdisk returned invalid GPT JSON for {path}") from exc
    if len(matches) != 1:
        raise QualificationError(
            f"expected exactly one {architecture} discoverable root partition in {path}; found {len(matches)}"
        )
    start = matches[0].get("start")
    sectors = matches[0].get("size")
    if (
        not isinstance(sector_size, int)
        or isinstance(sector_size, bool)
        or sector_size <= 0
        or not isinstance(start, int)
        or isinstance(start, bool)
        or start <= 0
        or not isinstance(sectors, int)
        or isinstance(sectors, bool)
        or sectors <= 0
    ):
        raise QualificationError(f"discoverable root partition geometry is invalid in {path}")
    offset = start * sector_size
    length = sectors * sector_size
    if offset + length > path.stat().st_size:
        raise QualificationError(f"discoverable root partition exceeds image bounds in {path}")
    return {
        "offset": offset,
        "size": length,
        "sectorSize": sector_size,
        "type": expected_type,
    }


def hash_range(path: Path, offset: int, size: int) -> str:
    digest = hashlib.sha256()
    remaining = size
    with path.open("rb", buffering=0) as stream:
        stream.seek(offset)
        while remaining:
            chunk = stream.read(min(1024 * 1024, remaining))
            if not chunk:
                raise QualificationError(f"short root-partition read from {path}")
            digest.update(chunk)
            remaining -= len(chunk)
    return digest.hexdigest()


def copy_range(source: Path, destination: Path, offset: int, size: int) -> None:
    remaining = size
    with source.open("rb", buffering=0) as input_stream, destination.open("xb") as output_stream:
        input_stream.seek(offset)
        while remaining:
            chunk = input_stream.read(min(4 * 1024 * 1024, remaining))
            if not chunk:
                raise QualificationError(f"short root-partition read from {source}")
            output_stream.write(chunk)
            remaining -= len(chunk)
        output_stream.flush()
        os.fsync(output_stream.fileno())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-a-evidence", type=Path, required=True)
    parser.add_argument("--build-b-evidence", type=Path, required=True)
    parser.add_argument("--compressed-a", type=Path, required=True)
    parser.add_argument("--compressed-b", type=Path, required=True)
    parser.add_argument("--image-a", type=Path, required=True)
    parser.add_argument("--image-b", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--diffoscope-report", type=Path, required=True)
    parser.add_argument("--diffoscope", default="diffoscope")
    parser.add_argument("--diffoscope-max-report-bytes", type=int, default=10 * 1024 * 1024)
    args = parser.parse_args()

    input_paths = (
        args.build_a_evidence,
        args.build_b_evidence,
        args.compressed_a,
        args.compressed_b,
        args.image_a,
        args.image_b,
    )
    output_paths = (args.evidence, args.diffoscope_report)
    if any(path.exists() or path.is_symlink() for path in output_paths):
        print("[mkosi-reproducibility] evidence outputs must not already exist", file=sys.stderr)
        return 2
    resolved_paths = [path.resolve() for path in (*input_paths, *output_paths)]
    existing_inputs = [path for path in input_paths if path.exists()]
    aliases = len(set(resolved_paths)) != len(resolved_paths) or any(
        os.path.samefile(first, second)
        for index, first in enumerate(existing_inputs)
        for second in existing_inputs[index + 1 :]
    )
    if aliases:
        print(
            "[mkosi-reproducibility] all input and output paths must be distinct",
            file=sys.stderr,
        )
        return 2

    started = time.monotonic()
    errors: list[str] = []
    document: dict[str, object] = {
        "schema": SCHEMA,
        "claimBoundary": CLAIM,
        "startedAt": now(),
        "completedAt": None,
        "durationSeconds": None,
        "success": False,
        "reproducible": False,
        "errors": errors,
    }
    try:
        if args.diffoscope_max_report_bytes < 1024:
            raise QualificationError("diffoscope report limit must be at least 1024 bytes")
        zstd = shutil.which("zstd")
        sfdisk = shutil.which("sfdisk")
        if not zstd or not sfdisk:
            raise QualificationError("zstd and sfdisk are required")

        build_a_record, build_a_document = json_file(args.build_a_evidence, "build A evidence")
        build_b_record, build_b_document = json_file(args.build_b_evidence, "build B evidence")
        if build_a_record["sha256"] == build_b_record["sha256"]:
            raise QualificationError(
                "isolated builds require two distinct build evidence records"
            )
        compressed_a = regular_file(args.compressed_a, "compressed image A")
        compressed_b = regular_file(args.compressed_b, "compressed image B")
        image_a = regular_file(args.image_a, "expanded image A")
        image_b = regular_file(args.image_b, "expanded image B")
        identity_a = validate_build(build_a_document, compressed_a, "build A evidence")
        identity_b = validate_build(build_b_document, compressed_b, "build B evidence")
        if identity_a != identity_b:
            raise QualificationError("isolated builds do not share identical reproducibility inputs")
        verify_expansion(args.compressed_a, image_a, zstd)
        verify_expansion(args.compressed_b, image_b, zstd)

        architecture = str(identity_a["architecture"])
        root_a = root_partition(args.image_a, sfdisk, architecture)
        root_b = root_partition(args.image_b, sfdisk, architecture)
        if root_a != root_b:
            raise QualificationError(
                "isolated builds have different discoverable root partition geometry"
            )
        root_a["sha256"] = hash_range(args.image_a, root_a["offset"], root_a["size"])
        root_b["sha256"] = hash_range(args.image_b, root_b["offset"], root_b["size"])
        document["buildIdentity"] = identity_a
        document["inputs"] = {
            "buildA": {"evidence": build_a_record, "compressed": compressed_a, "expanded": image_a},
            "buildB": {"evidence": build_b_record, "compressed": compressed_b, "expanded": image_b},
        }
        document["rootPartitions"] = {"buildA": root_a, "buildB": root_b}

        if root_a["sha256"] == root_b["sha256"]:
            document["reproducible"] = True
            document["success"] = True
        else:
            errors.append("isolated build root partitions are not byte-reproducible")
            diffoscope = shutil.which(args.diffoscope)
            diagnostic: dict[str, object] = {"attempted": True, "completed": False}
            document["diffoscope"] = diagnostic
            if not diffoscope:
                errors.append(f"diffoscope is unavailable: {args.diffoscope}")
            else:
                args.diffoscope_report.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryDirectory(prefix="elizaos-root-diff-") as temporary:
                    root_dir = Path(temporary)
                    extracted_a = root_dir / "build-a-elizaos-root.img"
                    extracted_b = root_dir / "build-b-elizaos-root.img"
                    copy_range(args.image_a, extracted_a, root_a["offset"], root_a["size"])
                    copy_range(args.image_b, extracted_b, root_b["offset"], root_b["size"])
                    command = [
                        diffoscope,
                        "--text", str(args.diffoscope_report),
                        "--max-report-size", str(args.diffoscope_max_report_bytes),
                        str(extracted_a), str(extracted_b),
                    ]
                    result = subprocess.run(command, text=True, capture_output=True, check=False)
                diagnostic["command"] = command
                diagnostic["returnCode"] = result.returncode
                if result.returncode != 1:
                    errors.append(f"diffoscope did not report the root difference (status {result.returncode})")
                elif not args.diffoscope_report.is_file() or args.diffoscope_report.is_symlink():
                    errors.append("diffoscope did not produce a regular report")
                else:
                    report = regular_file(args.diffoscope_report, "diffoscope report")
                    if report["size"] > args.diffoscope_max_report_bytes:
                        errors.append("diffoscope report exceeded its configured size bound")
                    else:
                        diagnostic["completed"] = True
                        diagnostic["report"] = report
    except (OSError, QualificationError, subprocess.SubprocessError) as exc:
        errors.append(str(exc))

    document["completedAt"] = now()
    document["durationSeconds"] = round(time.monotonic() - started, 3)
    write_evidence(args.evidence, document)
    for error in errors:
        print(f"[mkosi-reproducibility] {error}", file=sys.stderr)
    if document["success"] is True:
        print(f"[mkosi-reproducibility] evidence: {args.evidence}")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
