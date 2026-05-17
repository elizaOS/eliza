"""Runtime checks and delegation for the elizaOS App PyPI package."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from collections.abc import Sequence
from importlib import metadata

MIN_NODE_VERSION = (22, 0, 0)
DEFAULT_NPM_PACKAGE = "elizaos"


class ElizaOSAppError(RuntimeError):
    """Base error for elizaOS App launcher failures."""


class NodeNotFoundError(ElizaOSAppError):
    """Raised when Node.js cannot be found."""


class RuntimeInstallError(ElizaOSAppError):
    """Raised when the npm runtime cannot be launched."""


def _parse_version(value: str) -> tuple[int, int, int] | None:
    match = re.search(r"v?(\d+)\.(\d+)\.(\d+)", value.strip())
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def _find_node() -> str | None:
    return shutil.which("node")


def _get_node_version(node: str) -> tuple[int, int, int] | None:
    try:
        result = subprocess.run(
            [node, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return _parse_version(result.stdout.strip())


def _check_node(min_version: tuple[int, int, int] = MIN_NODE_VERSION) -> str:
    node = _find_node()
    if not node:
        raise NodeNotFoundError("Node.js 22 or newer is required on PATH")

    version = _get_node_version(node)
    if version is None:
        raise RuntimeInstallError("could not determine Node.js version")
    if version < min_version:
        required = ".".join(str(part) for part in min_version)
        found = ".".join(str(part) for part in version)
        raise RuntimeInstallError(
            f"Node.js {required} or newer is required; found {found}"
        )
    return node


def _pep440_to_npm_version(version: str) -> str:
    match = re.fullmatch(r"(\d+\.\d+\.\d+)b(\d+)", version)
    if match:
        return f"{match.group(1)}-beta.{match.group(2)}"
    return version


def get_version() -> str:
    try:
        return metadata.version("elizaos-app")
    except metadata.PackageNotFoundError:
        from . import __version__

        return __version__


def ensure_runtime() -> str:
    """Validate runtime prerequisites and return the Node.js executable path."""
    return _check_node()


def _npm_exec_command(argv: Sequence[str]) -> list[str]:
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeInstallError("npm is required to launch elizaOS App")

    package_name = os.environ.get("ELIZAOS_APP_NPM_PACKAGE", DEFAULT_NPM_PACKAGE)
    package_version = os.environ.get(
        "ELIZAOS_APP_NPM_VERSION",
        _pep440_to_npm_version(get_version()),
    )
    package_spec = (
        f"{package_name}@{package_version}" if package_version else package_name
    )
    return [
        npm,
        "exec",
        "--yes",
        "--package",
        package_spec,
        "--",
        "elizaos",
        *argv,
    ]


def run(argv: Sequence[str] | None = None) -> int:
    """Run the version-matched npm elizaOS command."""
    ensure_runtime()
    args = list(sys.argv[1:] if argv is None else argv)
    command = _npm_exec_command(args)
    try:
        return subprocess.call(command)
    except OSError as error:
        raise RuntimeInstallError(str(error)) from error
