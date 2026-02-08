import asyncio

import computeruse


async def _click_first_match(window: computeruse.UIElement, names: list[str]) -> bool:
    for n in names:
        try:
            btn = await window.locator(f"Name:{n}").first()
            btn.click()
            return True
        except Exception:
            continue
    return False


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening Sound Recorder...")
    try:
        app = desktop.open_application("uwp:Microsoft.WindowsSoundRecorder")
    except Exception:
        app = desktop.open_application("SoundRecorder.exe")

    await asyncio.sleep(2)

    window = await app.first()

    # UI labels vary across Windows versions/locales. Adjust if needed.
    print("Starting recording...")
    started = await _click_first_match(
        window,
        [
            "Start recording",
            "Record",
            "Start",
        ],
    )
    if not started:
        print("Could not find a Record button. Try inspecting the UI tree and updating selectors.")
        return

    await asyncio.sleep(5)

    print("Stopping recording...")
    stopped = await _click_first_match(
        window,
        [
            "Stop recording",
            "Stop",
        ],
    )
    if not stopped:
        # Last-resort: spacebar often toggles record/stop depending on focus.
        try:
            window.press_key(" ")
        except Exception:
            pass

    print("Recording stopped (Sound Recorder typically auto-saves).")


if __name__ == "__main__":
    asyncio.run(main())

