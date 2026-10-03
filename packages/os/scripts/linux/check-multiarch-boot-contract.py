#!/usr/bin/env python3
"""Static contract check for elizaOS Linux multi-arch UEFI boot support."""

from __future__ import annotations

from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2] / "linux" / "elizaos"

ARCH_PACKAGE_REQUIREMENTS = {
    "amd64": (
        "linux-image-amd64",
        "grub-efi-amd64-bin",
        "grub-pc-bin",
    ),
    "arm64": (
        "linux-image-arm64",
        "grub-efi-arm64-bin",
    ),
    "riscv64": (
        "linux-image-riscv64",
        "grub-efi-riscv64",
        "grub-efi-riscv64-bin",
    ),
}

DESKTOP_PACKAGE_REQUIREMENTS = (
    "xorg",
    "gdm3",
    "gnome-session",
    "gnome-shell",
    "gnome-terminal",
    "gnome-control-center",
    "nautilus",
    "network-manager",
    "network-manager-gnome",
    "pipewire",
    "pipewire-pulse",
    "wireplumber",
    "pulseaudio-utils",
    "epiphany-browser",
    "plymouth",
    "plymouth-themes",
    "plymouth-label",
)
GUI_RUNTIME_PACKAGE_REQUIREMENTS = (
    "libwebkit2gtk-4.1-0",
    "libgtk-3-0t64",
    "libgl1-mesa-dri",
    "libegl1",
    "gnome-shell-extension-dashtodock",
    "gnome-shell-extension-appindicator",
)

DOCKERFILE_REQUIREMENTS = (
    "grub-efi-amd64-bin",
    "grub-efi-arm64-bin",
    "grub-pc-bin",
    "ovmf",
    "qemu-system-arm",
    "qemu-system-misc",
    "qemu-efi-aarch64",
    "qemu-efi-riscv64",
    "qemu-user-static",
)

RISCV64_PORT_CONTRACT = {
    "architecture": "riscv64",
    "multiarch_tuple": "riscv64-linux-gnu",
    "gnu_triplet": "riscv64-unknown-linux-gnu",
    "removable_uefi_path": "EFI/boot/bootriscv64.efi",
}
RISCV64_UPSTREAM_REFERENCES = (
    "https://wiki.debian.org/Ports/riscv64",
    "https://wiki.debian.org/UEFI",
    "https://packages.debian.org/sid/grub-efi-riscv64",
)
ARCH_RUNTIME_EVIDENCE_REQUIREMENTS = {
    "amd64": (
        "Debian live ISO root filesystem boots under QEMU via extracted ISO kernel/initrd",
        "guest-side curl reached http://127.0.0.1:31337/api/health",
        "real packaged eliza agent service reported ready",
        "terminal TUI smoke reported ready",
    ),
    "arm64": (
        "Debian live ISO root filesystem boots under QEMU",
        "guest-side curl reached http://127.0.0.1:31337/api/health",
        "real packaged eliza agent service reported ready",
        "terminal TUI smoke reported ready",
    ),
    "riscv64": (
        "Debian live ISO boots under qemu-system-riscv64 -M virt through EDK2/OpenSBI",
        "GRUB EFI path is visible in transcript",
        "guest-side curl reached http://127.0.0.1:31337/api/health",
        "agent readiness marker reported",
        "terminal TUI smoke marker reported",
    ),
}
MATRIX_RUNTIME_EVIDENCE_SCHEMA = "eliza.os.linux.multiarch_boot_evidence.v1"
MATRIX_RUNTIME_CLAIM_BOUNDARY = (
    "qemu_boot_transcript_static_verification_only_no_physical_hardware_or_silicon_claim"
)
MATRIX_RUNTIME_EVIDENCE_FIELDS = frozenset(
    {
        "schema", "claim_boundary", "arch", "os_commit", "source_commit",
        "runtime_version", "iso_path", "iso_sha256", "qemu_executable",
        "qemu_version", "firmware_identity", "firmware_version", "firmware_path",
        "firmware_sha256", "transcript_path", "transcript_sha256", "transcript_size",
        "tool_inputs_sha256", "boot_completed", "markers_found", "markers_missing",
        "forbidden_markers_present",
    }
)
MATRIX_RUNTIME_MARKERS = (
    "Linux version",
    "elizaos-firstboot-ready",
    "elizaos-curl-health-ready",
    "elizaos-agent-ready",
    "elizaos-terminal-tui-ready",
)
MATRIX_RUNTIME_ARCH_MARKERS = {
    "amd64": MATRIX_RUNTIME_MARKERS,
    "arm64": MATRIX_RUNTIME_MARKERS,
    "riscv64": (*MATRIX_RUNTIME_MARKERS, "GNU GRUB"),
}
MATRIX_FORBIDDEN_TRANSCRIPT_MARKERS = (
    "Kernel panic",
    "Entering emergency mode",
    "Illegal instruction",
    "unhandled signal 4",
)
MATRIX_QEMU_EXECUTABLES = {
    "amd64": "qemu-system-x86_64",
    "arm64": "qemu-system-aarch64",
    "riscv64": "qemu-system-riscv64",
}
MATRIX_FIRMWARE_IDENTITIES = {
    "amd64": "OVMF",
    "arm64": "AAVMF",
    "riscv64": "RISCV_VIRT",
}
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$")
QEMU_VERSION_PATTERN = re.compile(
    r"^QEMU emulator version [0-9]+\.[0-9]+(?:\.[0-9]+)?"
    r"(?:[-+~.][0-9A-Za-z.+~-]+)?(?: \([^\r\n]+\))?$"
)
BLOCKING_GAP_PATTERNS = (
    "fallback agent",
    "missing-current-iso-evidence",
    "must be staged",
    "must be recaptured",
    "need to be collected",
    "predates verified",
    "times out before",
    "runtime binary is missing",
    "illegal instruction",
    "sigill",
    "unhandled signal 4",
)


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def package_lines(path: Path) -> set[str]:
    lines: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        lines.add(line)
    return lines


