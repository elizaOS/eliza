#!/usr/bin/env python3
"""Stage browser integrity only, after the enclosing desktop archive is authenticated.

This is not a browser build/boot/native-control qualification receipt. The sole
signature trust root is verify-desktop-artifact.py, not this inner manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath

EXTENSION_ID = "pmldpcoefklbdbgmggcejkfoinmjfeio"
BITWARDEN_ID = "nngceckbapebfimnlniiiahkandclblb"
BITWARDEN_POLICY_PATH = "etc/chromium/policies/managed/elizaos-bitwarden.json"
BITWARDEN_POLICY = {"ExtensionSettings": {BITWARDEN_ID: {
    "installation_mode": "normal_installed",
    "update_url": "https://clients2.google.com/service/update2/crx",
}}}
NODE_VERSION = "24.15.0"
MACHINES = {"x86_64": 62, "arm64": 183, "riscv64": 243}
NODE_ARCHES = {"x86_64": "x64", "arm64": "arm64"}
RESOURCES = {"manifest.json", "background.mjs", "commands.mjs", "protocol.mjs", "runtime-config.mjs", "native-connection.mjs"}
MANIFEST = "browser-artifact-manifest.json"
OVERLAY = "provenance/eliza-component-overlay.json"
PATCH = "provenance/eliza-component.patch"
REQUIRED = {"node/bin/node", "native-host.mjs", "chromium/chrome", "chromium/resources.pak", "chromium/icudtl.dat", OVERLAY, PATCH} | {f"component/{name}" for name in RESOURCES}


def empty_runtime_marker(relative: str, mode: int) -> bool:
    """GN declares empty generation stamps and Python package markers as data."""
    return mode == 0o644 and (
        relative.startswith("chromium/gen/") and relative.endswith(".stamp")
        or relative.startswith("chromium/pyproto/") and relative.endswith("/__init__.py")
    )


class StagingError(ValueError):
    """The authenticated payload does not meet the browser staging contract."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise StagingError(message)


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path: Path) -> dict:
    require(path.is_file() and not path.is_symlink(), f"missing or linked JSON input: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise StagingError(f"invalid JSON input: {path}") from exc
    require(isinstance(value, dict), f"JSON input must be an object: {path}")
    return value


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def hex_digest(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def safe_relative(value: object) -> bool:
    return (isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9_.\-/]+", value))
            and not value.startswith("/") and all(part not in ("", ".", "..") for part in value.split("/"))
            and str(PurePosixPath(value)) == value)


def regular_tree(root: Path) -> set[str]:
    require(root.is_dir() and not root.is_symlink(), "browser payload is missing or linked")
    require(stat.S_IMODE(root.stat().st_mode) == 0o755, "browser payload directory mode must be 0755")
    files = set()
    for base, directories, names in os.walk(root, followlinks=False):
        for name in directories + names:
            path = Path(base) / name
            info = path.lstat()
            require(not stat.S_ISLNK(info.st_mode), f"browser symlink is forbidden: {path}")
            require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), f"browser special file is forbidden: {path}")
            require(not info.st_mode & 0o022, f"browser input is writable by another user: {path}")
            if stat.S_ISDIR(info.st_mode):
                require(stat.S_IMODE(info.st_mode) == 0o755, f"browser directory mode must be 0755: {path}")
            if stat.S_ISREG(info.st_mode):
                require(info.st_nlink == 1, f"browser hardlink is forbidden: {path}")
                files.add(path.relative_to(root).as_posix())
    return files


def elf_architecture(path: Path, architecture: str, required: bool = False) -> None:
    with path.open("rb") as stream:
        header = stream.read(20)
    if header[:4] != b"\x7fELF":
        require(not required, f"native browser input must be ELF: {path.name}")
        return
    require(len(header) >= 20 and header[4:6] == b"\x02\x01", "browser ELF must be 64-bit little-endian")
    require(int.from_bytes(header[18:20], "little") == MACHINES[architecture], f"browser ELF architecture mismatch: {path.name}")


