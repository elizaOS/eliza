import tailsgreeter.config
from tailsgreeter.settings.setting import BooleanSetting


class UnsafeBrowserSetting(BooleanSetting):
    """Setting controlling whether the Unsafe Browser is available or not"""

    def __init__(self):
        super().__init__(
            tailsgreeter.config.unsafe_browser_setting_path,
            "TAILS_UNSAFE_BROWSER_ENABLED",
        )