def require(errors: list[str], condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def architecture_rows(matrix: dict) -> dict[str, dict]:
    rows = matrix.get("architectures", [])
    if not isinstance(rows, list):
        return {}
    return {
        row.get("arch"): row
        for row in rows
        if isinstance(row, dict) and isinstance(row.get("arch"), str)
    }


def matrix_blocking_gaps(row: dict) -> list[str]:
    gaps = row.get("gaps", [])
    if not isinstance(gaps, list):
        return ["gaps field is not a list"]
    blocked: list[str] = []
    for gap in gaps:
        if not isinstance(gap, str):
            continue
        lowered = gap.lower()
        if any(pattern in lowered for pattern in BLOCKING_GAP_PATTERNS):
            blocked.append(gap)
    return blocked


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _repo_path(value: str) -> Path | None:
    """Resolve a recorded repo path without permitting traversal or symlinks."""
    if not isinstance(value, str) or not value:
        return None
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        return None
    candidate = ROOT.resolve()
    for part in relative.parts:
        if part in ("", "."):
            continue
        candidate /= part
        try:
            if candidate.is_symlink():
                return None
        except OSError:
            return None
    return candidate


def _current_os_commit() -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError("cannot resolve current repository HEAD") from exc
    commit = result.stdout.strip()
    if COMMIT_PATTERN.fullmatch(commit) is None:
        raise RuntimeError("current repository HEAD is not a clean 40-hex commit")
    try:
        status = subprocess.run(
            [
                "git", "-C", str(ROOT), "status", "--porcelain=v1",
                "--untracked-files=all",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError("cannot verify repository cleanliness at current HEAD") from exc
    if status.stdout:
        raise RuntimeError(
            "repository must have no staged, unstaged, or non-ignored untracked changes at current HEAD"
        )
    return commit


def _locked_source_commit() -> str:
    relative = "app-source.lock.json"
    lock_path = _repo_path(relative)
    if lock_path is None or not lock_path.is_file():
        raise RuntimeError("app-source.lock.json is missing or unsafe")
    try:
        subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "--error-unmatch", relative],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["git", "-C", str(ROOT), "diff", "--quiet", "HEAD", "--", relative],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError(
            "app-source.lock.json must be tracked and clean at current HEAD"
        ) from exc
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("cannot read app-source.lock.json") from exc
    expected_fields = {"schema", "repository", "commit", "buildInfoPath"}
    if not isinstance(lock, dict) or set(lock) != expected_fields:
        raise RuntimeError("app-source.lock.json fields do not match the established schema")
    if lock["schema"] != "eliza.os.linux.app-source-lock.v1":
        raise RuntimeError("app-source.lock.json schema identity is invalid")
    if lock["repository"] != "https://github.com/elizaOS/eliza":
        raise RuntimeError("app-source.lock.json repository identity is invalid")
    if lock["buildInfoPath"] != "Resources/app/eliza-dist/build-info.json":
        raise RuntimeError("app-source.lock.json buildInfoPath identity is invalid")
    commit = lock["commit"]
    if not isinstance(commit, str) or COMMIT_PATTERN.fullmatch(commit) is None:
        raise RuntimeError("app-source.lock.json commit is not a clean 40-hex commit")
    return commit


def _authorized_runtime_input_hashes(errors: list[str], arch: str) -> set[str] | None:
    relative = "config/multiarch-runtime-tool-inputs.lock.json"
    path = _repo_path(relative)
    if path is None or not path.is_file():
        errors.append(f"multiarch runtime tool-input authorization is missing or unsafe: {relative}")
        return None
    try:
        subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "--error-unmatch", relative],
            check=True, capture_output=True, text=True,
        )
        subprocess.run(
            ["git", "-C", str(ROOT), "diff", "--quiet", "HEAD", "--", relative],
            check=True, capture_output=True, text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        errors.append(
            "multiarch runtime tool-input authorization must be tracked and clean at current HEAD"
        )
        return None
    try:
        policy = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"multiarch runtime tool-input authorization is invalid JSON: {exc}")
        return None
    if not isinstance(policy, dict) or set(policy) != {"schema", "authorized_sha256"}:
        errors.append("multiarch runtime tool-input authorization fields mismatch")
        return None
    if policy["schema"] != "eliza.os.linux.runtime_tool_input_authorization.v1":
        errors.append("multiarch runtime tool-input authorization schema mismatch")
        return None
    profiles = policy["authorized_sha256"]
    if not isinstance(profiles, dict) or set(profiles) != set(MATRIX_RUNTIME_ARCH_MARKERS):
        errors.append("multiarch runtime tool-input authorization architecture set mismatch")
        return None
    hashes = profiles[arch]
    if (
        not isinstance(hashes, list)
        or any(not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None for value in hashes)
        or len(hashes) != len(set(hashes))
    ):
        errors.append(f"multiarch runtime tool-input authorization {arch} hashes are invalid")
        return None
    return set(hashes)


