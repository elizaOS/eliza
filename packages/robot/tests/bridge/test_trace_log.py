"""Trace logger tests."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from eliza_robot.bridge.trace_log import TraceLogger


class TraceLoggerTests(unittest.TestCase):
    def test_write_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "trace.jsonl"
            logger = TraceLogger(path=path)
            logger.write({"kind": "test", "value": 1})
            logger.write({"kind": "test", "value": 2})

            lines = path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 2)
            first = json.loads(lines[0])
            second = json.loads(lines[1])
            self.assertEqual(first["value"], 1)
            self.assertEqual(second["value"], 2)


if __name__ == "__main__":
    unittest.main()

