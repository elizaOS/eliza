import gi

from tailsgreeter.ui.setting import GreeterSetting
from tailsgreeter.ui.region_settings import LocalizationSettingUI
from tailsgreeter.ui.additional_settings import AdditionalSetting

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # NOQA: E402


class GreeterSettingsCollection:
    def __init__(self, *settings: GreeterSetting, no_subclassification=False):
        self.settings = {setting.name: setting for setting in settings}

        if no_subclassification:
            return

        self.region_settings = GreeterSettingsCollection(
            *(
                s
                for s in self.settings.values()
                if isinstance(s, LocalizationSettingUI)
            ),
            no_subclassification=True,
        )
        self.additional_settings = GreeterSettingsCollection(
            *(s for s in self.settings.values() if isinstance(s, AdditionalSetting)),
            no_subclassification=True,
        )

    def __getitem__(self, key) -> GreeterSetting:
        return self.settings[key]

    def __iter__(self):
        return iter(self.settings.values())

    def id_from_row(self, row: Gtk.ListBoxRow):
        for setting in self.settings.values():
            if setting.listboxrow == row:
                return setting.name
