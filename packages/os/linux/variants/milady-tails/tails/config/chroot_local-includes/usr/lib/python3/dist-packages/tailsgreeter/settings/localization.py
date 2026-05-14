#
# Copyright 2012-2019 Tails developers <foundations@tails.net>
# Copyright 2011 Max <govnototalitarizm@gmail.com>
# Copyright 2011 Martin Owens
#
# This program is free software: you can redistribute it and/or modify
#  it under the terms of the GNU General Public License as published by
#  the Free Software Foundation, either version 3 of the License, or
#  (at your option) any later version.
#
#  This program is distributed in the hope that it will be useful,
#  but WITHOUT ANY WARRANTY; without even the implied warranty of
#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#  GNU General Public License for more details.
#
#  You should have received a copy of the GNU General Public License
#  along with this program.  If not, see <http://www.gnu.org/licenses/>

import gi
import logging
import pycountry
from typing import TYPE_CHECKING, ClassVar

gi.require_version("GObject", "2.0")
from gi.repository import GObject  # noqa: E402

import tailsgreeter.utils  # noqa: E402
from tailsgreeter.settings import SettingNotFoundError  # noqa: E402
from tailsgreeter.settings.utils import read_settings, write_settings  # noqa: E402


if TYPE_CHECKING:
    from gi.repository import Gtk


class LocalizationSetting(GObject.Object):
    def __init__(self) -> None:
        GObject.Object.__init__(self)
        self.value: str = ""
        self.value_changed_by_user = False
        self.log = logging.getLogger(self.__class__.__name__)

    def get_value(self) -> str:
        return self.value

    def get_name(self, value: str) -> str:
        raise NotImplementedError

    def get_tree(self) -> "Gtk.Treestore":
        raise NotImplementedError

    def save(self, value: str, is_default: bool):
        pass

    def load(self):
        pass


class CleartextStorageMixin(GObject.Object):
    __gproperties__: ClassVar[dict] = {
        "saveEnabled": (
            bool,
            "saveEnabled",
            "Whether data can be written to disk",
            False,
            GObject.ParamFlags.READWRITE,
        ),
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.save_enabled = False
        self.last_saved_value = None  # if any value has been saved, this will be non-None, allowing us to force a save_to_disk

    def load(self):
        try:
            value = tailsgreeter.utils.get_cleartext_storage(self.SETTINGS_KEY)
            loaded_from_cleartext = True
        except SettingNotFoundError:
            try:
                value = read_settings(self.legacy_settings_file)
                loaded_from_cleartext = False
            except FileNotFoundError:
                self.log.debug("No %s legacy setting found", self.SETTINGS_KEY)
                return {}
            self.log.info(
                "No cleartext %s setting found, loaded from Persistent Storage instead",
                self.SETTINGS_KEY,
            )

            # When we load a legacy setting, we don't want to propose users to save it
            # unencrypted immediately so we set this to true.
            # The user is still *able* to do this, they just need to flip the Save
            # switch.
            value["IS_DEFAULT"] = "true"

        self.log.info("Successfully loaded %s (%s)", self.SETTINGS_KEY, value)
        self.set_property("saveEnabled", loaded_from_cleartext)
        return value

    def save(self, *args, **kwargs):
        data = self.serialize(*args, **kwargs)
        self.last_saved_value = data
        self.log.debug("set transient value")
        write_settings(
            f"/var/lib/gdm3/settings/transient/tails.{self.SETTINGS_KEY}", data
        )
        if self.save_enabled:
            self.log.debug("save to disk")
            self.save_to_disk()

    def do_get_property(self, prop):
        if prop.name == "saveEnabled":
            return self.save_enabled
        raise AttributeError("unknown property %s" % prop.name)

    def do_set_property(self, prop, value):
        if prop.name == "saveEnabled":
            self.save_enabled = value
            if value:
                self.save_to_disk()
            else:
                self.delete_from_disk()
        else:
            raise AttributeError(
                f"unknown property {prop.name} in {self.__class__.__name__}"
            )

    def save_to_disk(self):
        tailsgreeter.utils.set_cleartext_storage(
            self.SETTINGS_KEY, self.last_saved_value
        )

    def delete_from_disk(self):
        tailsgreeter.utils.unset_cleartext_storage(self.SETTINGS_KEY)


def ln_iso639_tri(ln_CC):
    """get iso639 3-letter code from a language code

    example: en -> eng"""
    return pycountry.languages.get(alpha2=language_from_locale(ln_CC)).terminology


def ln_iso639_2_T_to_B(lng):
    """Convert a ISO-639-2/T code (e.g. deu for German) to a 639-2/B one
    (e.g. ger for German)"""
    return pycountry.languages.get(terminology=lng).bibliographic


def language_from_locale(locale: str) -> str:
    """Obtain the language code from a locale code

    example: fr_FR -> fr"""
    return locale.split("_")[0]


def country_from_locale(locale):
    """Obtain the country code from a locale code

    example: fr_FR -> FR"""
    return locale.split("_")[1]


def countries_from_locales(locales) -> list[str]:
    """Obtain a country code list from a locale code list

    example: [fr_FR, en_GB] -> [FR, GB]"""
    return list({country_from_locale(locale) for locale in locales})


def add_encoding(locale_code: str) -> str:
    """
    Given a locale_code with or without encoding, make sure the encoding is specified
    """
    return locale_code if "." in locale_code else locale_code + ".UTF-8"
