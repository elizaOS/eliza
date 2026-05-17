import logging
from typing import Union

from tailsgreeter.settings import SettingNotFoundError
from tailsgreeter.settings.utils import read_settings, write_settings


class Setting:
    def __init__(self, settings_file, setting_name):
        self.settings_file = settings_file
        self.setting_name = setting_name

    def save(self, value: Union[str, bool]):
        write_settings(
            self.settings_file,
            {
                self.setting_name: value,
            },
        )
        logging.debug("setting %s written to %s", self.setting_name, self.settings_file)

    def load(self) -> str:
        try:
            settings = read_settings(self.settings_file)
        except FileNotFoundError:
            raise SettingNotFoundError(
                "No persistent settings file found for %s (path: %s)"
                % (self.setting_name, self.settings_file)
            )

        value_str = settings.get(self.setting_name)
        if value_str is None:
            raise SettingNotFoundError(
                "No setting %s found in settings file (path: %s)"
                % (self.setting_name, self.settings_file)
            )
        return value_str


class StringSetting(Setting):
    def load(self) -> str:
        value = super().load()
        logging.debug("Loaded setting %s: '%s'", self.setting_name, value)
        return value


class BooleanSetting(StringSetting):
    def save(self, value: bool):  # type: ignore[override]
        super().save(value)

    def load(self) -> bool:  # type: ignore[override]
        value_str = super().load()
        value = value_str == "true"
        logging.debug("Loaded setting %s: '%s'", self.setting_name, value)
        return value
