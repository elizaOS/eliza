import asyncio

import computeruse


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening VLC...")
    vlc = desktop.open_application("vlc")
    await asyncio.sleep(2)

    print("Opening Media menu via Alt+M, then Open File (O)...")
    vlc.press_key("{Alt}")
    await asyncio.sleep(0.2)
    vlc.press_key("m")
    await asyncio.sleep(0.2)
    vlc.press_key("o")
    await asyncio.sleep(1)

    print("If a file picker opened, the menu interaction worked.")


if __name__ == "__main__":
    asyncio.run(main())

