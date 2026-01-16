import asyncio
import computeruse


async def main():
    desktop = computeruse.Desktop(log_level="error")

    # Try to find a window element to get monitor info
    locator = desktop.locator("role:Window")
    try:
        windows = await locator.all()
        if not windows:
            print("No windows found.")
        for idx, window in enumerate(windows):
            print(f"Found window {idx+1}: {window.name() or 'Unnamed window'}")
            # Get monitor information for the window
            monitor = window.monitor()
            print("\nMonitor information:")
            print(f"Name: {monitor.name}")
            print(f"ID: {monitor.id}")
            print(f"Position: ({monitor.x}, {monitor.y})")
            print("-" * 10)

        # You can also get monitor info for any UI element
        # For example, let's find a button and get its monitor
        button_locator = desktop.locator("role:Button")
        button = await button_locator.first()
        if button:
            print("\nFound button:", button.name() or "Unnamed button")
            button_monitor = button.monitor()
            print(f"Button is on monitor: {button_monitor.name}")

    except Exception as e:
        print("Error:", str(e))


if __name__ == "__main__":
    asyncio.run(main())
