from __future__ import annotations

import asyncio
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

    # Minimal autonomous loop: keep walking forward, occasionally jump.
    i = 0
    try:
        while True:
            state = await plugin.get_provider("MC_WORLD_STATE")
            print(state)
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

