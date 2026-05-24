import tailsgreeter.config
from tailsgreeter.settings.setting import BooleanSetting


class NetworkSetting(BooleanSetting):
    """Setting controlling if networking is enabled at all"""

    def __init__(self):
        super().__init__(tailsgreeter.config.network_setting_path, "TAILS_NETWORK")
