import asyncio
import re
import subprocess

import computeruse


def _get_gnome_calculator_major_version() -> int | None:
    try:
        out = subprocess.check_output(
            ["gnome-calculator", "--version"], text=True, stderr=subprocess.STDOUT
        ).strip()
        m = re.search(r"gnome-calculator\s+([0-9]+)(?:\.[0-9]+)*", out)
        return int(m.group(1)) if m else None
    except Exception:
        return None


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    print("Opening GNOME Calculator...")
    calc = desktop.open_application("gnome-calculator")
    await asyncio.sleep(1)

    window = await calc.locator("role:frame").first()

    # Example: 1 + 2 =
    for label in ["1", "+", "2", "="]:
        btn = await window.locator(f"button:{label}").first()
        # perform_action is more reliable across Linux environments than coordinate click.
        btn.perform_action("click")
        await asyncio.sleep(0.1)

    await asyncio.sleep(0.5)
    ver = _get_gnome_calculator_major_version()
    print("GNOME Calculator major version:", ver)

    # Result UI differs across versions.
    try:
        if ver == 48:
            labels = await window.locator("role:list item").locator("role:label").all()
            result = " ".join([c.text() for c in labels]).strip()
        else:
            result_field = await window.locator("role:editbar").first()
            result = result_field.text()
        print("Result:", result)
    except Exception as e:
        print("Could not read result:", str(e))


if __name__ == "__main__":
    asyncio.run(main())

