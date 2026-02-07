import asyncio
import platform

import computeruse


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening Notepad...")
    editor = desktop.open_application("notepad.exe")
    await asyncio.sleep(2)

    if platform.release() == "11":
        document = await editor.locator("role:Document").first()
    else:
        document = await editor.locator("role:Edit").first()

    document.type_text("Menu interaction demo (Alt key navigation).")
    await asyncio.sleep(0.5)

    print("Opening File menu via Alt+F...")
    # Many Win32 apps support Alt+F -> menu. New Notepad versions may behave differently.
    editor.press_key("{Alt}")
    await asyncio.sleep(0.2)
    editor.press_key("f")
    await asyncio.sleep(0.5)

    # Try common access keys for "Save As". If it fails, fall back to Ctrl+Shift+S.
    print("Selecting 'Save As' via menu (then cancel)...")
    try:
        editor.press_key("a")
        await asyncio.sleep(1)
    except Exception:
        editor.press_key("{Ctrl}{Shift}s")
        await asyncio.sleep(1)

    # Cancel out of the Save dialog to keep the example non-destructive
    try:
        save_as = desktop.locator("window:Save As")
        dlg = await save_as.first()
        dlg.press_key("{Esc}")
    except Exception:
        pass

    print("Done (opened menu + Save As dialog, then cancelled).")


if __name__ == "__main__":
    asyncio.run(main())