def _runtime_input_lock(errors: list[str], arch: str, evidence_path: Path, expected_sha: object) -> dict | None:
    lock_path = evidence_path.with_suffix(".tool-inputs.json")
    relative_lock = lock_path.relative_to(ROOT.resolve()).as_posix()
    safe_lock = _repo_path(relative_lock)
    if safe_lock is None or not safe_lock.is_file():
        errors.append(
            f"multiarch boot matrix {arch} runtime tool-input lock missing or unsafe: {relative_lock}"
        )
        return None
    try:
        lock_bytes = safe_lock.read_bytes()
        lock = json.loads(lock_bytes.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"multiarch boot matrix {arch} runtime tool-input lock is invalid JSON: {exc}")
        return None
    actual_sha = hashlib.sha256(lock_bytes).hexdigest()
    require(errors, isinstance(expected_sha, str) and SHA256_PATTERN.fullmatch(expected_sha) is not None,
            f"multiarch boot matrix {arch} evidence tool_inputs_sha256 is invalid")
    require(errors, expected_sha == actual_sha,
            f"multiarch boot matrix {arch} runtime tool-input lock sha256 mismatch")
    authorized = _authorized_runtime_input_hashes(errors, arch)
    if authorized is not None:
        require(errors, actual_sha in authorized,
                f"multiarch boot matrix {arch} runtime tool-input lock is not authorized by current HEAD")
    expected_fields = {
        "schema", "arch", "runtime_version", "qemu_executable", "qemu_version",
        "firmware_identity", "firmware_version", "firmware_path", "firmware_sha256",
    }
    if not isinstance(lock, dict) or set(lock) != expected_fields:
        errors.append(f"multiarch boot matrix {arch} runtime tool-input lock fields mismatch")
        return None
    require(errors, lock["schema"] == "eliza.os.linux.runtime_tool_inputs.v1",
            f"multiarch boot matrix {arch} runtime tool-input lock schema mismatch")
    require(errors, lock["arch"] == arch,
            f"multiarch boot matrix {arch} runtime tool-input lock arch mismatch")
    return lock


def _transcript_has_marker(transcript: str, marker: str) -> bool:
    """Require a concrete console line, not prose which happens to name a marker."""
    escaped = re.escape(marker)
    if marker == "Linux version":
        pattern = rf"^(?:\[[^\]\n]+\]\s*)?{escaped}\b"
    elif marker == "GNU GRUB":
        pattern = rf"^\s*{escaped}(?:\s+version\b|\s*$)"
    else:
        pattern = rf"^\s*{escaped}\s*$"
    return re.search(pattern, transcript, flags=re.MULTILINE) is not None


