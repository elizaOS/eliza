from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from dotenv import load_dotenv

from elizaos_plugin_minecraft import create_minecraft_plugin


async def main() -> None:
    load_dotenv(Path(__file__).parent / ".env")
    load_dotenv(Path(__file__).parent.parent / ".env")

    plugin = create_minecraft_plugin()
    await plugin.init()

    # Connect (uses env defaults from the Mineflayer bridge server)
    await plugin.handle_action("MC_CONNECT", "{}")

    # Demonstrate all providers
    print("=== World State ===")
    world_state = await plugin.get_provider("MC_WORLD_STATE")
    print(json.dumps(world_state, indent=2, default=str))

    print("\n=== Vision ===")
    vision = await plugin.get_provider("MC_VISION")
    print(vision.get("text", ""))

    print("\n=== Scan (stone, logs) ===")
    scan_result = await plugin.handle_action("MC_SCAN", '{"blocks": ["stone", "oak_log"], "radius": 16}')
    print(json.dumps(scan_result, indent=2, default=str))

    # Waypoints demo
    print("\n=== Set Waypoint 'spawn' ===")
    wp_set = await plugin.handle_action("MC_WAYPOINT_SET", "spawn")
    print(wp_set)

    print("\n=== Waypoints Provider ===")
    waypoints = await plugin.get_provider("MC_WAYPOINTS")
    print(waypoints.get("text", ""))

    print("\n=== List Waypoints (action) ===")
    wp_list = await plugin.handle_action("MC_WAYPOINT_LIST", "")
    print(wp_list)

    # Minimal autonomous loop: keep walking forward, occasionally jump.
    i = 0
    try:
        while True:
            # Show vision context each iteration
            vision = await plugin.get_provider("MC_VISION")
            print(f"\n[{i}] {vision.get('text', '')}")
            await plugin.handle_action("MC_CONTROL", "forward true 750")
            if i % 4 == 0:
                await plugin.handle_action("MC_CONTROL", "jump true 250")
            i += 1
            await asyncio.sleep(1.0)
    finally:
        await plugin.stop()


if __name__ == "__main__":
    os.environ.setdefault("MC_SERVER_PORT", "3457")
    asyncio.run(main())

