import asyncio

import computeruse


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening TextEdit...")
    app = desktop.open_application("TextEdit")
    await asyncio.sleep(2)

    # Best-effort: find a text/document element.
    for selector in ["role:text", "role:document", "role:TextArea", "role:AXTextArea"]:
        try:
            editor = await app.locator(selector).first()
            editor.type_text("hello from computeruse on macOS\n")
            print(f"Typed using selector: {selector}")
            return
        except Exception:
            continue

    print("Could not find a text surface. Inspect the accessibility tree and adjust selectors.")


if __name__ == "__main__":
    asyncio.run(main())

