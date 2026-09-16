"""Exercise packaged-tool selection and rejection before native build admission.

Package-manager output is deterministic fixture data; dependency parsing, path
selection, ELF checks and receipt provenance use the installer implementation.
Separate filesystem negatives exercise its real immutable-path boundary.
"""
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

source = pathlib.Path(__file__).with_name("install-native-stability.py")
spec = importlib.util.spec_from_file_location("installer", source)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class PackagedToolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.payload = "linux-tools-6.8.0-134"
        self.generic = self.payload + "-generic"
        self.path = "/usr/lib/" + self.payload + "/bpftool"
        self.binary = self.root / "bpftool"
        self.binary.write_bytes(b"\x7fELFfixture")
        self.rows = {
            "linux-tools-generic": self.row("linux-tools-generic", self.generic),
            self.generic: self.row(self.generic, self.payload),
            self.payload: self.row(self.payload, "libc6 (>= 2.38), linux-tools-common"),
        }
        self.paths = self.path + "\n"
        self.calls = []
        self.validated = []
        self.info = self.root / "info"
        self.info.mkdir()
        (self.info / (self.payload + ".list")).write_text(self.paths)
        self.addCleanup(patch.stopall)
        patch.object(installer, "run", self.query).start()
        patch.object(installer, "immutable_path", self.trusted_fixture).start()

    def row(self, name, dependency, version="6.8.0-134.134"):
        return f"install ok installed\t{name}\t{version}\tamd64\t{dependency}\n".encode()

    def query(self, args):
        self.calls.append(args)
        self.assertEqual(args[0], "/usr/bin/dpkg-query")
        self.assertEqual(args[1], "--admindir=/var/lib/dpkg")
        if "--show" in args:
            return self.rows[args[-1]]
        self.assertEqual(args[2], "--listfiles")
        self.assertEqual(args[-1], self.payload)
        return self.paths.encode()

    def trusted_fixture(self, path, directory=False):
        self.validated.append(str(path))
        if str(path) == "/var/lib/dpkg/info":
            return self.info
        if str(path) == self.path:
            return self.binary
        return pathlib.Path(path)

    def test_resolves_dependency_chain_without_running_wrapper_and_binds_provenance(self):
        executable, receipt = installer.packaged_bpftool()
        self.assertEqual(executable.read_bytes(), b"\x7fELFfixture")
        self.assertEqual(receipt["package"], self.payload)
        self.assertEqual(receipt["packageVersion"], "6.8.0-134.134")
        self.assertEqual([row["package"] for row in receipt["packageChain"]],
                         ["linux-tools-generic", self.generic, self.payload])
        self.assertIn("/var/lib/dpkg/status", self.validated)
        self.assertIn(str(self.info / (self.payload + ".list")), self.validated)

    def test_valid_kernel_elf_preserves_existing_selection_without_generic_package(self):
        kernel = self.root / "kernel" / installer.os.uname().release / "bpftool"
        kernel.parent.mkdir(parents=True)
        kernel.write_bytes(b"\x7fELFkernel")
        original_path = pathlib.Path
        def mapped_path(value):
            return self.root / "kernel" if value == "/usr/lib/linux-tools" else original_path(value)
        with patch.object(installer.pathlib, "Path", mapped_path):
            executable, provenance = installer.resolve_bpftool()
        self.assertEqual(executable.read_bytes(), b"\x7fELFkernel")
        self.assertEqual(provenance, {})
        self.assertEqual(self.calls, [])

    def test_missing_kernel_tool_and_kernel_wrapper_use_packaged_elf_without_execution(self):
        kernel = self.root / "kernel" / installer.os.uname().release / "bpftool"
        kernel.parent.mkdir(parents=True)
        original_path = pathlib.Path
        def mapped_path(value):
            return self.root / "kernel" if value == "/usr/lib/linux-tools" else original_path(value)
        for wrapper in [False, True]:
            with self.subTest(wrapper=wrapper):
                if wrapper:
                    kernel.write_text("#!/bin/sh\nexit 0\n")
                with patch.object(installer.pathlib, "Path", mapped_path):
                    executable, provenance = installer.resolve_bpftool()
                self.assertEqual(executable.read_bytes(), b"\x7fELFfixture")
                self.assertEqual(provenance["package"], self.payload)
                self.assertTrue(all(call[0] == "/usr/bin/dpkg-query" for call in self.calls))

    def test_rejects_ambiguous_alternative_missing_and_foreign_dependencies(self):
        for dependency in ["", self.generic + ", linux-tools-6.8.0-135-generic",
                           self.generic + " | linux-tools-6.8.0-135-generic",
                           "linux-tools-6.17.0-1022-azure", self.generic + " (>= 1)"]:
            with self.subTest(dependency=dependency):
                self.rows["linux-tools-generic"] = self.row("linux-tools-generic", dependency)
                with self.assertRaises(RuntimeError):
                    installer.packaged_bpftool()

    def test_rejects_wrong_package_status_architecture_and_multiple_rows(self):
        valid = self.rows[self.payload]
        for row in [valid.replace(b"install ok installed", b"deinstall ok config-files"),
                    valid.replace(b"amd64", b"arm64"), valid + valid,
                    self.row("linux-tools-6.8.0-135", ""),
                    self.row(self.payload, "", version="bad-version")]:
            with self.subTest(row=row):
                self.rows[self.payload] = row
                with self.assertRaises(RuntimeError):
                    installer.packaged_bpftool()

    def test_rejects_installed_version_inconsistent_with_exact_dependency(self):
        self.rows[self.generic] = self.row(self.generic, self.payload + " (= 6.8.0-134.135)")
        with self.assertRaisesRegex(RuntimeError, "version does not match"):
            installer.packaged_bpftool()

    def test_rejects_missing_duplicate_and_wrong_package_executable(self):
        for paths in ["", self.path + "\n" + self.path + "\n", "/usr/sbin/bpftool\n",
                      "/usr/lib/linux-tools-6.8.0-135/bpftool\n"]:
            with self.subTest(paths=paths):
                self.paths = paths
                with self.assertRaisesRegex(RuntimeError, "one expected"):
                    installer.packaged_bpftool()

    def test_rejects_wrapper_without_executing_it(self):
        self.binary.write_text("#!/bin/sh\nexit 0\n")
        with self.assertRaisesRegex(RuntimeError, "not an ELF"):
            installer.packaged_bpftool()
        self.assertTrue(all(call[0] == "/usr/bin/dpkg-query" for call in self.calls))

    def test_rejects_missing_or_ambiguous_installed_file_inventory(self):
        inventory = self.info / (self.payload + ".list")
        inventory.unlink()
        with self.assertRaisesRegex(RuntimeError, "file inventory"):
            installer.packaged_bpftool()
        inventory.write_text(self.paths)
        (self.info / (self.payload + ":amd64.list")).write_text(self.paths)
        with self.assertRaisesRegex(RuntimeError, "file inventory"):
            installer.packaged_bpftool()

    def test_metadata_trust_failure_prevents_package_queries(self):
        def reject_status(path, directory=False):
            if str(path) == "/var/lib/dpkg/status":
                raise RuntimeError("untrusted metadata")
            return self.trusted_fixture(path, directory)
        with patch.object(installer, "immutable_path", reject_status):
            with self.assertRaisesRegex(RuntimeError, "untrusted metadata"):
                installer.packaged_bpftool()
        self.assertEqual(self.calls, [])


class ImmutablePathTests(unittest.TestCase):
    def test_real_filesystem_rejects_writable_file_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory).resolve()
            target = root / "tool"
            target.write_bytes(b"\x7fELFfixture")
            target.chmod(0o666)
            with self.assertRaisesRegex(RuntimeError, "writable or not root owned"):
                installer.immutable_path(target)
            alias = root / "alias"
            alias.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "not canonical"):
                installer.immutable_path(alias)


if __name__ == "__main__":
    unittest.main()
