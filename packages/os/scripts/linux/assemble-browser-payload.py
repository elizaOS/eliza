#!/usr/bin/env python3
"""Assemble unsigned stage/browser bytes before the existing desktop archive signer.

No downloads, executable invocation, system installation or qualification receipts.
GN dependencies must be build-relative; an escaping dependency fails rather than
being silently omitted or relocated. Inputs must remain quiescent while copying.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import importlib.util
import json
import os
import posixpath
import re
import shutil
import stat
import struct
import sys
import tarfile
import tempfile
import zlib
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("browser_stage", Path(__file__).with_name("stage-browser-artifact.py"))
STAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STAGE)
require = STAGE.require
AssemblyError = STAGE.StagingError
NODE_SHA256 = {
    "x86_64": "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6",
    "arm64": "f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0",
}
# Reviewed https://nodejs.org/dist/v24.15.0/SHASUMS256.txt, SHA256
# 1e812945dee26c3e4ca41a8c0b582668ff2401ba0ae727a122300c0e8514edb0.
BRIDGE_SCRIPTS = Path(__file__).resolve().parents[4] / "packages/browser-bridge-extension/scripts"
NATIVE_HOST = BRIDGE_SCRIPTS / "native-host.mjs"
UPSTREAM = BRIDGE_SCRIPTS / "chromium/upstream.json"
GRIT_HEADER = "gen/chrome/grit/component_extension_resources.h"
RESOURCE_IDS = {"background.mjs": "BACKGROUND", "commands.mjs": "COMMANDS", "manifest.json": "MANIFEST",
                "native-connection.mjs": "CONNECTION", "protocol.mjs": "PROTOCOL", "runtime-config.mjs": "NATIVE_CONFIG"}


def checked(path: Path, directory: bool = False, allow_empty: bool = False) -> Path:
    """Reject links in every ancestor, not just the final path component."""
    path = Path(os.path.abspath(path))
    for parent in reversed(path.parents):
        require(not parent.is_symlink(), f"linked input ancestor: {parent}")
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), f"input must be a regular {'directory' if directory else 'file'}: {path}")
    require(not info.st_mode & 0o7022, f"unsafe input mode: {path}")
    if not directory:
        require(info.st_nlink == 1, f"hardlinked input: {path}")
        require(info.st_size > 0 or allow_empty and not info.st_mode & 0o111, f"empty input: {path}")
    return path


def copy_file(source: Path, destination: Path, architecture: str, allow_empty: bool = False) -> None:
    source = checked(source, allow_empty=allow_empty)
    before = source.stat()
    STAGE.elf_architecture(source, architecture)
    require(not destination.exists(), f"duplicate payload destination: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    after = source.stat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), f"input changed while copying: {source}")
    require(STAGE.digest(source) == STAGE.digest(destination), f"input bytes changed while copying: {source}")
    destination.chmod(0o755 if before.st_mode & 0o111 else 0o644)


def runtime_files(build_root: Path, deps: Path, target: str) -> list[Path]:
    """Accept GN desc JSON (one target), or GN's newline .runtime_deps output."""
    text = checked(deps).read_text(encoding="utf-8")
    if text.lstrip().startswith(("{", "[")):
        value = json.loads(text, object_pairs_hook=STAGE.unique_object)
        if isinstance(value, dict):
            require(set(value) == {target}, "runtime dependency JSON must describe exactly the requested target")
            value = value[target]
            require(isinstance(value, dict) and set(value) == {"runtime_deps"}, "expected GN runtime_deps description")
            value = value["runtime_deps"]
        require(isinstance(value, list), "runtime dependencies must be an array")
    else:
        value = text.splitlines()
    require(value and all(isinstance(entry, str) for entry in value), "empty or invalid runtime dependency closure")
    def checked_runtime(path: Path) -> Path:
        relative = "chromium/" + path.relative_to(build_root).as_posix()
        return checked(path, allow_empty=STAGE.empty_runtime_marker(relative, stat.S_IMODE(path.stat().st_mode)))

    result: set[Path] = set()
    for entry in value:
        # GN emits ./ for build-relative paths and / for declared directories.
        relative = entry.removeprefix("./").removesuffix("/")
        require(STAGE.safe_relative(relative), f"escaping or unsafe GN runtime dependency: {entry}")
        path = build_root / relative
        require(path.exists() or path.is_symlink(), f"missing GN runtime dependency: {entry}")
        if path.is_dir():
            checked(path, directory=True)
            for base, directories, names in os.walk(path, followlinks=False):
                for name in directories:
                    checked(Path(base) / name, directory=True)
                for name in names:
                    result.add(checked_runtime(Path(base) / name))
        else:
            result.add(checked_runtime(path))
    require(result, "runtime closure contains no files")
    return sorted(result)


