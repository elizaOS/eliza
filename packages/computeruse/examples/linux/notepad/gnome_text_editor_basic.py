import asyncio

import computeruse


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    # GNOME Text Editor (new) or Gedit (older)
    print("Opening a text editor...")
    try:
        app = desktop.open_application("gnome-text-editor")
    except Exception:
        app = desktop.open_application("gedit")

    await asyncio.sleep(1.5)

    # Try common roles for the editing surface
    for selector in ["role:text", "role:document", "role:edit", "role:textarea"]:
        try:
            editor = await app.locator(selector).first()
            editor.perform_action("focus")
            editor.type_text("hello from computeruse on linux\nmenu + typing demo")
            print(f"Typed into editor using selector: {selector}")
            return
        except Exception:
            continue

    print("Could not find a text editor surface. Inspect the accessibility tree and adjust selectors.")


if __name__ == "__main__":
    asyncio.run(main())

