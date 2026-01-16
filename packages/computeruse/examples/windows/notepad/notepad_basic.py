import asyncio
import os
import platform

import computeruse


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening Notepad...")
    editor = desktop.open_application("notepad.exe")
    await asyncio.sleep(2)

    # Windows 11 Notepad uses tabs and a Document control; older Notepad is Edit.
    if platform.release() == "11":
        document = await editor.locator("role:Document").first()
    else:
        document = await editor.locator("role:Edit").first()

    document.type_text("hello from computeruse!\nthis is a windows notepad example.")
    await asyncio.sleep(0.5)

    print("Saving via Ctrl+S...")
    document.press_key("{Ctrl}s")
    await asyncio.sleep(1)

    save_dialog = editor.locator("window:Save As")
    file_name_edit_box = (
        await save_dialog.locator("role:Pane")
        .locator("role:ComboBox")
        .locator("role:Edit")
        .first()
    )

    home_dir = os.path.expanduser("~")
    file_path = os.path.join(home_dir, "computeruse_windows_notepad.txt")
    file_already_exists = os.path.exists(file_path)

    file_name_edit_box.press_key("{Ctrl}a")
    file_name_edit_box.type_text(file_path)

    save_button = await save_dialog.locator("Button:Save").first()
    save_button.click()

    if file_already_exists:
        confirm_overwrite = (
            await save_dialog.locator("Window:Confirm Save As")
            .locator("Name:Yes")
            .first()
        )
        confirm_overwrite.click()

    print(f"Saved: {file_path}")


if __name__ == "__main__":
    asyncio.run(main())