def check_embedded_resources(pack_path: Path, header_path: Path, expected: dict) -> None:
    """Read GRIT v4/v5 indexes and aliases; bind actual packed bytes, not loose assets."""
    data = checked(pack_path).read_bytes()
    require(len(data) >= 12, "truncated GRIT pack")
    version, = struct.unpack_from("<I", data)
    if version == 5:
        encoding, count, aliases = struct.unpack_from("<BxxxHH", data, 4)
        start = 12
    elif version == 4:
        count, encoding = struct.unpack_from("<IB", data, 4)
        aliases, start = 0, 9
    else:
        raise AssemblyError(f"unsupported GRIT pack version: {version}")
    require(encoding in (0, 1, 2), "invalid GRIT encoding")
    end_table = start + (count + 1) * 6 + aliases * 4
    require(end_table <= len(data), "truncated GRIT index")
    entries = [struct.unpack_from("<HI", data, start + i * 6) for i in range(count + 1)]
    resources = {}
    for i in range(count):
        resource_id, offset = entries[i]
        end = entries[i + 1][1]
        require(end_table <= offset <= end <= len(data) and resource_id not in resources, "invalid GRIT resource offsets/IDs")
        resources[resource_id] = data[offset:end]
    for i in range(aliases):
        resource_id, index = struct.unpack_from("<HH", data, start + (count + 1) * 6 + i * 4)
        require(index < count and resource_id not in resources, "invalid GRIT alias")
        resources[resource_id] = resources[entries[index][0]]
    header = checked(header_path).read_text(encoding="utf-8")
    ids = set()
    for name, suffix in RESOURCE_IDS.items():
        matches = re.findall(r"^#define IDR_ELIZA_BROWSER_" + suffix + r"[ \t]+([0-9]+)$", header, re.M)
        require(len(matches) == 1, f"missing/duplicate GRIT ID: {name}")
        resource_id = int(matches[0])
        require(resource_id not in ids and resource_id in resources, f"missing/duplicate packed component resource: {name}")
        ids.add(resource_id)
        raw = resources[resource_id]
        if raw.startswith(b"\x1f\x8b"):
            try:
                with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
                    decoded = compressed.read(expected[name]["bytes"] + 1)
            except (OSError, EOFError, zlib.error) as exc:
                raise AssemblyError(f"invalid compressed component resource: {name}") from exc
        else:
            decoded = raw
        require(len(decoded) == expected[name]["bytes"] and hashlib.sha256(decoded).hexdigest() == expected[name]["sha256"], f"embedded component hash mismatch: {name}")