def validate(payload: Path, architecture: str, verified_metadata: Path) -> dict:
    require(architecture in MACHINES, "unsupported browser architecture")
    files = regular_tree(payload)
    data = read_json(payload / MANIFEST)
    require(stat.S_IMODE((payload / MANIFEST).stat().st_mode) == 0o644, "browser manifest mode must be 0644")
    require(set(data) == {"schemaVersion", "architecture", "sourceCommit", "node", "chromium", "extensionId", "files"}, "browser manifest fields do not match schema v1")
    require(data["schemaVersion"] == 1 and data["architecture"] == architecture, "browser manifest architecture/schema mismatch")
    outer = read_json(verified_metadata)
    require(stat.S_IMODE(verified_metadata.stat().st_mode) == 0o600 and verified_metadata.stat().st_nlink == 1, "authenticated metadata must be a private regular file")
    require(outer.get("schemaVersion") == 1 and outer.get("architecture") == architecture and hex_digest(outer.get("archiveSha256")), "authenticated desktop metadata is invalid")
    require(isinstance(data["sourceCommit"], str) and re.fullmatch(r"[0-9a-f]{40}", data["sourceCommit"]) is not None and data["sourceCommit"] == outer.get("sourceCommit"), "browser source commit does not match authenticated desktop source")
    require(data["extensionId"] == EXTENSION_ID, "browser component identity mismatch")
    node = data["node"]
    require(isinstance(node, dict) and set(node) == {"version", "sourceArchive", "sourceArchiveSha256"}, "invalid Node provenance")
    require(architecture in NODE_ARCHES, "pinned official Node artifact is unavailable for this architecture")
    require(node["version"] == NODE_VERSION and node["sourceArchive"] == f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-{NODE_ARCHES[architecture]}.tar.xz" and hex_digest(node["sourceArchiveSha256"]), "Node version/source provenance mismatch")
    chromium = data["chromium"]
    require(isinstance(chromium, dict) and set(chromium) == {"revision", "version"} and isinstance(chromium["revision"], str) and re.fullmatch(r"[0-9a-f]{40}", chromium["revision"]) is not None and isinstance(chromium["version"], str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}", chromium["version"]) is not None, "invalid Chromium provenance")
    inventory = data["files"]
    require(isinstance(inventory, dict) and REQUIRED <= set(inventory) and set(inventory) == files - {MANIFEST}, "browser file inventory is incomplete or has unlisted files")
    for relative, entry in inventory.items():
        require(safe_relative(relative), "unsafe browser inventory path")
        require(isinstance(entry, dict) and set(entry) == {"sha256", "bytes", "mode"}, "invalid browser file record")
        path = payload / relative
        allowed_modes = ["0644", "0755"]
        require(entry["mode"] in allowed_modes and stat.S_IMODE(path.stat().st_mode) == int(entry["mode"], 8), f"browser file mode mismatch: {relative}")
        require(type(entry["bytes"]) is int and (entry["bytes"] > 0 or entry["bytes"] == 0 and empty_runtime_marker(relative, int(entry["mode"], 8))) and path.stat().st_size == entry["bytes"] and hex_digest(entry["sha256"]) and digest(path) == entry["sha256"], f"browser file hash/size mismatch: {relative}")
        elf_architecture(path, architecture, relative in {"node/bin/node", "chromium/chrome", "chromium/chrome-sandbox"})
    for entry in ("node/bin/node", "chromium/chrome"):
        require(inventory[entry]["mode"] == "0755", f"browser executable mode mismatch: {entry}")
    overlay = read_json(payload / OVERLAY)
    require(overlay.get("chromiumRevision") == chromium["revision"] and overlay.get("extensionId") == EXTENSION_ID and overlay.get("platform") == "linux" and overlay.get("unrestrictedAllowlistBypass") is False, "component provenance binding mismatch")
    require(overlay.get("patchSha256") == inventory[PATCH]["sha256"], "component patch hash mismatch")
    resources = overlay.get("resources")
    require(isinstance(resources, dict) and set(resources) == RESOURCES, "component resource inventory mismatch")
    for name, entry in resources.items():
        require(entry == {key: inventory[f"component/{name}"][key] for key in ("bytes", "sha256")}, f"component resource hash mismatch: {name}")
    for field in ("inputs", "outputs"):
        require(isinstance(overlay.get(field), dict) and len(overlay[field]) > 0 and all(safe_relative(name) and hex_digest(value) for name, value in overlay[field].items()), f"component {field} provenance missing")
    return data


def output_path(root: Path, relative: str) -> Path:
    path = root
    for part in relative.split("/"):
        path = path / part
        require(not path.is_symlink(), f"staging destination is linked: {path}")
        if path != root / relative:
            require(not path.exists() or path.is_dir(), f"staging parent is not a directory: {path}")
            if root == Path("/") and path.exists():
                require(path.stat().st_uid == 0 and stat.S_IMODE(path.stat().st_mode) == 0o755,
                        f"system staging ancestor must be root-owned mode 0755: {path}")
    return path


def validate_output_file(root: Path, relative: str, content: str) -> Path:
    path = output_path(root, relative)
    if path.exists():
        require(path.is_file() and path.read_text() == content, f"refusing to replace unrelated system file: {path}")
        require(path.stat().st_nlink == 1, f"staging destination must not be hardlinked: {path}")
        if root == Path("/"):
            require(path.stat().st_uid == 0 and not path.stat().st_mode & 0o022,
                    f"system staging destination ownership/mode is unsafe: {path}")
    return path


def install_file(root: Path, relative: str, content: str, mode: int) -> None:
    path = validate_output_file(root, relative, content)
    for directory in reversed(path.parents):
        if directory == root or root not in directory.parents:
            continue
        if not directory.exists():
            directory.mkdir(mode=0o755)
            directory.chmod(0o755)
    path.write_text(content, encoding="utf-8")
    path.chmod(mode)


def validate_extension_policy_collisions(root: Path) -> None:
    for level in ("managed", "recommended"):
        directory = output_path(root, f"etc/chromium/policies/{level}")
        if not directory.exists():
            continue
        require(directory.is_dir(), "Chromium policy path must be a directory")
        # Chromium enumerates every file, independent of its suffix. Its parser
        # also accepts comments; unsupported syntax here must fail closed.
        for path in directory.iterdir():
            require(not path.is_symlink(), f"Chromium policy input is linked: {path}")
            if path.is_dir():
                continue
            policy = read_json(path)
            if "ExtensionSettings" in policy:
                require(path == root / BITWARDEN_POLICY_PATH and policy == BITWARDEN_POLICY,
                        f"overlapping Chromium ExtensionSettings policy: {path}")


def stage(image_root: Path, architecture: str, build_mode: str, verified_metadata: Path | None) -> dict:
    require(build_mode in {"release", "development", "fixture"}, "invalid build mode")
    require(image_root.is_dir() and not image_root.is_symlink(), "invalid image root")
    payload = output_path(image_root, "opt/elizaos/browser")
    status = {"schemaVersion": 1, "releaseQualified": False, "runtimeQualification": "required", "architecture": architecture}
    if not payload.exists() and not payload.is_symlink():
        for relative in ("usr/libexec/elizaos-browser-native-host", "etc/chromium/native-messaging-hosts/ai.elizaos.browser.json", "usr/share/applications/elizaos-browser.desktop", BITWARDEN_POLICY_PATH):
            require(not output_path(image_root, relative).exists(), "partial browser registration without payload")
        require(build_mode != "release", "release browser payload is missing")
        status["status"] = "unavailable"
    else:
        require(verified_metadata is not None, "browser payload requires authenticated desktop metadata")
        data = validate(payload, architecture, verified_metadata)
        if image_root == Path("/"):
            require(os.geteuid() == 0, "system browser staging requires root")
            require(verified_metadata.stat().st_uid == 0, "authenticated metadata must be root-owned")
            for path in [payload, *payload.rglob("*")]:
                require(path.stat().st_uid == 0, f"system browser payload must be root-owned: {path}")
        files = {
            "usr/bin/chromium": ("#!/bin/sh\nexec /opt/elizaos/browser/chromium/chrome \"$@\"\n", 0o755),
            "usr/libexec/elizaos-browser-native-host": ("#!/bin/sh\nexec /opt/elizaos/browser/node/bin/node /opt/elizaos/browser/native-host.mjs \"$@\"\n", 0o755),
            "etc/chromium/native-messaging-hosts/ai.elizaos.browser.json": (json.dumps({"name": "ai.elizaos.browser", "description": "Eliza same-profile browser control", "path": "/usr/libexec/elizaos-browser-native-host", "type": "stdio", "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"]}, indent=2) + "\n", 0o644),
            "usr/share/applications/elizaos-browser.desktop": ("[Desktop Entry]\nType=Application\nName=Eliza Browser\nExec=/usr/bin/chromium %U\nTryExec=/usr/bin/chromium\nTerminal=false\nCategories=Network;WebBrowser;\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n", 0o644),
            BITWARDEN_POLICY_PATH: (json.dumps(BITWARDEN_POLICY, indent=2) + "\n", 0o644),
        }
        # Validate all collisions before writing any registration.
        validate_extension_policy_collisions(image_root)
        status.update(status="integrity-staged", sourceCommit=data["sourceCommit"], chromiumRevision=data["chromium"]["revision"], manifestSha256=digest(payload / MANIFEST))
        validate_output_file(image_root, "usr/share/elizaos/browser-staging-status.json", json.dumps(status, indent=2) + "\n")
        for relative, (content, _) in files.items():
            validate_output_file(image_root, relative, content)
        for relative, (content, mode) in files.items():
            install_file(image_root, relative, content, mode)
    install_file(image_root, "usr/share/elizaos/browser-staging-status.json", json.dumps(status, indent=2) + "\n", 0o644)
    return status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-root", type=Path, default=Path("/"))
    parser.add_argument("--architecture", required=True)
    parser.add_argument("--build-mode", required=True, choices=("release", "development", "fixture"))
    parser.add_argument("--verified-metadata", type=Path)
    args = parser.parse_args()
    try:
        result = stage(args.image_root, args.architecture, args.build_mode, args.verified_metadata)
    except (StagingError, OSError) as exc:
        print(f"[browser-artifact] staging failed: {exc}", file=sys.stderr)
        return 1
    print("[browser-artifact] " + json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