def validate_runtime_evidence(errors: list[str], arch: str, row: dict) -> None:
    """Statically verify retained QEMU evidence; this does not claim a new boot."""
    evidence_value = row.get("evidence")
    if not isinstance(evidence_value, str) or not evidence_value:
        return
    evidence_path = _repo_path(evidence_value)
    if evidence_path is None:
        errors.append(f"multiarch boot matrix {arch} evidence path is outside the repository")
        return
    if not evidence_path.is_file() or evidence_path.is_symlink():
        errors.append(
            f"multiarch boot matrix {arch} evidence artifact missing or unsafe: {evidence_value}"
        )
        return
    try:
        document = json.loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"multiarch boot matrix {arch} evidence is invalid JSON: {exc}")
        return
    if not isinstance(document, dict):
        errors.append(f"multiarch boot matrix {arch} evidence must be a JSON object")
        return
    missing = sorted(MATRIX_RUNTIME_EVIDENCE_FIELDS - set(document))
    unexpected = sorted(set(document) - MATRIX_RUNTIME_EVIDENCE_FIELDS)
    require(errors, not missing, f"multiarch boot matrix {arch} evidence missing fields: {missing}")
    require(errors, not unexpected,
            f"multiarch boot matrix {arch} evidence has unexpected fields: {unexpected}")
    if missing or unexpected:
        return

    require(errors, document["schema"] == MATRIX_RUNTIME_EVIDENCE_SCHEMA,
            f"multiarch boot matrix {arch} evidence schema mismatch")
    require(errors, document["claim_boundary"] == MATRIX_RUNTIME_CLAIM_BOUNDARY,
            f"multiarch boot matrix {arch} evidence claim_boundary mismatch")
    require(errors, document["arch"] == arch,
            f"multiarch boot matrix {arch} evidence arch mismatch")

    for field in ("os_commit", "source_commit"):
        value = document[field]
        require(errors, isinstance(value, str) and COMMIT_PATTERN.fullmatch(value) is not None,
                f"multiarch boot matrix {arch} evidence {field} must be a clean 40-hex commit")
        require(errors, value == row.get(field),
                f"multiarch boot matrix {arch} evidence {field} does not match matrix row")
    try:
        current_commit = _current_os_commit()
    except RuntimeError as exc:
        errors.append(f"multiarch boot matrix {arch} evidence cannot bind os_commit: {exc}")
    else:
        require(errors, document["os_commit"] == current_commit,
                f"multiarch boot matrix {arch} evidence os_commit is not current repository HEAD")
    try:
        locked_source_commit = _locked_source_commit()
    except RuntimeError as exc:
        errors.append(f"multiarch boot matrix {arch} evidence cannot bind source_commit: {exc}")
    else:
        require(errors, document["source_commit"] == locked_source_commit,
                f"multiarch boot matrix {arch} evidence source_commit does not match app-source.lock.json")

    tool_lock = _runtime_input_lock(errors, arch, evidence_path, document["tool_inputs_sha256"])

    runtime_version = document["runtime_version"]
    require(errors, isinstance(runtime_version, str)
            and VERSION_PATTERN.fullmatch(runtime_version) is not None,
            f"multiarch boot matrix {arch} evidence runtime_version is invalid")
    require(errors, runtime_version == row.get("runtime_version"),
            f"multiarch boot matrix {arch} evidence runtime_version does not match matrix row")
    if tool_lock is not None:
        for field in (
            "runtime_version", "qemu_executable", "qemu_version", "firmware_identity",
            "firmware_version", "firmware_path", "firmware_sha256",
        ):
            require(errors, document[field] == tool_lock[field],
                    f"multiarch boot matrix {arch} evidence {field} does not match runtime tool-input lock")

    iso_path = _repo_path(document["iso_path"])
    require(errors, document["iso_path"] == row.get("iso"),
            f"multiarch boot matrix {arch} evidence iso_path does not match matrix row")
    require(errors, isinstance(document["iso_sha256"], str)
            and SHA256_PATTERN.fullmatch(document["iso_sha256"]) is not None
            and document["iso_sha256"] == row.get("sha256"),
            f"multiarch boot matrix {arch} evidence ISO sha256 does not match matrix row")
    if iso_path is None or not iso_path.is_file() or iso_path.is_symlink():
        errors.append(f"multiarch boot matrix {arch} evidence ISO path is missing or unsafe")
    elif document["iso_sha256"] != sha256_file(iso_path):
        errors.append(f"multiarch boot matrix {arch} evidence ISO sha256 does not match ISO bytes")

    require(errors, document["qemu_executable"] == MATRIX_QEMU_EXECUTABLES[arch],
            f"multiarch boot matrix {arch} evidence qemu_executable mismatch")
    require(errors, isinstance(document["qemu_version"], str)
            and QEMU_VERSION_PATTERN.fullmatch(document["qemu_version"]) is not None,
            f"multiarch boot matrix {arch} evidence qemu_version is invalid")
    require(errors, document["firmware_identity"] == MATRIX_FIRMWARE_IDENTITIES[arch],
            f"multiarch boot matrix {arch} evidence firmware_identity mismatch")
    require(errors, isinstance(document["firmware_version"], str)
            and VERSION_PATTERN.fullmatch(document["firmware_version"]) is not None,
            f"multiarch boot matrix {arch} evidence firmware_version is invalid")
    firmware_path = _repo_path(document["firmware_path"])
    firmware_sha = document["firmware_sha256"]
    require(errors, isinstance(firmware_sha, str) and SHA256_PATTERN.fullmatch(firmware_sha) is not None,
            f"multiarch boot matrix {arch} evidence firmware_sha256 is invalid")
    if firmware_path is None or not firmware_path.is_file() or firmware_path.is_symlink():
        errors.append(f"multiarch boot matrix {arch} evidence firmware path is missing or unsafe")
    elif firmware_sha != sha256_file(firmware_path):
        errors.append(f"multiarch boot matrix {arch} evidence firmware sha256 mismatch")

    transcript_path = _repo_path(document["transcript_path"])
    transcript_sha = document["transcript_sha256"]
    transcript_size = document["transcript_size"]
    require(errors, isinstance(transcript_sha, str)
            and SHA256_PATTERN.fullmatch(transcript_sha) is not None,
            f"multiarch boot matrix {arch} evidence transcript_sha256 is invalid")
    require(errors, isinstance(transcript_size, int) and not isinstance(transcript_size, bool)
            and transcript_size > 0,
            f"multiarch boot matrix {arch} evidence transcript_size must be a positive integer")
    transcript_text = ""
    if transcript_path is None or not transcript_path.is_file() or transcript_path.is_symlink():
        errors.append(f"multiarch boot matrix {arch} evidence transcript path is missing or unsafe")
    else:
        transcript_bytes = transcript_path.read_bytes()
        require(errors, transcript_sha == hashlib.sha256(transcript_bytes).hexdigest(),
                f"multiarch boot matrix {arch} evidence transcript sha256 mismatch")
        require(errors, transcript_size == len(transcript_bytes),
                f"multiarch boot matrix {arch} evidence transcript size mismatch")
        transcript_text = transcript_bytes.decode("utf-8", errors="replace")

    require(errors, document["boot_completed"] is True,
            f"multiarch boot matrix {arch} evidence boot_completed must be true")
    found = document["markers_found"]
    require(errors, isinstance(found, list) and all(isinstance(marker, str) for marker in found),
            f"multiarch boot matrix {arch} evidence markers_found must be a string array")
    require(errors, document["markers_missing"] == [],
            f"multiarch boot matrix {arch} evidence markers_missing must be empty")
    require(errors, document["forbidden_markers_present"] == [],
            f"multiarch boot matrix {arch} evidence forbidden_markers_present must be empty")
    if isinstance(found, list):
        require(errors, len(found) == len(set(found)),
                f"multiarch boot matrix {arch} evidence markers_found contains duplicates")
        for marker in MATRIX_RUNTIME_ARCH_MARKERS[arch]:
            require(errors, marker in found,
                    f"multiarch boot matrix {arch} evidence missing marker: {marker}")
            require(errors, _transcript_has_marker(transcript_text, marker),
                    f"multiarch boot matrix {arch} transcript missing marker: {marker}")
    for marker in MATRIX_FORBIDDEN_TRANSCRIPT_MARKERS:
        require(errors, marker not in transcript_text,
                f"multiarch boot matrix {arch} transcript contains forbidden marker: {marker}")


