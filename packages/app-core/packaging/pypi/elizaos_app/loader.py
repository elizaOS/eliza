"""
Dynamic loader for the elizaOS App Node.js runtime.

Responsibilities:
  1. Detect a suitable Node.js installation (>= 22.12.0)
  2. Detect or install the elizaos-app npm package
  3. Delegate CLI invocations to the Node.js process
  4. Provide a Python API for programmatic use
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from typing import Optional, Sequence, Tuple

# ── Constants ────────────────────────────────────────────────────────────────

REQUIRED_NODE_VERSION: Tuple[int, int, int] = (22, 12, 0)
NPM_PACKAGE = "elizaos"
_VERSION_RE = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")


# ── Exceptions ───────────────────────────────────────────────────────────────


class ElizaOSAppError(Exception):
    """Base exception for elizaos-app loader errors."""


class NodeNotFoundError(ElizaOSAppError):
    """Raised when a suitable Node.js installation cannot be found."""


class RuntimeInstallError(ElizaOSAppError):
    """Raised when the elizaos-app npm package cannot be installed."""


# ── Node.js Detection ────────────────────────────────────────────────────────


def _parse_version(version_str: str) -> Optional[Tuple[int, int, int]]:
    """Parse a semver string like 'v22.12.0' into a (major, minor, patch) tuple."""
    match = _VERSION_RE.search(version_str)
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def _find_node() -> Optional[str]:
    """Find a node binary on PATH."""
    return shutil.which("node")


def _get_node_version(node_bin: str) -> Optional[Tuple[int, int, int]]:
    """Get the version of a Node.js binary."""
    try:
        result = subprocess.run(
            [node_bin, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return _parse_version(result.stdout.strip())
    except (subprocess.SubprocessError, OSError):
        pass
    return None


def _check_node() -> str:
    """
    Find and validate a Node.js installation.

    Returns the path to the node binary.
    Raises NodeNotFoundError if no suitable version is found.
    """
    node_bin = _find_node()
    if not node_bin:
        req = ".".join(str(v) for v in REQUIRED_NODE_VERSION)
        raise NodeNotFoundError(
            f"Node.js not found. elizaOS App requires Node.js >= {req}.\n"
            "Install it from https://nodejs.org or via your package manager:\n"
            "  macOS:   brew install node@22\n"
            "  Linux:   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -\n"
            "  Windows: winget install OpenJS.NodeJS.LTS"
        )

    version = _get_node_version(node_bin)
    if version is None:
        raise NodeNotFoundError(
            f"Could not determine version of Node.js at {node_bin}"
        )

    if version < REQUIRED_NODE_VERSION:
        current = ".".join(str(v) for v in version)
        req = ".".join(str(v) for v in REQUIRED_NODE_VERSION)
        raise NodeNotFoundError(
            f"Node.js {current} found, but >= {req} is required.\n"
            "Please upgrade Node.js: https://nodejs.org"
        )

    return node_bin


# ── npm / npx Detection ─────────────────────────────────────────────────────


def _find_npx() -> Optional[str]:
    """Find npx on PATH."""
    return shutil.which("npx")


def _find_npm() -> Optional[str]:
    """Find npm on PATH."""
    return shutil.which("npm")


def _is_elizaos_app_installed_globally() -> bool:
    """Check if elizaos-app is installed as a global npm package."""
    npm_bin = _find_npm()
    if not npm_bin:
        return False
    try:
        result = subprocess.run(
            [npm_bin, "list", "-g", NPM_PACKAGE, "--json"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            deps = data.get("dependencies", {})
            return NPM_PACKAGE in deps
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError):
        pass
    return False


def _find_elizaos_app_bin() -> Optional[str]:
    """Find the elizaos-app CLI binary on PATH (from a global npm install)."""
    return shutil.which("elizaos-app")


def _install_elizaos_app_global() -> None:
    """Install elizaos-app globally via npm."""
    npm_bin = _find_npm()
    if not npm_bin:
        raise RuntimeInstallError(
            "npm not found. Cannot install elizaos-app runtime.\n"
            "Install Node.js (which includes npm) from https://nodejs.org"
        )

    print(
        "elizaos-app: installing elizaos-app runtime (npm install -g elizaos)...",
        file=sys.stderr,
    )
    try:
        result = subprocess.run(
            [npm_bin, "install", "-g", NPM_PACKAGE],
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeInstallError(
                f"Failed to install {NPM_PACKAGE} via npm (exit code {result.returncode}).\n"
                "Try running manually: npm install -g elizaos"
            )
        print("elizaos-app: elizaos-app runtime installed successfully.", file=sys.stderr)
    except subprocess.TimeoutExpired:
        raise RuntimeInstallError(
            f"Timed out installing {NPM_PACKAGE}. Check your network connection."
        )


# ── Public API ───────────────────────────────────────────────────────────────


def ensure_runtime() -> str:
    """
    Ensure the elizaOS App Node.js runtime is available.

    Checks for Node.js, then checks for the elizaos-app npm package.
    Installs elizaos-app globally if not found.

    Returns:
        Path to the elizaos-app CLI binary or npx fallback.

    Raises:
        NodeNotFoundError: If Node.js is not installed or too old.
        RuntimeInstallError: If elizaos-app cannot be installed.
    """
    _check_node()

    elizaos_app_bin = _find_elizaos_app_bin()
    if elizaos_app_bin:
        return elizaos_app_bin

    # Not found on PATH — try installing globally
    _install_elizaos_app_global()

    elizaos_app_bin = _find_elizaos_app_bin()
    if not elizaos_app_bin:
        # Fall back to npx
        npx_bin = _find_npx()
        if npx_bin:
            return npx_bin
        raise RuntimeInstallError(
            "elizaos-app was installed but the binary was not found on PATH.\n"
            "Try: export PATH=\"$(npm config get prefix)/bin:$PATH\""
        )

    return elizaos_app_bin


def run(args: Optional[Sequence[str]] = None) -> int:
    """
    Run an elizaos-app CLI command.

    Args:
        args: CLI arguments to pass to elizaos-app (e.g. ["start", "--verbose"]).
              If None, defaults to empty list.

    Returns:
        The exit code from the elizaos-app process.

    Raises:
        ElizaOSAppError: If the runtime cannot be found or started.
    """
    if args is None:
        args = []

    bin_path = ensure_runtime()

    # If we got npx back (fallback), run via npx
    if os.path.basename(bin_path) == "npx":
        cmd = [bin_path, NPM_PACKAGE, *list(args)]
    else:
        cmd = [bin_path, *list(args)]

    try:
        result = subprocess.run(cmd)
        return result.returncode
    except FileNotFoundError:
        raise ElizaOSAppError(f"Could not execute: {bin_path}")
    except OSError as exc:
        raise ElizaOSAppError(f"Failed to run elizaos-app: {exc}")


def get_version() -> Optional[str]:
    """
    Get the installed elizaos-app version.

    Returns:
        Version string (e.g. "2.0.0-alpha.7") or None if not installed.
    """
    elizaos_app_bin = _find_elizaos_app_bin()
    if not elizaos_app_bin:
        return None

    try:
        result = subprocess.run(
            [elizaos_app_bin, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip().split("\n")[-1]
    except (subprocess.SubprocessError, OSError):
        pass
    return None
