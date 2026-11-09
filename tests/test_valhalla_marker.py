#!/usr/bin/env python3
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / "scripts/verify_valhalla_release.py"
spec = importlib.util.spec_from_file_location("marker", path)
marker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(marker)


class MarkerTests(unittest.TestCase):
    @staticmethod
    def fake_run(results):
        iterator = iter(results)

        def run(*args, **kwargs):
            result = next(iterator)
            if isinstance(result, Exception):
                raise result
            kwargs["stdout"].write(result)
        return run

    def test_failures_retry_and_exact_match_succeeds(self):
        responses = [
            subprocess.CalledProcessError(22, "curl"),
            b"not json\n200",
            b'{"sha":"old","request_id":"r"}\n200',
            b'{"sha":"s","request_id":"wrong"}\n200',
            b'{"sha":"s","sha":"s","request_id":"r"}\n200',
            b'{"sha":"s","request_id":"r"}\n200',
        ]
        with patch.object(marker.subprocess, "run", side_effect=self.fake_run(responses)) as run:
            self.assertTrue(marker.verify("s", "r", attempts=6, delay=0))
        urls = [call.args[0][-1] for call in run.call_args_list]
        self.assertEqual(len(set(urls)), 6)
        self.assertTrue(all(url.startswith(marker.MARKER + "?verify=") for url in urls))

    def test_missing_stale_and_network_errors_fail(self):
        for result in (b"{}", b'{"sha":"s","request_id":"stale"}',
                       b'{"sha":"s","request_id":"r"', b"x" * 65537):
            with self.subTest(result=result[:30]), patch.object(
                    marker.subprocess, "run",
                    side_effect=self.fake_run([result + b"\n200"] * 3)) as run:
                self.assertFalse(marker.verify("s", "r", attempts=3, delay=0))
                self.assertEqual(run.call_count, 3)
        with patch.object(marker.subprocess, "run", side_effect=OSError("network")) as run:
            self.assertFalse(marker.verify("s", "r", attempts=3, delay=0))
            self.assertEqual(run.call_count, 3)
        with patch.object(marker.subprocess, "run", side_effect=self.fake_run(
                [b'{"sha":"s","request_id":"r"}\n302'])):
            self.assertFalse(marker.verify("s", "r", attempts=1, delay=0))
        with patch.object(marker.subprocess, "run", side_effect=self.fake_run(
                [b'{"sha":"s","request_id":"r","other":NaN}\n200'])):
            self.assertFalse(marker.verify("s", "r", attempts=1, delay=0))
        with patch.object(marker.subprocess, "run", side_effect=self.fake_run(
                [b"[" * 2000 + b"]" * 2000 + b"\n200"] * 2)) as run:
            self.assertFalse(marker.verify("s", "r", attempts=2, delay=0))
            self.assertEqual(run.call_count, 2)

    def test_bounded_stale_marker_stress(self):
        response = b'{"sha":"s","request_id":"old"}\n200'
        with patch.object(marker.subprocess, "run", side_effect=self.fake_run([response] * 1000)) as run, \
                patch.object(marker.sys, "stderr"):
            self.assertFalse(marker.verify("s", "r", attempts=1000, delay=0))
            self.assertEqual(run.call_count, 1000)

    def test_subprocess_output_is_bounded(self):
        with tempfile.TemporaryDirectory() as temp:
            fake = Path(temp) / "curl"
            fake.write_text("#!/usr/bin/python3\nimport os\nos.write(1, b'x' * 1000000)\n")
            fake.chmod(0o755)
            with patch.dict(os.environ, {"PATH": temp}):
                self.assertFalse(marker.verify("s", "r", attempts=1, delay=0))


if __name__ == "__main__":
    unittest.main()