def validate_runtime_artifacts(errors: list[str], matrix: dict) -> None:
    rows = architecture_rows(matrix)
    for arch, row in rows.items():
        artifacts = row.get("runtime_artifacts")
        if artifacts is None:
            continue
        require(
            errors,
            isinstance(artifacts, dict),
            f"multiarch boot matrix {arch} runtime_artifacts must be an object",
        )
        if not isinstance(artifacts, dict):
            continue
        bun = artifacts.get("bun")
        agent_bundle = artifacts.get("agent_bundle")
        expected_sha = artifacts.get("bun_sha256")
        runtime_mode = artifacts.get("runtime_mode", "bun")
        riscv64_bun_provenance = artifacts.get("riscv64_bun_provenance")
        require(
            errors,
            runtime_mode in ("bun", "node"),
            f"multiarch boot matrix {arch} runtime_artifacts.runtime_mode must be bun or node",
        )
        require(
            errors,
            runtime_mode == "node" or (isinstance(bun, str) and bool(bun)),
            f"multiarch boot matrix {arch} runtime_artifacts.bun missing",
        )
        require(
            errors,
            isinstance(agent_bundle, str) and bool(agent_bundle),
            f"multiarch boot matrix {arch} runtime_artifacts.agent_bundle missing",
        )
        require(
            errors,
            runtime_mode == "node" or (isinstance(expected_sha, str) and len(expected_sha) == 64),
            f"multiarch boot matrix {arch} runtime_artifacts.bun_sha256 must be 64 hex chars",
        )
        if runtime_mode == "node":
            if isinstance(agent_bundle, str):
                agent_bundle_path = ROOT / agent_bundle
                require(
                    errors,
                    agent_bundle_path.is_dir(),
                    f"multiarch boot matrix {arch} agent bundle missing: {agent_bundle}",
                )
                bundle = agent_bundle_path / "agent-bundle.js"
                require(
                    errors,
                    bundle.is_file(),
                    f"multiarch boot matrix {arch} node runtime artifact missing: {agent_bundle}/agent-bundle.js",
                )
                if bundle.is_file():
                    first = bundle.read_text(encoding="utf-8", errors="ignore").splitlines()[:1]
                    require(
                        errors,
                        first in (["#!/usr/bin/env node"], ["#!/usr/bin/node"]),
                        f"multiarch boot matrix {arch} node agent bundle missing node shebang",
                    )
            continue
        if not (isinstance(bun, str) and isinstance(expected_sha, str) and len(expected_sha) == 64):
            continue
        bun_path = ROOT / bun
        require(
            errors,
            bun_path.is_file(),
            f"multiarch boot matrix {arch} runtime artifact missing: {bun}",
        )
        if bun_path.is_file():
            actual_sha = sha256_file(bun_path)
            require(
                errors,
                actual_sha == expected_sha,
                f"multiarch boot matrix {arch} runtime artifact {bun} sha256 mismatch: {actual_sha}",
            )
        if isinstance(agent_bundle, str):
            agent_bundle_path = ROOT / agent_bundle
            require(
                errors,
                agent_bundle_path.is_dir(),
                f"multiarch boot matrix {arch} agent bundle missing: {agent_bundle}",
            )
            if (
                arch == "riscv64"
                and bun_path.is_file()
                and agent_bundle_path.is_dir()
                and "musl-runtime/bun" in bun_path.read_text(
                    encoding="utf-8", errors="ignore"
                )
            ):
                require(
                    errors,
                    (agent_bundle_path / "musl-runtime/bun").is_file(),
                    "multiarch boot matrix riscv64 wrapper requires runtime artifact "
                    f"{agent_bundle}/musl-runtime/bun",
                )
                require(
                    errors,
                    isinstance(riscv64_bun_provenance, str) and bool(riscv64_bun_provenance),
                    "multiarch boot matrix riscv64 runtime_artifacts.riscv64_bun_provenance missing",
                )
                if isinstance(riscv64_bun_provenance, str) and riscv64_bun_provenance:
                    provenance_path = ROOT / riscv64_bun_provenance
                    require(
                        errors,
                        provenance_path.is_file(),
                        "multiarch boot matrix riscv64 Bun provenance artifact missing: "
                        f"{riscv64_bun_provenance}",
                    )
                    if provenance_path.is_file():
                        try:
                            provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
                        except json.JSONDecodeError as exc:
                            errors.append(
                                "multiarch boot matrix riscv64 Bun provenance is invalid JSON: "
                                f"{riscv64_bun_provenance}: {exc}"
                            )
                        else:
                            require(
                                errors,
                                provenance.get("schema")
                                == "eliza.os.linux.riscv64_bun_stage_provenance.v1",
                                "multiarch boot matrix riscv64 Bun provenance schema mismatch",
                            )
                            artifact = provenance.get("artifact", {})
                            recorded_bun_sha = (
                                artifact.get("staged_bun_sha256")
                                if isinstance(artifact, dict)
                                else None
                            )
                            runtime_bun = agent_bundle_path / "musl-runtime/bun"
                            if runtime_bun.is_file():
                                require(
                                    errors,
                                    recorded_bun_sha == sha256_file(runtime_bun),
                                    "multiarch boot matrix riscv64 Bun provenance staged_bun_sha256 "
                                    "does not match runtime musl Bun",
                                )
                            inputs = provenance.get("inputs", {})
                            require(
                                errors,
                                isinstance(inputs, dict)
                                and "toolchains/bun-riscv64/bun-version.json"
                                in inputs,
                                "multiarch boot matrix riscv64 Bun provenance does not record "
                                "bun-version.json",
                            )


