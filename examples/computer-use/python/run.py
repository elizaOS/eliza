from __future__ import annotations

import asyncio
import os

from elizaos_plugin_computeruse import create_computeruse_plugin


async def main() -> None:
    os.environ.setdefault("COMPUTERUSE_ENABLED", "true")
    os.environ.setdefault("COMPUTERUSE_MODE", "auto")

    plugin = create_computeruse_plugin()
    await plugin.init()
    print(f"ComputerUse backend: {plugin.backend}")

    # Best-effort: list applications (local on Windows; otherwise via MCP if available)
    try:
        res = await plugin.handle_action("COMPUTERUSE_GET_APPLICATIONS", {})
        print("GET_APPLICATIONS:", res)
    except Exception as e:
        print("GET_APPLICATIONS failed:", e)

    # Optional: open calculator (Windows)
    try:
        res = await plugin.handle_action("COMPUTERUSE_OPEN_APPLICATION", {"name": "calc"})
        print("OPEN_APPLICATION:", res)
    except Exception as e:
        print("OPEN_APPLICATION failed:", e)

    await plugin.stop()


if __name__ == "__main__":
    asyncio.run(main())

