import tailsgreeter.config
from tailsgreeter.settings.setting import BooleanSetting


class MacSpoofSetting(BooleanSetting):
    """Setting controlling whether the MAC address is spoofed or not"""

    def __init__(self):
        super().__init__(
            tailsgreeter.config.macspoof_setting_path, "TAILS_MACSPOOF_ENABLED"
        )