def extract_node(archive: Path, payload: Path, architecture: str) -> str:
    archive = checked(archive)
    require(architecture in NODE_SHA256, "no pinned official Node archive for architecture")
    prefix = f"node-v{STAGE.NODE_VERSION}-linux-{STAGE.NODE_ARCHES[architecture]}"
    require(archive.name == prefix + ".tar.xz", "Node archive filename does not match pinned platform/version")
    digest = STAGE.digest(archive)
    require(digest == NODE_SHA256[architecture], "Node archive SHA256 differs from reviewed official pin")
    with tarfile.open(archive, mode="r:xz") as tar:
        members = {}
        for member in tar.getmembers():
            name = member.name.removesuffix("/")
            require(bool(re.fullmatch(r"[A-Za-z0-9_.@+~\-/]+", name)) and all(part not in ("", ".", "..") for part in name.split("/")) and (name == prefix or name.startswith(prefix + "/")), "unsafe Node archive member")
            require(name not in members, "duplicate Node archive member")
            require(member.isfile() or member.isdir() or member.issym(), "Node archive hardlink/special member forbidden")
            require(member.issym() or not member.mode & 0o7022, "unsafe Node archive mode")
            if member.issym():
                require(bool(re.fullmatch(r"[A-Za-z0-9_.\-/]+", member.linkname)) and not member.linkname.startswith("/"), "unsafe Node archive link")
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
                require(resolved.startswith(prefix + "/"), "escaping Node archive link")
            members[name] = member
        # Node's official npm/npx links are not packaged. Only these regular
        # reviewed archive members are read; tar.extract/extractall is never used.
        for relative in ("bin/node", "LICENSE"):
            member = members.get(prefix + "/" + relative)
            require(member is not None and member.isfile() and member.size > 0, f"missing regular Node archive member: {relative}")
            destination = payload / "node" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, destination.open("xb") as output:
                shutil.copyfileobj(source, output)
            destination.chmod(0o755 if relative == "bin/node" else 0o644)
    require(STAGE.digest(archive) == digest, "Node archive changed during extraction")
    STAGE.elf_architecture(payload / "node/bin/node", architecture, required=True)
    return digest


