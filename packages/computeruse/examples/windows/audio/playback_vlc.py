import asyncio
import argparse

import computeruse


async def main() -> None:
    parser = argparse.ArgumentParser(description="Play a local audio file via VLC.")
    parser.add_argument("--file", required=True, help="Path to a local audio file (mp3/wav).")
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

    print("Opening file dialog (Ctrl+O)...")
    vlc_window.press_key("{Ctrl}o")
    await asyncio.sleep(1)

    file_dialog = desktop.locator("window:Select one or more files to open")
    dlg = await file_dialog.first()
    await asyncio.sleep(0.5)

    file_name_edit_box = await dlg.locator("role:ComboBox").locator("role:Edit").first()
    file_name_edit_box.click()
    file_name_edit_box.press_key("{Ctrl}a")
    file_name_edit_box.type_text(args.file)

    # Click "Open" button
    for child in dlg.children():
        if child.role() == "Button" and child.name() == "Open":
            child.click()
            break

    print("Playing... (pressing Space to toggle pause/play)")
    await asyncio.sleep(2)
    vlc_window.press_key(" ")
    await asyncio.sleep(1)
    vlc_window.press_key(" ")

    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())

