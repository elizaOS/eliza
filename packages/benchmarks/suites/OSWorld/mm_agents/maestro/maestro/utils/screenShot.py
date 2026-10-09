from PIL import Image

from ..hardware_interface import HardwareInterface
from ..Backend.PyAutoGUIBackend import PyAutoGUIBackend
import pyautogui


# Handle Mac DPI scaling issues
def scale_screenshot_dimensions(screenshot: Image.Image, hwi_para: HardwareInterface):
    screenshot_high = screenshot.height
    screenshot_width = screenshot.width
    if isinstance(hwi_para.backend, PyAutoGUIBackend):
        screen_width, screen_height = pyautogui.size()
        if screen_width != screenshot_width or screen_height != screenshot_high:
            screenshot = screenshot.resize((screen_width, screen_height), Image.Resampling.LANCZOS)

    return screenshot