def validate_runtime_matrix(errors: list[str], matrix: dict) -> None:
    rows = architecture_rows(matrix)
    for arch, required_proofs in ARCH_RUNTIME_EVIDENCE_REQUIREMENTS.items():
        row = rows.get(arch)
        require(errors, row is not None, f"multiarch boot matrix missing {arch} row")
        if row is None:
            continue
        require(
            errors,
            row.get("status") == "candidate",
            f"multiarch boot matrix {arch} status must be candidate, got {row.get('status')!r}",
        )
        require(
            errors,
            isinstance(row.get("iso"), str) and bool(row["iso"]),
            f"multiarch boot matrix {arch} must record an ISO artifact",
        )
        require(
            errors,
            isinstance(row.get("sha256"), str)
            and SHA256_PATTERN.fullmatch(row["sha256"]) is not None,
            f"multiarch boot matrix {arch} must record a 64-hex-character ISO sha256",
        )
        require(
            errors,
            isinstance(row.get("evidence"), str) and bool(row["evidence"]),
            f"multiarch boot matrix {arch} must record boot evidence",
        )
        require(errors, isinstance(row.get("os_commit"), str)
                and COMMIT_PATTERN.fullmatch(row["os_commit"]) is not None,
                f"multiarch boot matrix {arch} must record a clean 40-hex os_commit")
        require(errors, isinstance(row.get("source_commit"), str)
                and COMMIT_PATTERN.fullmatch(row["source_commit"]) is not None,
                f"multiarch boot matrix {arch} must record a clean 40-hex source_commit")
        require(errors, isinstance(row.get("runtime_version"), str)
                and VERSION_PATTERN.fullmatch(row["runtime_version"]) is not None,
                f"multiarch boot matrix {arch} must record a runtime_version")
        iso = row.get("iso")
        expected_iso_sha = row.get("sha256")
        evidence = row.get("evidence")
        if (
            isinstance(iso, str)
            and iso
            and isinstance(expected_iso_sha, str)
            and SHA256_PATTERN.fullmatch(expected_iso_sha) is not None
        ):
            iso_path = _repo_path(iso)
            require(
                errors,
                iso_path is not None and iso_path.is_file(),
                f"multiarch boot matrix {arch} ISO artifact missing or unsafe: {iso}",
            )
            if iso_path is not None and iso_path.is_file():
                actual_iso_sha = sha256_file(iso_path)
                require(
                    errors,
                    actual_iso_sha == expected_iso_sha,
                    f"multiarch boot matrix {arch} ISO sha256 mismatch: {actual_iso_sha}",
                )
        validate_runtime_evidence(errors, arch, row)
        proves = set(row.get("proves", [])) if isinstance(row.get("proves"), list) else set()
        for proof in required_proofs:
            require(
                errors,
                proof in proves,
                f"multiarch boot matrix {arch} missing runtime proof: {proof}",
            )
        blocking_gaps = matrix_blocking_gaps(row)
        require(
            errors,
            not blocking_gaps,
            f"multiarch boot matrix {arch} still records production-blocking gaps: {blocking_gaps}",
        )
    validate_runtime_artifacts(errors, matrix)


