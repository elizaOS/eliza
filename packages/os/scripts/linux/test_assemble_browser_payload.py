#!/usr/bin/env python3
"""Synthetic closure assembly tests, not browser release/runtime qualification."""
from __future__ import annotations

import gzip
import importlib.util
import io
import json
import os
import struct
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("assemble", Path(__file__).with_name("assemble-browser-payload.py"))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
PIN = M.STAGE.read_json(M.UPSTREAM)


def elf(machine=62):
    return b"\x7fELF\x02\x01\x01" + b"\0" * 11 + machine.to_bytes(2, "little")


class AssemblyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.build = self.root / "build"
        self.component = self.root / "component"
        self.overlay = self.root / "overlay"
        for directory in (self.build, self.component, self.overlay):
            directory.mkdir()
        self.write(self.build / "chrome", elf(), 0o755)
        for name in ("resources.pak", "icudtl.dat", "v8_context_snapshot.bin", "locales/en-US.pak", "locales/fr.pak", "vk_swiftshader_icd.json"):
            self.write(self.build / name, b"runtime data\n")
        self.write(self.build / "libEGL.so", elf())
        self.write(self.build / "args.gn", b'target_os="linux"\n')
        self.deps = self.root / "runtime.json"
        self.dependency_names = ["./chrome", "resources.pak", "resources.pak", "icudtl.dat", "v8_context_snapshot.bin", "locales/", "libEGL.so", "vk_swiftshader_icd.json"]
        self.save_deps()
        for name in M.STAGE.RESOURCES:
            self.write(self.component / name, (name + " fixture").encode())
        self.write(self.overlay / "eliza-component.patch", b"reviewed fixture patch\n")
        self.provenance = {"chromiumRevision": PIN["revision"], "platform": "linux", "extensionId": M.STAGE.EXTENSION_ID,
                           "unrestrictedAllowlistBypass": False, "patchSha256": M.STAGE.digest(self.overlay / "eliza-component.patch"),
                           "resources": {name: {"sha256": M.STAGE.digest(self.component / name), "bytes": (self.component / name).stat().st_size} for name in M.STAGE.RESOURCES},
                           "inputs": PIN["sha256"], "outputs": {"chrome/output.cc": "c" * 64}}
        self.save_overlay()
        self.pack_resources()
        self.archive = self.root / "node-v24.15.0-linux-x64.tar.xz"
        self.make_archive()
        self.pin = patch.dict(M.NODE_SHA256, {"x86_64": M.STAGE.digest(self.archive)})
        self.pin.start()
        self.addCleanup(self.pin.stop)
        self.output = self.root / "browser"

    def write(self, path, data, mode=0o644):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)

    def save_overlay(self):
        self.write(self.overlay / "eliza-component-overlay.json", json.dumps(self.provenance).encode())

    def save_deps(self):
        self.deps.write_text(json.dumps({"//chrome:chrome": {"runtime_deps": self.dependency_names}}))

    def pack_resources(self):
        values = [(i + 100, (self.component / name).read_bytes()) for i, name in enumerate(M.RESOURCE_IDS)]
        # Exercise gzip decompression as produced by GRIT as well as raw data.
        values[0] = (values[0][0], gzip.compress(values[0][1], mtime=0))
        header = "".join(f"#define IDR_ELIZA_BROWSER_{suffix} {100 + i}\n" for i, suffix in enumerate(M.RESOURCE_IDS.values()))
        self.write(self.build / M.GRIT_HEADER, header.encode())
        offset = 12 + (len(values) + 1) * 6
        table, chunks = b"", b""
        for key, value in values:
            table += struct.pack("<HI", key, offset)
            chunks += value
            offset += len(value)
        table += struct.pack("<HI", 0, offset)
        self.write(self.build / "resources.pak", struct.pack("<IBxxxHH", 5, 0, len(values), 0) + table + chunks)

    def make_archive(self, extra=None, machine=62):
        prefix = "node-v24.15.0-linux-x64/"
        with tarfile.open(self.archive, "w:xz") as tar:
            for name, data in (("bin/node", elf(machine)), ("LICENSE", b"fixture license")):
                entry = tarfile.TarInfo(prefix + name)
                entry.size = len(data)
                entry.mode = 0o755 if name == "bin/node" else 0o644
                tar.addfile(entry, io.BytesIO(data))
            if extra:
                tar.addfile(extra)

    def assemble(self):
        return M.assemble(build_root=self.build, runtime_deps=self.deps, gn_target="//chrome:chrome",
                          component=self.component, overlay=self.overlay, node_archive=self.archive,
                          native_host=M.NATIVE_HOST, source_commit="d" * 40, architecture="x86_64",
                          chromium_revision=PIN["revision"], chromium_version="156.0.8072.0", output=self.output)

    def test_complete_closure_matches_existing_stager_and_does_not_issue_trust_receipt(self):
        data = self.assemble()
        for name in ("chromium/locales/fr.pak", "chromium/v8_context_snapshot.bin", "chromium/libEGL.so", "chromium/vk_swiftshader_icd.json", "node/LICENSE"):
            self.assertIn(name, data["files"])
        self.assertEqual(set(data["files"]), M.STAGE.regular_tree(self.output) - {M.STAGE.MANIFEST})
        # Deliberately synthetic TEST receipt exercises compatibility only.
        receipt = self.root / "fixture-receipt.json"
        self.write(receipt, json.dumps({"schemaVersion": 1, "sourceCommit": "d" * 40, "architecture": "x86_64", "archiveSha256": "e" * 64}).encode(), 0o600)
        self.assertEqual(M.STAGE.validate(self.output, "x86_64", receipt), data)
        self.assertFalse((self.output / "verified-metadata.json").exists())
        self.assertNotIn("releaseQualified", data)

    def test_empty_gn_markers_preserve_hashes_and_executable_markers_fail(self):
        names = ["gen/devtools/bundle.stamp", "pyproto/package/__init__.py"]
        for name in names:
            self.write(self.build / name, b"")
        self.dependency_names.extend(names)
        self.save_deps()
        data = self.assemble()
        for name in names:
            self.assertEqual(data["files"]["chromium/" + name]["bytes"], 0)
            self.assertEqual(data["files"]["chromium/" + name]["sha256"], M.STAGE.digest(self.build / name))
        receipt = self.root / "fixture-receipt.json"
        self.write(receipt, json.dumps({"schemaVersion": 1, "sourceCommit": "d" * 40, "architecture": "x86_64", "archiveSha256": "e" * 64}).encode(), 0o600)
        M.STAGE.validate(self.output, "x86_64", receipt)
        marker = self.output / "chromium" / names[0]
        marker.chmod(0o755)
        data["files"]["chromium/" + names[0]]["mode"] = "0755"
        (self.output / M.STAGE.MANIFEST).write_text(json.dumps(data))
        with self.assertRaisesRegex(M.AssemblyError, "hash/size mismatch"):
            M.STAGE.validate(self.output, "x86_64", receipt)
        (self.build / names[0]).chmod(0o755)
        with self.assertRaisesRegex(M.AssemblyError, "empty input"):
            M.runtime_files(self.build, self.deps, "//chrome:chrome")

    def test_missing_declared_runtime_file_rejects_before_publishing(self):
        (self.build / "v8_context_snapshot.bin").unlink()
        with self.assertRaisesRegex(M.AssemblyError, "missing GN"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_directory_closure_preserves_all_locales_and_refuses_nested_links(self):
        (self.build / "locales/fr.pak").unlink()
        (self.build / "locales/fr.pak").symlink_to(self.build / "resources.pak")
        with self.assertRaises(M.AssemblyError):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_escaping_absolute_and_ambiguous_dependency_paths_fail(self):
        for value in ("../outside", "/absolute", "locales/../chrome", "locales//fr.pak"):
            with self.subTest(value=value):
                self.dependency_names = [value]
                self.save_deps()
                with self.assertRaisesRegex(M.AssemblyError, "unsafe GN"):
                    self.assemble()

    def test_hardlinks_setid_and_empty_runtime_files_fail(self):
        path = self.build / "resources.pak"
        outside = self.root / "copy"
        os.link(path, outside)
        with self.assertRaisesRegex(M.AssemblyError, "hardlinked"):
            self.assemble()
        outside.unlink()
        path.chmod(0o4644)
        with self.assertRaisesRegex(M.AssemblyError, "unsafe input mode"):
            self.assemble()
        path.chmod(0o644)
        path.write_bytes(b"")
        with self.assertRaisesRegex(M.AssemblyError, "empty input"):
            self.assemble()

    def test_wrong_elf_architecture_in_runtime_library_fails(self):
        (self.build / "libEGL.so").write_bytes(elf(183))
        with self.assertRaisesRegex(M.AssemblyError, "architecture mismatch"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_component_resource_patch_identity_and_platform_tampering_fail(self):
        for field, value in (("platform", "android"), ("chromiumRevision", "f" * 40), ("patchSha256", "0" * 64), ("unrestrictedAllowlistBypass", True)):
            with self.subTest(field=field):
                original = self.provenance[field]
                self.provenance[field] = value
                self.save_overlay()
                with self.assertRaises(M.AssemblyError):
                    self.assemble()
                self.provenance[field] = original
        self.save_overlay()
        (self.component / "commands.mjs").write_text("altered")
        with self.assertRaisesRegex(M.AssemblyError, "resource hash mismatch"):
            self.assemble()

    def test_embedded_pack_mismatch_or_missing_header_resource_is_not_hidden_by_loose_assets(self):
        path = self.build / "resources.pak"
        data = path.read_bytes()
        path.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
        with self.assertRaisesRegex(M.AssemblyError, "embedded component hash mismatch"):
            self.assemble()
        path.write_bytes(data)
        header = self.build / M.GRIT_HEADER
        header.write_text(header.read_text().replace("IDR_ELIZA_BROWSER_COMMANDS", "IDR_OTHER"))
        with self.assertRaisesRegex(M.AssemblyError, "missing/duplicate GRIT ID"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_arbitrary_self_consistent_overlay_inputs_are_not_reviewed(self):
        self.provenance["inputs"] = {"other.cc": "a" * 64}
        self.save_overlay()
        with self.assertRaisesRegex(M.AssemblyError, "reviewed upstream pin"):
            self.assemble()

    def test_grit_bad_offsets_missing_payload_id_and_unsupported_version_fail(self):
        path = self.build / "resources.pak"
        original = path.read_bytes()
        for offset, data in ((0, struct.pack("<I", 99)), (12, struct.pack("<H", 500)), (14, struct.pack("<I", 0xffffffff))):
            with self.subTest(offset=offset):
                changed = bytearray(original)
                changed[offset:offset + len(data)] = data
                path.write_bytes(changed)
                with self.assertRaises(M.AssemblyError):
                    self.assemble()
        self.assertFalse(self.output.exists())

    def test_node_pin_mismatch_rejects_and_cleans_temporary_output(self):
        M.NODE_SHA256["x86_64"] = "0" * 64
        with self.assertRaisesRegex(M.AssemblyError, "reviewed official pin"):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('.browser-assembly-*')), [])

    def test_node_archive_traversal_links_and_duplicates_rejected(self):
        for kind in ("escape", "hardlink", "symlink", "duplicate"):
            with self.subTest(kind=kind):
                member = tarfile.TarInfo("../escape" if kind == "escape" else "node-v24.15.0-linux-x64/bin/node" if kind == "duplicate" else "node-v24.15.0-linux-x64/bin/link")
                member.mode = 0o644
                if kind in {"hardlink", "symlink"}:
                    member.type = tarfile.LNKTYPE if kind == "hardlink" else tarfile.SYMTYPE
                    member.linkname = "../../../outside"
                self.make_archive(member)
                M.NODE_SHA256["x86_64"] = M.STAGE.digest(self.archive)
                with self.assertRaises(M.AssemblyError):
                    self.assemble()
                self.assertFalse(self.output.exists())

    def test_node_wrong_elf_architecture_fails(self):
        self.make_archive(machine=183)
        M.NODE_SHA256["x86_64"] = M.STAGE.digest(self.archive)
        with self.assertRaisesRegex(M.AssemblyError, "architecture mismatch"):
            self.assemble()

    def test_existing_output_and_linked_output_parent_are_not_overwritten(self):
        self.output.mkdir()
        self.write(self.output / "keep", b"unrelated")
        with self.assertRaisesRegex(M.AssemblyError, "new browser"):
            self.assemble()
        self.assertEqual((self.output / "keep").read_bytes(), b"unrelated")
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        self.output = alias / "new"
        with self.assertRaises(M.AssemblyError):
            self.assemble()
        self.assertFalse((self.root / "new").exists())

    def test_native_host_cannot_be_replaced_with_non_self_contained_script(self):
        fake = self.root / "native-host.mjs"
        fake.write_text('import "unpackaged-module";')
        with patch.object(M, "NATIVE_HOST", fake), self.assertRaisesRegex(M.AssemblyError, "self-contained"):
            # Input is original canonical source; expected source is deliberately
            # changed here solely to exercise the source identity comparison.
            M.assemble(build_root=self.build, runtime_deps=self.deps, gn_target="//chrome:chrome", component=self.component,
                       overlay=self.overlay, node_archive=self.archive, native_host=Path(__file__).resolve().parents[4] / "packages/browser-bridge-extension/scripts/native-host.mjs",
                       source_commit="d" * 40, architecture="x86_64", chromium_revision=PIN["revision"],
                       chromium_version="156.0.8072.0", output=self.output)

    def test_plain_gn_dependency_file_and_multiple_target_rejection(self):
        self.deps.write_text("\n".join(self.dependency_names) + "\n")
        self.assemble()
        self.deps.write_text(json.dumps({"//chrome:chrome": {"runtime_deps": self.dependency_names}, "//other:target": {"runtime_deps": []}}))
        with self.assertRaisesRegex(M.AssemblyError, "exactly the requested target"):
            M.runtime_files(self.build, self.deps, "//chrome:chrome")


if __name__ == "__main__":
    unittest.main()
