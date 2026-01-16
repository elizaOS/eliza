import asyncio
import argparse

import computeruse


async def main() -> None:
    parser = argparse.ArgumentParser(description="Play a local audio file via VLC.")
    parser.add_argument("--file", required=True, help="Path to a local audio file (mp3/wav).")
    args = parser.parse_args()

    desktop = computeruse.Desktop(log_level="error")
    vlc = desktop.open_application("vlc")
    await asyncio.sleep(2)

    vlc.press_key("{Ctrl}o")
    await asyncio.sleep(1)

    # File picker automation is desktop-environment specific; treat this as a smoke-test.
    print("A file picker should be open; select the file manually if automation fails.")
    print("Requested file:", args.file)


if __name__ == "__main__":
    asyncio.run(main())

