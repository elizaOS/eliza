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
    vlc = desktop.open_application("vlc")
    await asyncio.sleep(2)

    # Many Linux VLC builds support Ctrl+N for network stream
    vlc.press_key("{Ctrl}n")
    await asyncio.sleep(1)

    # Locators vary; this is a best-effort example.
    # If it fails, inspect the dialog and update selectors.
    try:
        dlg = await desktop.locator("window:Open Media").first()
        edit = await dlg.locator("role:text").first()
        edit.perform_action("focus")
        edit.type_text(args.url)
        await asyncio.sleep(0.2)
        play = await dlg.locator("button:Play").first()
        play.perform_action("click")
        print("Streaming should now be playing in VLC.")
    except Exception as e:
        print("Could not automate the Open Media dialog:", str(e))


if __name__ == "__main__":
    asyncio.run(main())

