import asyncio

import computeruse


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    # GNOME Sound Recorder command varies; try a couple.
    print("Opening GNOME Sound Recorder...")
    try:
        app = desktop.open_application("gnome-sound-recorder")
    except Exception:
        app = desktop.open_application("sound-recorder")

    await asyncio.sleep(2)

    window = await app.first()

    # Best-effort: find a "Record" button.
    for name in ["Record", "Start Recording", "Start", "●"]:
        try:
            btn = await window.locator(f"button:{name}").first()
            btn.perform_action("click")
            print("Recording for 5 seconds...")
            await asyncio.sleep(5)
            btn.perform_action("click")
            print("Stopped recording.")
            return
        except Exception:
            continue

    print("Could not find a record control. Inspect the accessibility tree and adjust selectors.")


if __name__ == "__main__":
    asyncio.run(main())