def validate_desktop_gui_contract(errors: list[str]) -> None:
    common_packages = package_lines(ROOT / "config/package-lists/elizaos-common.list.chroot")
    gui_package_file = ROOT / "config/profiles/gui/package-lists/elizaos-gui.list.chroot"
    require(errors, gui_package_file.is_file(), "missing GUI profile package list")
    gui_packages = package_lines(gui_package_file) if gui_package_file.is_file() else set()
    for package in GUI_RUNTIME_PACKAGE_REQUIREMENTS + DESKTOP_PACKAGE_REQUIREMENTS:
        require(
            errors,
            package in gui_packages,
            f"elizaos-gui.list.chroot missing GUI package {package}",
        )
    for package in GUI_RUNTIME_PACKAGE_REQUIREMENTS:
        require(
            errors,
            package not in common_packages,
            f"elizaos-common.list.chroot must not install GUI package {package} in the default headless build",
        )

    graphical_hook = read("config/hooks/normal/0025-enable-graphical-session.hook.chroot")
    require(
        errors,
        "GUI profile packages absent" in graphical_hook
        and "systemctl set-default multi-user.target" in graphical_hook,
        "graphical-session hook must keep non-GUI/default builds on multi-user.target",
    )
    require(
        errors,
        "systemctl set-default graphical.target" in graphical_hook,
        "graphical-session hook must make graphical.target the default boot target when GUI packages exist",
    )
    require(errors, "systemctl enable gdm3.service" in graphical_hook,
            "graphical-session hook must enable the GNOME display manager")
    gdm_config = read("config/includes.chroot/etc/gdm3/daemon.conf")
    for token in ("WaylandEnable=false", "AutomaticLoginEnable=true", "AutomaticLogin=user"):
        require(errors, token in gdm_config, f"gdm3 desktop config missing {token}")

    user_hook = read("config/hooks/normal/0020-enable-user-units.hook.chroot")
    require(errors, "systemctl --global enable elizaos-launcher.service" in user_hook,
            "desktop image must globally enable the elizaOS user service")
    launcher_unit = read("config/includes.chroot/etc/systemd/user/elizaos-launcher.service")
    require(errors, "ExecStart=/usr/local/lib/elizaos/start-launcher" in launcher_unit,
            "elizaOS desktop user service must start the packaged app")
    require(errors, not (ROOT / "config/includes.chroot/etc/systemd/user/elizaos-chat-overlay.service").exists(),
            "desktop image must not launch a duplicate chat-overlay app process")

    audio_hook = read("config/hooks/normal/0027-pipewire-session.hook.chroot")
    require(
        errors,
        "wireplumber.service" in audio_hook
        and "pipewire-pulse.service" in audio_hook
        and "pulseaudio.service" in audio_hook,
        "desktop audio hook must enable PipeWire/WirePlumber and disable legacy PulseAudio",
    )

    modules = read("config/includes.chroot/etc/modules-load.d/elizaos-virtio-gpu.conf")
    require(
        errors,
        "virtio_pci" in modules and "virtio_gpu" in modules,
        "virtio GPU modules must be loaded for graphical QEMU boot",
    )

