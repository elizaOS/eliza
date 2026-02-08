# `pip install -e .`
# or `maturin develop`

import asyncio
import computeruse


async def main():
    desktop = computeruse.Desktop()
    root = desktop.root()
    print("Root element:", root.role(), root.name())

    # List applications
    apps = desktop.applications()
    print("Applications:", [(a.role(), a.name()) for a in apps])

    # Find an element using a selector (async)
    locator = desktop.locator("role:button")
    try:
        button = await locator.first()
        print("Found button:", button.role(), button.name())
        await button.click()
    except computeruse.ElementNotFoundError as e:
        print("No button found:", str(e))
    except Exception as e:
        print("No button found or click failed:", str(e))

    # Run a command (async)
    try:
        cmd = await desktop.run_command("echo hello", "echo hello")
        print("Command output:", cmd.stdout)
    except Exception as e:
        print("Command failed:", str(e))

    # Screenshot (async)
    try:
        screenshot = await desktop.capture_screen()
        print(
            f"Screenshot: {screenshot.width}x{screenshot.height}, {len(screenshot.image_data)} bytes"
        )
    except Exception as e:
        print("Screenshot failed:", str(e))

    # Error handling example
    try:
        desktop.application("NonExistentApp")
    except computeruse.PlatformError as e:
        print("Platform error:", str(e))
    except Exception as e:
        print("Expected error:", str(e))

    # Show help for Desktop (prints method names)
    print("\nHelp for Desktop:")
    print([m for m in dir(computeruse.Desktop) if not m.startswith("__")])


if __name__ == "__main__":
    asyncio.run(main())
