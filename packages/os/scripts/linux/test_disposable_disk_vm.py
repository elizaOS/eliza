"""Qualification deadlines must fail explicitly and stop only the owned VM."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("disk_vm", Path(__file__).with_name("disposable-disk-vm.py"))
disk_vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk_vm)


class DeadlineTests(unittest.TestCase):
    def test_timeout_bounds(self):
        for value in ("1", "600", "3600", "86400"):
            self.assertEqual(disk_vm.positive_timeout(value), int(value))
        for value in ("0", "-1", "86401", "1.5", "invalid"):
            with self.assertRaises((ValueError, disk_vm.argparse.ArgumentTypeError)):
                disk_vm.positive_timeout(value)

    def test_timeout_records_failure_and_reaps_owned_child(self):
        class Child:
            killed = False
            waits = 0

            def wait(self, timeout=None):
                self.waits += 1
                if timeout is not None:
                    raise subprocess.TimeoutExpired("fixture-qemu", timeout)
                return -9

            def poll(self):
                return -9 if self.killed else None

            def kill(self):
                self.killed = True

        child = Child()
        with tempfile.TemporaryDirectory(prefix="disk-vm-timeout-") as temporary:
            root = Path(temporary)
            base, node, output = root / "base", root / "node", root / "run"
            base.write_bytes(b"fixture base")
            node.write_bytes(b"fixture node")
            args = disk_vm.argument_parser("fixture").parse_args([
                "--base-image", str(base), "--node", str(node), "--output-dir", str(output),
                "--timeout-seconds", "7",
            ])
            with patch.object(disk_vm.restore_vm, "file_hash", return_value=disk_vm.restore_vm.IMAGE_SHA512), \
                 patch.object(disk_vm.subprocess, "run"), \
                 patch.object(disk_vm.subprocess, "Popen", return_value=child):
                with self.assertRaisesRegex(RuntimeError, "timed out after 7s") as raised:
                    disk_vm.run(args, {}, "exit 0", ("result.json",), "TEST")
            self.assertIsInstance(raised.exception.__cause__, subprocess.TimeoutExpired)
            self.assertTrue(child.killed)
            self.assertEqual(child.waits, 2)
            receipt = json.loads((output / "evidence/host-timeout.json").read_text())
            self.assertFalse(receipt["success"])
            self.assertEqual(receipt["timeoutSeconds"], 7)
            self.assertEqual(json.loads((output / "inputs.json").read_text())["timeoutSeconds"], 7)
            self.assertFalse((output / "evidence/result.json").exists())


if __name__ == "__main__":
    unittest.main()
