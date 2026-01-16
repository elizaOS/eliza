import asyncio
import os
import platform

import computeruse


def _is_windows_11() -> bool:
    # Windows 11 build numbers are >= 22000
    if platform.system() != "Windows":
        return False
    try:
        return int(platform.version().split(".")[2]) >= 22000
    except Exception:
        return False


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening Snipping Tool...")
    desktop.open_application("SnippingTool.exe")
    await asyncio.sleep(2)

    app_window = desktop.locator("window:Snipping Tool")

    if _is_windows_11():
        # Make sure we're in snipping mode (not screen recording mode)
        try:
            toggle = await app_window.locator("Name:Capture mode").first()
            if toggle.name() != "Capture mode set to snipping":
                toggle.set_toggled(not toggle.is_toggled())
        except Exception:
            pass

        try:
            new_btn = await app_window.locator("Name:New screenshot").first()
            new_btn.click()
        except Exception:
            pass

    # Freeform selection is hard to script reliably without stable coordinates across machines.
    # This example uses a simple rectangular drag based on current window location.
    try:
        screen = await app_window.first()
        # Click-drag a rectangle.
        screen.mouse_click_and_hold(200, 200)
        await asyncio.sleep(0.1)
        screen.mouse_move(600, 450)
        await asyncio.sleep(0.1)
        screen.mouse_release()
        await asyncio.sleep(1)
    except Exception as e:
        print("Could not draw snip shape:", str(e))

    print("Saving (Ctrl+S)...")
    window = await app_window.first()
    window.press_key("{Ctrl}s")
    await asyncio.sleep(1)

    save_dialog = app_window.locator("window:Save As")
    file_name_edit_box = (
        await save_dialog.locator("role:Pane")
        .locator("role:ComboBox")
        .locator("role:Edit")
        .first()
    )

    home_dir = os.path.expanduser("~")
    file_path = os.path.join(home_dir, "computeruse_snip.png")
    file_already_exists = os.path.exists(file_path)

    file_name_edit_box.press_key("{Ctrl}a")
    file_name_edit_box.type_text(file_path)

    save_button = await save_dialog.locator("Button:Save").first()
    save_button.click()

    if file_already_exists:
        try:
            confirm_overwrite = (
                await save_dialog.locator("Window:Confirm Save As")
                .locator("Name:Yes")
                .first()
            )
            confirm_overwrite.click()
        except Exception:
            pass

    print(f"Saved: {file_path}")


if __name__ == "__main__":
    asyncio.run(main())

