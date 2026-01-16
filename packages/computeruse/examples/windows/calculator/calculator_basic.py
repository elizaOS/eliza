import asyncio

import computeruse


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening Calculator...")
    try:
        calc = desktop.open_application("uwp:Microsoft.WindowsCalculator")
    except Exception:
        calc = desktop.open_application("calc.exe")

    await asyncio.sleep(2)

    display = calc.locator("nativeid:CalculatorResults")
    button_1 = await calc.locator("Name:One").first()
    button_plus = await calc.locator("Name:Plus").first()
    button_2 = await calc.locator("Name:Two").first()
    button_equals = await calc.locator("Name:Equals").first()

    print("Computing 1 + 2 ...")
    button_1.click()
    await asyncio.sleep(0.2)
    button_plus.click()
    await asyncio.sleep(0.2)
    button_2.click()
    await asyncio.sleep(0.2)
    button_equals.click()
    await asyncio.sleep(0.8)

    try:
        element = await display.first()
        print("Display:", element.name())
    except Exception as e:
        print("Could not read display:", str(e))


if __name__ == "__main__":
    asyncio.run(main())

