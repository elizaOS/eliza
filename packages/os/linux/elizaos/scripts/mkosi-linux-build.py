#!/usr/bin/env python3
"""Build one canonical mkosi image on Linux and record bounded local evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


ARCHITECTURES = {"amd64": "x86-64", "arm64": "arm64", "riscv64": "riscv64"}
SCHEMA = "ai.elizaos.mkosi-build-evidence.v1"
SNAPSHOT_RE = re.compile(
    r"https://snapshot\.debian\.org/archive/debian/\d{8}T\d{6}Z/?"
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def configuration_digest(path: Path) -> str:
    digest = hashlib.sha256()
    for candidate in sorted(path.rglob("*")):
        relative = candidate.relative_to(path).as_posix().encode("utf-8")
        if candidate.is_symlink():
            digest.update(b"L\0" + relative + b"\0" + os.readlink(candidate).encode("utf-8") + b"\0")
        elif candidate.is_file():
            digest.update(b"F\0" + relative + b"\0")
            with candidate.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            digest.update(b"\0")
    return digest.hexdigest()


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


def git_identity(git: str, repository: Path) -> tuple[str, bool]:
    commit = subprocess.run(
        [git, "-C", str(repository), "rev-parse", "HEAD"],
        text=True,
        capture_output=True,
        check=False,
    )
    status = subprocess.run(
        [git, "-C", str(repository), "status", "--porcelain", "--untracked-files=all"],
        text=True,
        capture_output=True,
        check=False,
    )
    if commit.returncode != 0 or status.returncode != 0:
        raise RuntimeError("Git source identity inspection failed")
    return commit.stdout.strip(), bool(status.stdout.strip())


def artifact_inputs(path: Path) -> list[dict[str, object]]:
    if any(candidate.is_symlink() or not candidate.is_file() for candidate in path.iterdir()):
        raise ValueError("artifact staging directory contains a link or non-file")
    return [
        {
            "path": candidate.name,
            "size": candidate.stat().st_size,
            "sha256": sha256_file(candidate),
        }
        for candidate in sorted(path.iterdir())
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--architecture", choices=sorted(ARCHITECTURES), required=True)
    parser.add_argument("--mkosi-dir", type=Path, default=Path(__file__).parent.parent / "mkosi")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--profile", choices=("default", "gui", "secure", "secure-gui"), default="default")
    parser.add_argument("--build-mode", choices=("development", "fixture", "release"), default="development")
    parser.add_argument("--debian-snapshot-url")
    parser.add_argument("--desktop-artifact-dir", type=Path)
    parser.add_argument("--package-cache-dir", type=Path)
    parser.add_argument("--allow-dirty-development", action="store_true")
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args()

    document: dict[str, object] = {
        "schema": SCHEMA,
        "claimBoundary": "mkosi_disk_assembly_only_no_boot_or_hardware_claim",
        "architecture": args.architecture,
        "mkosiArchitecture": ARCHITECTURES[args.architecture],
        "host": {"system": platform.system(), "machine": platform.machine()},
        "startedAt": now(),
        "completedAt": None,
        "durationSeconds": None,
        "preflightOnly": args.preflight_only,
        "buildMode": args.build_mode,
        "profile": args.profile,
        "success": False,
        "errors": [],
        "command": None,
        "returnCode": None,
        "artifacts": [],
    }
    started = time.monotonic()
    errors: list[str] = document["errors"]  # type: ignore[assignment]
    repository: Path | None = None

    if platform.system() != "Linux":
        errors.append("mkosi image assembly is supported only on a Linux host")
    if not args.mkosi_dir.is_dir() or not (args.mkosi_dir / "mkosi.conf").is_file():
        errors.append(f"canonical mkosi directory is invalid: {args.mkosi_dir}")
    else:
        document["configurationSha256"] = configuration_digest(args.mkosi_dir)
    git = shutil.which("git")
    if not git:
        errors.append("git is required to bind build evidence to a source commit")
    else:
        root_result = subprocess.run(
            [git, "-C", str(args.mkosi_dir), "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            check=False,
        )
        if root_result.returncode != 0:
            errors.append("mkosi directory is not in a Git worktree")
        else:
            repository = Path(root_result.stdout.strip())
            try:
                source_commit, source_dirty = git_identity(git, repository)
            except RuntimeError as exc:
                errors.append(str(exc))
            else:
                document["sourceCommit"] = source_commit
                document["sourceDirty"] = source_dirty
                if source_dirty and (
                    args.build_mode == "release" or not args.allow_dirty_development
                ):
                    errors.append(
                        "source worktree is dirty; only explicit non-release development builds may allow it"
                    )
    mkosi = shutil.which("mkosi")
    if not mkosi:
        errors.append("mkosi 25.3 or newer is not on PATH")
    else:
        version = subprocess.run(
            [mkosi, "--version"], text=True, capture_output=True, check=False
        )
        document["mkosiVersion"] = (version.stdout or version.stderr).strip()
        if version.returncode != 0:
            errors.append("mkosi --version failed")
        else:
            match = re.search(r"\b(\d+)\.(\d+)", str(document["mkosiVersion"]))
            if not match or tuple(map(int, match.groups())) < (25, 3):
                errors.append("mkosi version is older than the required 25.3")
    for command in ("systemd-repart", "losetup"):
        if not shutil.which(command):
            errors.append(f"required Linux image tool is not on PATH: {command}")
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        errors.append("canonical disk assembly requires root or an equivalent privileged container")
    if args.build_mode == "release":
        if not args.debian_snapshot_url or not SNAPSHOT_RE.fullmatch(args.debian_snapshot_url):
            errors.append("release builds require a dated snapshot.debian.org archive URL")
        if not os.environ.get("SOURCE_DATE_EPOCH", "").isdigit():
            errors.append("release builds require numeric SOURCE_DATE_EPOCH")
        if not os.environ.get("ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY"):
            errors.append("release builds require ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY")
        if not re.fullmatch(
            r"[0-9a-f]{64}",
            os.environ.get("ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY_SPKI_SHA256", ""),
        ):
            errors.append(
                "release builds require a lowercase pinned desktop signing SPKI SHA-256"
            )
        document["sourceDateEpoch"] = os.environ.get("SOURCE_DATE_EPOCH")
        document["debianSnapshotUrl"] = args.debian_snapshot_url
        artifact_dir = args.desktop_artifact_dir
        if artifact_dir is None or not artifact_dir.is_dir() or artifact_dir.is_symlink():
            errors.append("release builds require a regular --desktop-artifact-dir")
        else:
            manifest_path = artifact_dir / "desktop-artifact-manifest.json"
            try:
                artifact_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                archive_name = artifact_manifest["archive"]
                signature_name = artifact_manifest["signature"]
                manifest_signature_name = artifact_manifest["manifestSignature"]
                if any(
                    not isinstance(name, str) or not name or Path(name).name != name
                    for name in (
                        archive_name,
                        signature_name,
                        manifest_signature_name,
                    )
                ):
                    raise ValueError("artifact names are not plain filenames")
                if manifest_signature_name != "desktop-artifact-manifest.json.sig":
                    raise ValueError("manifest signature filename is not canonical")
                image_key = os.environ.get("ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY", "")
                key_prefix = "/opt/elizaos/share/"
                if not image_key.startswith(key_prefix) or Path(image_key).name != image_key.removeprefix(
                    key_prefix
                ):
                    raise ValueError(
                        "desktop public key path must be a direct child of /opt/elizaos/share"
                    )
                expected_names = {
                    manifest_path.name,
                    archive_name,
                    signature_name,
                    manifest_signature_name,
                    Path(image_key).name,
                }
                actual_files = {
                    path.name
                    for path in artifact_dir.iterdir()
                    if path.is_file() and not path.is_symlink()
                }
                if actual_files != expected_names:
                    raise ValueError(
                        "artifact staging directory must contain exactly manifest, both signatures, archive, and public key"
                    )
                document["desktopArtifactInputs"] = artifact_inputs(artifact_dir)
            except (OSError, UnicodeError, json.JSONDecodeError, KeyError, ValueError) as exc:
                errors.append(f"desktop artifact staging contract failed: {exc}")
    if args.package_cache_dir:
        package_cache = args.package_cache_dir.resolve()
        if package_cache.exists() and (
            not package_cache.is_dir() or package_cache.is_symlink()
        ):
            errors.append("mkosi package cache must be a directory, not a symlink")
        document["packageCacheDirectory"] = str(package_cache)
    native = platform.machine().lower()
    target_native = {"amd64": ("x86_64", "amd64"), "arm64": ("aarch64", "arm64"), "riscv64": ("riscv64",)}
    if native not in target_native[args.architecture]:
        handler = Path("/proc/sys/fs/binfmt_misc") / f"qemu-{target_native[args.architecture][0]}"
        if not handler.is_file() or "enabled" not in handler.read_text(errors="replace"):
            errors.append(f"enabled binfmt handler is required for cross-architecture build: {handler.name}")

    command = [
        mkosi or "mkosi",
        "--force",
        "--architecture",
        ARCHITECTURES[args.architecture],
        "--output-dir",
        str(args.output_dir.resolve()),
        f"--environment=ELIZAOS_BUILD_MODE={args.build_mode}",
    ]
    if args.debian_snapshot_url:
        command.append(f"--mirror={args.debian_snapshot_url}")
    if args.desktop_artifact_dir:
        command.append(
            f"--extra-tree={args.desktop_artifact_dir.resolve()}:/opt/elizaos/share"
        )
    if args.package_cache_dir:
        command.append(
            f"--package-cache-dir={args.package_cache_dir.resolve()}"
        )
    if args.profile != "default":
        command.extend(("--profile", args.profile))
    command.append("build")
    document["command"] = command

    if errors or args.preflight_only:
        document["success"] = not errors
    else:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        log_path = args.output_dir / f"build-{args.architecture}-{args.profile}.log"
        with log_path.open("wb") as log:
            process = subprocess.run(command, cwd=args.mkosi_dir, stdout=log, stderr=subprocess.STDOUT, check=False)
        document["returnCode"] = process.returncode
        try:
            if git and repository is not None:
                final_commit, final_dirty = git_identity(git, repository)
                if (
                    final_commit != document.get("sourceCommit")
                    or final_dirty != document.get("sourceDirty")
                ):
                    errors.append("source identity changed during mkosi build")
            if configuration_digest(args.mkosi_dir) != document.get("configurationSha256"):
                errors.append("mkosi configuration changed during build")
            if args.build_mode == "release" and args.desktop_artifact_dir:
                if artifact_inputs(args.desktop_artifact_dir) != document.get("desktopArtifactInputs"):
                    errors.append("desktop artifact inputs changed during mkosi build")
        except (OSError, RuntimeError, ValueError) as exc:
            errors.append(f"post-build input verification failed: {exc}")
        candidates = sorted(
            path
            for path in args.output_dir.iterdir()
            if path.is_file() and not path.is_symlink()
        )
        image_token = f"elizaos-linux-{ARCHITECTURES[args.architecture]}"
        disk = [
            path
            for path in candidates
            if image_token in path.name
            and path.name.endswith(".raw.zst")
            and path.stat().st_size > 0
        ]
        manifests = [
            path
            for path in candidates
            if image_token in path.name
            and ".manifest" in path.name.lower()
            and not path.name.lower().endswith(".changelog")
            and path.stat().st_size > 0
        ]
        checksums = [path for path in candidates if "SHA256SUMS" in path.name or path.suffix == ".sha256"]
        if process.returncode != 0:
            errors.append(f"mkosi build exited with status {process.returncode}")
        if len(disk) != 1:
            errors.append(f"expected exactly one mkosi raw disk artifact, found {len(disk)}")
        if len(manifests) != 1:
            errors.append(
                f"expected exactly one nonempty mkosi JSON package manifest, found {len(manifests)}"
            )
        if len(manifests) == 1:
            try:
                json.loads(manifests[0].read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                errors.append("mkosi package manifest is not valid JSON")
        checksums = [path for path in checksums if path.stat().st_size > 0]
        if len(checksums) != 1:
            errors.append(
                f"expected exactly one nonempty mkosi checksum file, found {len(checksums)}"
            )
        if len(disk) == 1 and len(checksums) == 1:
            disk_digest = sha256_file(disk[0])
            checksum_text = checksums[0].read_text(
                encoding="utf-8", errors="replace"
            )
            if disk_digest not in checksum_text or disk[0].name not in checksum_text:
                errors.append("mkosi checksum output does not bind the emitted disk bytes")
        recorded = [log_path, *disk, *manifests, *checksums]
        document["artifacts"] = [
            {"path": str(path.resolve()), "size": path.stat().st_size, "sha256": sha256_file(path)}
            for path in recorded
            if path.is_file() and not path.is_symlink()
        ]
        document["success"] = not errors

    document["completedAt"] = now()
    document["durationSeconds"] = round(time.monotonic() - started, 3)
    write_evidence(args.evidence, document)
    if errors:
        for error in errors:
            print(f"[mkosi-build] {error}", file=sys.stderr)
        return 1
    if args.preflight_only:
        print("[mkosi-build] Linux host prerequisites satisfied")
    else:
        print(f"[mkosi-build] evidence: {args.evidence}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
