import asyncio
import argparse

import computeruse


async def main() -> None:
    parser = argparse.ArgumentParser(description="Automate VLC to play a network stream.")
    parser.add_argument(
        "--url",
        required=True,
        help="Network/YouTube URL to play (e.g. https://www.youtube.com/watch?v=...)",
    )
    args = parser.parse_args()

    desktop = computeruse.Desktop(log_level="error")

    print("Opening VLC...")
    vlc = desktop.open_application("VLC")
    await asyncio.sleep(2)

    # VLC: File -> Open Network... is commonly Cmd+N on macOS VLC
    vlc.press_key("{Command}n")
    await asyncio.sleep(1.5)

    print("If the Open Network dialog opened, paste URL and start playback.")
    # Dialog automation is highly version-specific; treat as a starting point.
    print("URL:", args.url)


if __name__ == "__main__":
    asyncio.run(main())

