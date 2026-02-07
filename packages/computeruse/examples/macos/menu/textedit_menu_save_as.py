import asyncio

import computeruse


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening TextEdit...")
    app = desktop.open_application("TextEdit")
    await asyncio.sleep(2)

    print("Opening File menu via Command+Shift+S (Save As)...")
    app.press_key("{Command}{Shift}s")
    await asyncio.sleep(1)

    print("If a Save As dialog opened, the menu interaction worked (cancel it to avoid saving).")


if __name__ == "__main__":
    asyncio.run(main())

