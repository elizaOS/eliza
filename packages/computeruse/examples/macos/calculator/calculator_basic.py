import asyncio

import computeruse


async def _click_first(locator: computeruse.Locator) -> None:
    elems = await locator.all()
    if not elems:
        raise RuntimeError("No matching elements found")
    elems[0].click()


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening Calculator...")
    desktop.open_application("calculator")

    # These selectors are app/version dependent; adjust if needed.
    seven = desktop.locator("application:Calculator >> button:7")
    plus = desktop.locator("application:Calculator >> button:Add")
    three = desktop.locator("application:Calculator >> button:3")
    equals = desktop.locator("application:Calculator >> button:Equals")

    await _click_first(seven)
    await _click_first(plus)
    await _click_first(three)
    await _click_first(equals)

    await asyncio.sleep(1)
    print("Done (expected result: 10).")


if __name__ == "__main__":
    asyncio.run(main())

