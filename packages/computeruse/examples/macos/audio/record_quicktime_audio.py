import asyncio

import computeruse


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening QuickTime Player...")
    app = desktop.open_application("QuickTime Player")
    await asyncio.sleep(2)

    # Menu interaction: File -> New Audio Recording is typically Cmd+Option+N.
    # This is a best-effort starting point; adjust to your QuickTime version.
    print("Starting New Audio Recording (Cmd+Option+N)...")
    app.press_key("{Command}{Option}n")
    await asyncio.sleep(2)

    # Record button labels vary; if local automation can't find it, use the menu shortcut only.
    try:
        win = await desktop.locator("role:Window").first()
        record = await win.locator("role:Button").first()
        record.click()
        print("Recording for 5 seconds...")
        await asyncio.sleep(5)
        record.click()
        print("Stopped recording (save manually if prompted).")
    except Exception as e:
        print("Could not click record button automatically:", str(e))
        print("If the recording window opened, click Record/Stop manually.")


if __name__ == "__main__":
    asyncio.run(main())

