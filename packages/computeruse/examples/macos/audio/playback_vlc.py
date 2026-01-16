import asyncio
import argparse

import computeruse


async def main() -> None:
    parser = argparse.ArgumentParser(description="Play a local audio file via VLC (macOS).")
    parser.add_argument("--file", required=True, help="Path to a local audio file (mp3/wav).")
    args = parser.parse_args()

    desktop = computeruse.Desktop(log_level="error")

    print("Opening VLC...")
    vlc = desktop.open_application("VLC")
    await asyncio.sleep(2)

    # VLC: File -> Open File... is commonly Cmd+O
    vlc.press_key("{Command}o")
    await asyncio.sleep(1)

    print("A file picker should be open. If automation fails, select the file manually.")
    print("Requested file:", args.file)


if __name__ == "__main__":
    asyncio.run(main())

