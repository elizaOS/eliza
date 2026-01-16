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
    try:
        vlc_window = desktop.open_application(
            r"C:\Program Files\VideoLAN\VLC\vlc.exe"
        )
    except Exception:
        vlc_window = desktop.open_application("vlc.exe")

    await asyncio.sleep(2)

    print("Opening 'Open Network Stream' dialog (Ctrl+N)...")
    vlc_window.press_key("{Ctrl}n")
    await asyncio.sleep(1.5)

    open_media = desktop.locator("window:Open Media")

    # This selector is known to work on common Windows VLC builds; adjust if needed.
    combo = await open_media.locator("Name:Network Protocol Down").first()
    combo.click()
    await asyncio.sleep(0.2)

    edit_box = (
        await open_media.locator("Name:Network Protocol Down")
        .locator("role:Edit")
        .first()
    )
    edit_box.click()
    edit_box.press_key("{Ctrl}a")
    edit_box.press_key("{Delete}")
    edit_box.type_text(args.url)

    print("Starting playback...")
    play_button = await open_media.locator("Name:Play Alt+P").first()
    play_button.click()

    print("Streaming should now be playing in VLC.")


if __name__ == "__main__":
    asyncio.run(main())

