"""Exercises deterministic launcher failures without invoking external tools."""

from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from elizaos_app.loader import (
    RuntimeInstallError,
    _get_node_version,
    _npm_exec_command,
)


class NodeVersionProbeTest(unittest.TestCase):
    def test_timeout_is_a_typed_launcher_failure(self) -> None:
        timeout = subprocess.TimeoutExpired(["node", "--version"], timeout=10)
        with patch("elizaos_app.loader.subprocess.run", side_effect=timeout):
            with self.assertRaisesRegex(
                RuntimeInstallError,
                "timed out while determining Node.js version",
            ) as raised:
                _get_node_version("node")

        self.assertIs(raised.exception.__cause__, timeout)


class NpmCommandTest(unittest.TestCase):
    def test_constructs_exact_version_matched_official_package_command(self) -> None:
        fixtures = {
            "2.0.3": "elizaos@2.0.3",
            "2.0.3b7": "elizaos@2.0.3-beta.7",
            "2.0.3rc2": "elizaos@2.0.3-rc.2",
        }
        for pypi_version, package_spec in fixtures.items():
            with self.subTest(pypi_version=pypi_version):
                with (
                    patch("elizaos_app.loader.shutil.which", return_value="/bin/npm"),
                    patch("elizaos_app.loader.get_version", return_value=pypi_version),
                ):
                    self.assertEqual(
                        _npm_exec_command(["start", "--character", "agent.json"]),
                        [
                            "/bin/npm",
                            "exec",
                            "--yes",
                            "--package",
                            package_spec,
                            "--",
                            "elizaos",
                            "start",
                            "--character",
                            "agent.json",
                        ],
                    )

    def test_rejects_invalid_or_blank_distribution_versions(self) -> None:
        with patch("elizaos_app.loader.shutil.which", return_value="/bin/npm"):
            for version in ("", "latest", "2.0.3-dev.1"):
                with self.subTest(version=version):
                    with patch(
                        "elizaos_app.loader.get_version", return_value=version
                    ):
                        with self.assertRaisesRegex(
                            ValueError, "Unsupported elizaos-app version"
                        ):
                            _npm_exec_command([])


if __name__ == "__main__":
    unittest.main()