def main() -> int:
    errors: list[str] = []
    auto_config = read("auto/config")
    makefile = read("Makefile")
    build_sh = read("build-live-iso.sh")
    dockerfile = read("Dockerfile")
    boot_qemu = read("../../scripts/linux/boot-qemu.sh")
    riscv_harness = read("../../scripts/linux/qemu_virt_boot_riscv64.sh")
    qemu_virt_smoke = read("../../scripts/linux/qemu_virt_smoke.py")
    readme = read("README.md")
    matrix_path = ROOT / "evidence/multiarch_boot_matrix.json"
    if matrix_path.is_file():
        try:
            multiarch_matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"invalid multiarch boot matrix: {exc}")
            multiarch_matrix = {}
    else:
        errors.append(
            "missing evidence/multiarch_boot_matrix.json; boot evidence must be "
            "captured from current artifacts before release"
        )
        multiarch_matrix = {}

    for arch in ARCH_PACKAGE_REQUIREMENTS:
        require(errors, f"{arch})" in auto_config, f"auto/config lacks {arch} case")
        require(errors, arch in makefile, f"Makefile lacks {arch} in supported arch path")

    require(
        errors,
        "SUPPORTED_ARCHES := amd64 arm64 riscv64" in makefile,
        "Makefile supported arch list is not the expected amd64 arm64 riscv64 matrix",
    )
    require(
        errors,
        'BOOTLOADERS="grub-efi"' in auto_config,
        "auto/config must keep UEFI GRUB enabled for non-amd64 architectures",
    )

    package_dir = ROOT / "config/package-lists"
    for arch, required_packages in ARCH_PACKAGE_REQUIREMENTS.items():
        package_file = package_dir / f"elizaos-{arch}.list.chroot"
        require(errors, package_file.is_file(), f"missing package list for {arch}")
        if not package_file.is_file():
            continue
        present = package_lines(package_file)
        for package in required_packages:
            require(
                errors,
                package in present,
                f"{package_file.relative_to(ROOT)} missing required package {package}",
            )
        for package in DESKTOP_PACKAGE_REQUIREMENTS:
            require(
                errors,
                package not in present,
                f"{package_file.relative_to(ROOT)} must not install GUI package {package}; use PROFILE=gui",
            )

    riscv_package_file = package_dir / "elizaos-riscv64.list.chroot"
    if riscv_package_file.is_file():
        riscv_packages = package_lines(riscv_package_file)
        require(
            errors,
            "grub-efi-riscv64" in riscv_packages
            and "grub-efi-riscv64-bin" in riscv_packages,
            "riscv64 package list must include Debian's active GRUB package and riscv64 EFI modules",
        )
        require(
            errors,
            "u-boot-menu" not in riscv_packages,
            "riscv64 package list must not pull u-boot-menu; the Debian live path is UEFI/GRUB",
        )

    for package in DOCKERFILE_REQUIREMENTS:
        require(errors, package in dockerfile, f"Dockerfile missing builder package {package}")

    require(
        errors,
        "grub-efi-riscv64-bin" in build_sh,
        "build-live-iso.sh must patch live-build's riscv64 GRUB EFI package check",
    )
    require(
        errors,
        "default|gui" in build_sh and "config/profiles/gui" in build_sh,
        "build-live-iso.sh must support the real GUI profile over the default headless config",
    )
    require(
        errors,
        'gen_efi_boot_img "riscv64-efi" "riscv64"' in build_sh,
        "build-live-iso.sh must patch live-build's riscv64 EFI image generation",
    )
    require(
        errors,
        "bootriscv64.efi" in readme,
        "README.md must document Debian's riscv64 removable-media UEFI path",
    )
    require(
        errors,
        "qemu_virt_wrapper_grubfix_20260521T130200Z.report.json" not in readme
        and "qemu_virt_boot_20260524T030430Z.transcript.log" not in readme,
        "README.md must not present dated boot transcripts as current release evidence",
    )
    for token in RISCV64_PORT_CONTRACT.values():
        require(
            errors,
            token in readme,
            f"README.md must document Debian riscv64 port contract token {token}",
        )
    riscv_contract = multiarch_matrix.get("debian_riscv64_port_contract", {})
    for key, expected in RISCV64_PORT_CONTRACT.items():
        require(
            errors,
            riscv_contract.get(key) == expected,
            f"multiarch boot matrix riscv64 contract {key} must be {expected}",
        )
    matrix_packages = set(riscv_contract.get("bootloader_packages", []))
    require(
        errors,
        {"grub-efi-riscv64", "grub-efi-riscv64-bin"} <= matrix_packages,
        "multiarch boot matrix must record Debian riscv64 GRUB package provenance",
    )
    matrix_refs = set(riscv_contract.get("upstream_references_checked", []))
    for reference in RISCV64_UPSTREAM_REFERENCES:
        require(
            errors,
            reference in matrix_refs,
            f"multiarch boot matrix missing upstream reference {reference}",
        )
    validate_runtime_matrix(errors, multiarch_matrix)
    require(
        errors,
        "RISCV_VIRT_CODE.fd" in boot_qemu and "RISCV_VIRT_VARS.fd" in boot_qemu,
        "boot-qemu.sh lacks riscv64 EDK2 firmware drives",
    )
    require(
        errors,
        "AAVMF_CODE.fd" in boot_qemu,
        "boot-qemu.sh lacks arm64 AAVMF firmware",
    )
    require(
        errors,
        "RISCV_VIRT_CODE.fd" in riscv_harness and "--u-boot is not supported" in riscv_harness,
        "riscv64 evidence harness must use EDK2 UEFI and reject the old U-Boot path",
    )
    require(
        errors,
        "bootriscv64.efi" in riscv_harness
        and "boot/grub/grub.cfg" in riscv_harness,
        "riscv64 evidence harness must inspect the ISO for Debian GRUB EFI boot artifacts",
    )
    require(
        errors,
        "REQUIRED_ISO_BOOT_ARTIFACTS" in qemu_virt_smoke
        and "iso_boot_artifacts" in qemu_virt_smoke,
        "qemu_virt_smoke.py must validate recorded riscv64 ISO boot artifacts",
    )
    validate_desktop_gui_contract(errors)

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("OK: multi-arch boot contract passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
