"""Small owned-filesystem tests only; no product/dependency imports or real dep walk.

Budget: at most 2,100 tiny files and <8 MiB in each fresh TemporaryDirectory;
old/new CLI children each have a 15-second bound. No network/install/provider.
"""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

P = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("owned_census", P / "inventory_dependencies.py")
census = importlib.util.module_from_spec(spec)
spec.loader.exec_module(census)
ROOTS = json.loads((P / "WORKSPACE-DEPENDENCY-ROOTS.json").read_text())


class CensusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="eliza-census-small-fixture-")
        self.base = pathlib.Path(self.temp.name)
        self.source = self.base / "source"
        self.source.mkdir()
        (self.source / "node_modules").mkdir()
        (self.source / "node_modules/a.txt").write_bytes(b"real owned bytes\n")

    def tearDown(self):
        self.temp.cleanup()

    def collect(self):
        scan = census.Census(self.source, ROOTS, time.monotonic())
        return list(scan.rows()), scan.metrics

    def cli(self, script, mode, output, allowed=0):
        output.mkdir(exist_ok=True)
        result = subprocess.run([sys.executable, "-I", "-B", str(script), mode,
                                 str(self.source), str(output), "source-commit", "source-tree", "lock-hash"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={"PATH": os.environ.get("PATH", ""), "HOME": str(self.base)},
                                timeout=15)
        if allowed == 0:
            self.assertEqual(result.returncode, 0, result.stderr.decode())
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def test_old_new_byte_equivalence_nested_files_links_empty_and_absent_roots(self):
        folder = self.source / "node_modules/deep/owned/files"
        folder.mkdir(parents=True)
        for index in range(128):
            (folder / (f"file-{index:04}.txt")).write_bytes((f"value-{index}\n").encode())
        os.link(folder / "file-0000.txt", folder / "hardlink.txt")
        (self.source / "inside").mkdir()
        (self.source / "inside/unicode-λ.txt").write_bytes(b"linked directory bytes")
        (self.source / "node_modules/file-link").symlink_to("deep/owned/files/file-0000.txt")
        (self.source / "node_modules/directory-link").symlink_to("../inside", target_is_directory=True)
        root_link = self.source / "packages/cloud/api/node_modules"
        root_link.parent.mkdir(parents=True)
        root_link.symlink_to("../../../inside", target_is_directory=True)
        (self.source / "packages/host/node_modules").mkdir(parents=True)
        old_home = self.base / "old-script"
        old_home.mkdir()
        shutil.copy2(P / "reference/inventory_dependencies.py", old_home / "inventory_dependencies.py")
        shutil.copy2(P / "WORKSPACE-DEPENDENCY-ROOTS.json", old_home / "WORKSPACE-DEPENDENCY-ROOTS.json")
        old, new = self.base / "old-result", self.base / "new-result"
        self.cli(old_home / "inventory_dependencies.py", "capture", old)
        self.cli(P / "inventory_dependencies.py", "capture", new)
        self.assertEqual((old / "dependency-files.jsonl").read_bytes(), (new / "dependency-files.jsonl").read_bytes())
        self.cli(P / "inventory_dependencies.py", "verify", new)
        self.cli(P / "inventory_dependencies.py", "verify", new)  # Actual operator verifies twice.
        receipt = json.loads((new / "DEPENDENCY-INVENTORY.json").read_text())
        self.assertEqual(receipt["rootStates"], 135)

    def test_internal_ancestor_symlink_keeps_legacy_root_semantics(self):
        (self.source / "actual/node_modules").mkdir(parents=True)
        (self.source / "actual/node_modules/b.txt").write_bytes(b"inside")
        (self.source / "packages").mkdir()
        (self.source / "packages/host").symlink_to("../actual", target_is_directory=True)
        rows, _ = self.collect()
        self.assertIn({"path": "packages/host/node_modules", "kind": "root", "state": "directory"}, rows)
        self.assertTrue(any(r["path"] == "packages/host/node_modules/b.txt" and r["kind"] == "file" for r in rows))

    def test_external_and_dangling_symlinks_fail_closed(self):
        outside = self.base / "outside.txt"
        outside.write_bytes(b"must not hash outside data")
        link = self.source / "node_modules/escape"
        for target in [outside, self.base / "missing"]:
            link.symlink_to(target)
            with self.assertRaises((AssertionError, FileNotFoundError)):
                self.collect()
            link.unlink()

    def test_external_root_symlink_fails_closed(self):
        outside = self.base / "outside-root"
        outside.mkdir()
        (outside / "secret").write_bytes(b"outside bytes")
        root = self.source / "packages/host/node_modules"
        root.parent.mkdir(parents=True)
        root.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(AssertionError):
            self.collect()

    def test_verify_detects_add_remove_content_and_root_changes(self):
        for change in ["add", "remove", "content", "root"]:
            with self.subTest(change=change):
                output = self.base / ("result-" + change)
                self.cli(P / "inventory_dependencies.py", "capture", output)
                file = self.source / "node_modules/a.txt"
                original = file.read_bytes()
                if change == "add":
                    (self.source / "node_modules/new").write_bytes(b"new")
                elif change == "remove":
                    file.unlink()
                elif change == "content":
                    file.write_bytes(b"same length diff\n")
                else:
                    (self.source / "packages/host/node_modules").mkdir(parents=True)
                self.cli(P / "inventory_dependencies.py", "verify", output, allowed=1)
                if change == "add":
                    (self.source / "node_modules/new").unlink()
                elif change == "root":
                    shutil.rmtree(self.source / "packages")
                else:
                    file.write_bytes(original)

    def test_hash_reuse_only_same_physical_identity_and_never_across_passes(self):
        original = self.source / "node_modules/a.txt"
        os.link(original, self.source / "node_modules/b-hardlink.txt")
        (self.source / "node_modules/c-separate.txt").write_bytes(original.read_bytes())
        first_rows, first = self.collect()
        second_rows, second = self.collect()
        self.assertEqual(first_rows, second_rows)
        self.assertEqual(first["hashReuses"], 1)
        self.assertEqual(first["physicalHashes"], 2)  # Equal content in a separate inode is hashed.
        self.assertEqual(second["physicalHashes"], 2)
        self.assertEqual(first["hashBytes"], 2 * len(original.read_bytes()))

    def test_replacement_between_stat_and_open_is_rejected(self):
        original_open = os.open
        victim = self.source / "node_modules/a.txt"
        changed = False
        def racing_open(path, flags, *args, **kwargs):
            nonlocal changed
            if path == "a.txt" and "dir_fd" in kwargs and not changed:
                changed = True
                victim.rename(victim.with_name("old-file"))
                victim.write_bytes(b"new owned content")
            return original_open(path, flags, *args, **kwargs)
        with mock.patch.object(census.os, "open", side_effect=racing_open):
            with self.assertRaisesRegex(AssertionError, "changed before open"):
                self.collect()

    def test_file_mutation_with_restored_mtime_is_rejected(self):
        victim = self.source / "node_modules/a.txt"
        original = victim.stat()
        original_read = os.read
        changed = False
        def racing_read(fd, length):
            nonlocal changed
            value = original_read(fd, length)
            if value and not changed:
                changed = True
                victim.write_bytes(b"changed content\n")
                os.utime(victim, ns=(original.st_atime_ns, original.st_mtime_ns))
            return value
        with mock.patch.object(census.os, "read", side_effect=racing_read):
            with self.assertRaisesRegex(AssertionError, "changed during hash"):
                self.collect()

    def test_directory_replacement_cannot_follow_outside_symlink(self):
        folder = self.source / "node_modules/child"
        folder.mkdir()
        (folder / "inside").write_bytes(b"inside")
        outside = self.base / "outside-dir"
        outside.mkdir()
        (outside / "secret").write_bytes(b"must not read")
        original_open = os.open
        changed = False
        def racing_open(path, flags, *args, **kwargs):
            nonlocal changed
            if path == "child" and "dir_fd" in kwargs and not changed:
                changed = True
                folder.rename(folder.with_name("held-child"))
                folder.symlink_to(outside, target_is_directory=True)
            return original_open(path, flags, *args, **kwargs)
        with mock.patch.object(census.os, "open", side_effect=racing_open):
            with self.assertRaises((AssertionError, OSError)):
                self.collect()

    def test_readlink_replacement_is_rejected(self):
        link = self.source / "node_modules/linked"
        link.symlink_to("a.txt")
        original_readlink = os.readlink
        def racing_readlink(path, *args, **kwargs):
            target = original_readlink(path, *args, **kwargs)
            if path == "linked" and "dir_fd" in kwargs:
                link.unlink()
                link.symlink_to(self.base / "outside-missing")
            return target
        with mock.patch.object(census.os, "readlink", side_effect=racing_readlink):
            with self.assertRaises((AssertionError, FileNotFoundError)):
                self.collect()

    def test_scandir_error_is_not_silently_skipped(self):
        with mock.patch.object(census.os, "scandir", side_effect=PermissionError("owned fixture error")):
            with self.assertRaises(PermissionError):
                self.collect()

    def test_missing_root_appearance_is_rejected(self):
        scan = census.Census(self.source, ROOTS, time.monotonic())
        rows = scan.rows()
        try:
            for row in rows:
                if row["kind"] == "root" and row["state"] == "absent":
                    (self.source / row["path"]).mkdir(parents=True)
                    with self.assertRaisesRegex(AssertionError, "appeared during scan"):
                        next(rows)
                    break
            else:
                self.fail("Expected an absent declared root")
        finally:
            rows.close()

    def test_fds_close_after_error_and_early_consumer_close(self):
        original_open, original_dup, original_close = os.open, os.dup, os.close
        active = set()
        def opened(*args, **kwargs):
            fd = original_open(*args, **kwargs)
            active.add(fd)
            return fd
        def duplicated(*args, **kwargs):
            fd = original_dup(*args, **kwargs)
            active.add(fd)
            return fd
        def closed(fd):
            active.discard(fd)
            return original_close(fd)
        with mock.patch.object(census.os, "open", side_effect=opened), mock.patch.object(census.os, "dup", side_effect=duplicated), mock.patch.object(census.os, "close", side_effect=closed):
            rows = census.Census(self.source, ROOTS, time.monotonic()).rows()
            next(rows)
            rows.close()
            self.assertEqual(active, set())
            with mock.patch.object(census.os, "fstat", side_effect=OSError("owned initial fstat error")):
                with self.assertRaises(OSError):
                    self.collect()
            self.assertEqual(active, set())
            with mock.patch.object(census.os, "read", side_effect=OSError("owned read error")):
                with self.assertRaises(OSError):
                    self.collect()
            self.assertEqual(active, set())

    def test_internal_deadline_and_receipt_byte_cap_fail_closed(self):
        scan = census.Census(self.source, ROOTS, time.monotonic() - 86)
        with self.assertRaisesRegex(AssertionError, "wall bound"):
            list(scan.rows())
        output = self.base / "bounded-output"
        output.mkdir()
        with mock.patch.object(census, "LIMIT_BYTES", 1), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(AssertionError, "byte bound"):
                census.main(["capture", str(self.source), str(output), "commit", "tree", "lock"])
        self.assertFalse((output / "DEPENDENCY-INVENTORY.json").exists())
        self.assertTrue(list(output.glob("CENSUS-capture-INCOMPLETE-*.json")))

    def test_regular_files_do_not_resolve_ancestors_individually(self):
        folder = self.source / "node_modules"
        for index in range(12):
            folder = folder / ("d" + str(index))
            folder.mkdir()
        for index in range(1024):
            (folder / (f"item-{index:04}.txt")).write_bytes(b"bounded fixture bytes")
        rows, metrics = self.collect()
        self.assertEqual(sum(r["kind"] == "file" for r in rows), 1025)
        self.assertEqual(metrics["strictResolves"], 2)  # One present root, before and after.
        self.assertEqual(metrics["regularFiles"], 1025)
        self.assertEqual(metrics["proofRows"], 0)  # Streaming writer counts only complete serialized proofs.


if __name__ == "__main__":
    unittest.main(verbosity=2)
