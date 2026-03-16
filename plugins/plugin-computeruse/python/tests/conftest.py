from __future__ import annotations

import sys
from pathlib import Path


def _ensure_local_plugin_importable() -> None:
    """
    Pytest may run via an entrypoint whose sys.path[0] is not the project cwd.
    Ensure this plugin's Python package (./elizaos_plugin_computeruse) is importable.
    """

    try:
        import elizaos_plugin_computeruse  # noqa: F401

        return
    except ModuleNotFoundError:
        pass

    plugin_python_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(plugin_python_root))


def _ensure_local_mcp_importable() -> None:
    """
    In this monorepo, plugin tests may run without installing peer plugin packages.
    Make the local `plugins/plugin-mcp/python` importable as `elizaos_plugin_mcp`.
    """

    try:
        import elizaos_plugin_mcp  # noqa: F401

        return
    except ModuleNotFoundError:
        pass

    repo_root = Path(__file__).resolve().parents[4]
    mcp_python = repo_root / "plugins" / "plugin-mcp" / "python"
    sys.path.insert(0, str(mcp_python))


_ensure_local_plugin_importable()
_ensure_local_mcp_importable()