def assemble(*, build_root: Path, runtime_deps: Path, gn_target: str, component: Path,
             overlay: Path, node_archive: Path, native_host: Path, source_commit: str,
             architecture: str, chromium_revision: str, chromium_version: str,
             output: Path) -> dict:
    require(architecture in NODE_SHA256, "unsupported assembler architecture")
    require(re.fullmatch(r"[0-9a-f]{40}", source_commit) is not None, "invalid desktop source commit")
    require(re.fullmatch(r"[0-9a-f]{40}", chromium_revision) is not None, "invalid Chromium revision")
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}", chromium_version) is not None, "invalid Chromium version")
    build_root, component, overlay = [checked(p, directory=True) for p in (build_root, component, overlay)]
    dependencies = runtime_files(build_root, runtime_deps, gn_target)
    require({"chrome", "resources.pak", "icudtl.dat"} <= {p.relative_to(build_root).as_posix() for p in dependencies}, "GN closure omits required Chromium executable/resources")
    require(STAGE.digest(checked(native_host)) == STAGE.digest(checked(NATIVE_HOST)), "native host must match the repository self-contained implementation")
    upstream = STAGE.read_json(checked(UPSTREAM))
    require(chromium_revision == upstream["revision"], "Chromium revision differs from reviewed upstream pin")
    provenance = STAGE.read_json(checked(overlay / "eliza-component-overlay.json"))
    require(provenance.get("chromiumRevision") == chromium_revision and provenance.get("platform") == "linux" and
            provenance.get("extensionId") == STAGE.EXTENSION_ID and provenance.get("unrestrictedAllowlistBypass") is False, "component provenance identity/platform/revision mismatch")
    require(provenance.get("inputs") == upstream["sha256"], "component input hashes differ from reviewed upstream pin")
    require(provenance.get("patchSha256") == STAGE.digest(checked(overlay / "eliza-component.patch")), "component patch hash mismatch")
    require(isinstance(provenance.get("resources"), dict) and set(provenance["resources"]) == STAGE.RESOURCES, "component resources incomplete")
    for field in ("inputs", "outputs"):
        require(isinstance(provenance.get(field), dict) and provenance[field] and all(STAGE.safe_relative(k) and STAGE.hex_digest(v) for k, v in provenance[field].items()), f"component {field} provenance missing")
    for name, record in provenance["resources"].items():
        path = checked(component / name)
        require(record == {"sha256": STAGE.digest(path), "bytes": path.stat().st_size}, f"component resource hash mismatch: {name}")
    check_embedded_resources(build_root / "resources.pak", build_root / GRIT_HEADER, provenance["resources"])
    output = Path(os.path.abspath(output))
    checked(output.parent, directory=True)
    require(not output.exists() and not output.is_symlink(), "output must be a new browser directory")
    require(not output.is_relative_to(build_root), "output cannot be inside Chromium build root")
    temporary = Path(tempfile.mkdtemp(prefix=".browser-assembly-", dir=output.parent))
    try:
        for source in dependencies:
            copy_file(source, temporary / "chromium" / source.relative_to(build_root), architecture, allow_empty=STAGE.empty_runtime_marker("chromium/" + source.relative_to(build_root).as_posix(), stat.S_IMODE(source.stat().st_mode)))
        for name in STAGE.RESOURCES:
            copy_file(component / name, temporary / "component" / name, architecture)
        for name in ("eliza-component-overlay.json", "eliza-component.patch"):
            copy_file(overlay / name, temporary / "provenance" / name, architecture)
        deps_name = "linux-runtime-deps.json" if runtime_deps.read_text(encoding="utf-8").lstrip().startswith(("{", "[")) else "chrome.runtime_deps"
        copy_file(runtime_deps, temporary / "provenance" / deps_name, architecture)
        copy_file(build_root / GRIT_HEADER, temporary / "provenance/component_extension_resources.h", architecture)
        copy_file(build_root / "args.gn", temporary / "provenance/args.gn", architecture)
        copy_file(native_host, temporary / "native-host.mjs", architecture)
        node_digest = extract_node(node_archive, temporary, architecture)
        for path in [temporary, *(p for p in temporary.rglob("*") if p.is_dir())]:
            path.chmod(0o755)
        files = STAGE.regular_tree(temporary)
        require(STAGE.REQUIRED <= files, "assembled payload missing required files")
        inventory = {}
        for name in sorted(files):
            path = temporary / name
            STAGE.elf_architecture(path, architecture, name in {"chromium/chrome", "chromium/chrome-sandbox", "node/bin/node"})
            inventory[name] = {"sha256": STAGE.digest(path), "bytes": path.stat().st_size, "mode": f"{stat.S_IMODE(path.stat().st_mode):04o}"}
        check_embedded_resources(temporary / "chromium/resources.pak", temporary / "provenance/component_extension_resources.h", provenance["resources"])
        copied_overlay = STAGE.read_json(temporary / STAGE.OVERLAY)
        require(copied_overlay == provenance, "component overlay changed during assembly")
        require(inventory[STAGE.PATCH]["sha256"] == provenance["patchSha256"], "copied component patch hash mismatch")
        for name, record in provenance["resources"].items():
            require(record == {key: inventory[f"component/{name}"][key] for key in ("sha256", "bytes")}, f"copied component resource mismatch: {name}")
        require(inventory["native-host.mjs"]["sha256"] == STAGE.digest(NATIVE_HOST), "copied native host mismatch")
        for name in ("chromium/chrome", "node/bin/node"):
            require(inventory[name]["mode"] == "0755", f"non-executable browser binary: {name}")
        manifest = {"schemaVersion": 1, "architecture": architecture, "sourceCommit": source_commit,
                    "node": {"version": STAGE.NODE_VERSION, "sourceArchive": f"https://nodejs.org/dist/v{STAGE.NODE_VERSION}/{node_archive.name}", "sourceArchiveSha256": node_digest},
                    "chromium": {"revision": chromium_revision, "version": chromium_version},
                    "extensionId": STAGE.EXTENSION_ID, "files": inventory}
        path = temporary / STAGE.MANIFEST
        path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        path.chmod(0o644)
        # Exclusive mkdir reserves publication; never replace another payload.
        output.mkdir(mode=0o755)
        for path in sorted(temporary.iterdir(), key=lambda p: p.name == STAGE.MANIFEST):
            path.rename(output / path.name)
        return manifest
    finally:
        shutil.rmtree(temporary)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("build-root", "runtime-deps", "component", "overlay", "node-archive", "native-host", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("source-commit", "architecture", "chromium-revision", "chromium-version"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--gn-target", default="//chrome:chrome")
    try:
        manifest = assemble(**vars(parser.parse_args()))
    except (AssemblyError, OSError, ValueError, tarfile.TarError) as exc:
        print(f"[browser-assembly] failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"status": "assembled-unsigned", "files": len(manifest["files"]), "releaseQualified": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
