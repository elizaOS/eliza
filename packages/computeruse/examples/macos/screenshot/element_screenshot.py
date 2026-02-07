"""
Capture a screenshot of a UI element and OCR it (experimental on macOS).

Requirements:
  pip install Pillow
"""

import asyncio

import computeruse

try:
    from PIL import Image
except ImportError:
    raise SystemExit("Please install Pillow: pip install Pillow")


async def main() -> None:
    desktop = computeruse.Desktop(log_level="error")

    target = await desktop.locator("role:Button").first()
    screenshot = target.capture()

    image = Image.frombytes(
        "RGBA", (screenshot.width, screenshot.height), screenshot.image_data
    )
    image.save("element-macos.png")
    print("Saved element screenshot to element-macos.png")

    text = await desktop.ocr_screenshot(screenshot)
    print("OCR text:")
    print(text)


if __name__ == "__main__":
    asyncio.run(main())

