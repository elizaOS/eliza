import gi
import logging

import tailsgreeter.config
from tailsgreeter.settings import SettingNotFoundError
from tailsgreeter.settings.localization import (
    LocalizationSetting,
    language_from_locale,
    country_from_locale,
    add_encoding,
)
from tailsgreeter.settings.utils import read_settings, write_settings

gi.require_version("GObject", "2.0")
gi.require_version("GnomeDesktop", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import GObject, GnomeDesktop, Gtk  # noqa: E402


class FormatsSetting(LocalizationSetting):
    def __init__(self, language_codes: list[str]):
        super().__init__()
        self.locales_per_country = self._make_locales_per_country_dict(language_codes)
        self.settings_file = tailsgreeter.config.formats_setting_path

    def save(self, locale: str, is_default: bool):
        write_settings(
            self.settings_file,
            {
                "TAILS_FORMATS": locale,
                "IS_DEFAULT": is_default,
            },
        )

    def load(self) -> tuple[str, bool]:
        try:
            settings = read_settings(self.settings_file)
        except FileNotFoundError as exc:
            raise SettingNotFoundError(
                "No persistent formats settings file found (path: %s)"
                % self.settings_file
            ) from exc

        formats = settings.get("TAILS_FORMATS")
        if formats is None:
            raise SettingNotFoundError(
                "No formats setting found in settings file (path: %s)"
                % self.settings_file
            )

        is_default = settings.get("IS_DEFAULT") == "true"
        logging.debug(
            "Loaded formats setting '%s' (is default: %s)", formats, is_default
        )
        return formats, is_default

    def get_tree(self) -> Gtk.TreeStore:
        treestore = Gtk.TreeStore(
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,  # id
        )  # name

        country_codes = list(self.locales_per_country.keys())
        country_codes.sort(key=lambda x: self._country_name(x).lower())
        logging.debug("format_codes=%s", country_codes)
        for country_code in country_codes:
            country_name = self._country_name(country_code)
            if not country_name:
                # Don't display languages without a name
                continue

            treeiter_format = treestore.append(parent=None)
            treestore.set(treeiter_format, 0, self.get_default_locale(country_code))
            treestore.set(treeiter_format, 1, country_name)
            locales = sorted(
                self.locales_per_country[country_code],
                key=lambda x: self._locale_name(x).lower(),
            )
            if len(locales) > 1:
                for locale in locales:
                    treeiter_locale = treestore.append(parent=treeiter_format)
                    treestore.set(treeiter_locale, 0, locale)
                    treestore.set(treeiter_locale, 1, self._locale_name(locale))
        return treestore

    def get_name(self, locale: str) -> str:
        return self._locale_name(locale)

    def get_default_locale(self, country_code=None) -> str:
        """Return default locale for given country

        Returns the 1st locale among:
            - the locale whose country name matches country name
            - the 1st locale for the language
            - en_US
        """
        locales = self.locales_per_country[country_code]
        if not locales:
            return "en_US"

        # Get the default locale for the country
        for locale_code in locales:
            if country_from_locale(locale_code).lower() == language_from_locale(
                locale_code
            ):
                return locale_code

        return locales[0]

    def _country_name(self, country_code) -> str:
        default_locale = "C"
        local_locale = self.get_default_locale(country_code)
        native_name: str = GnomeDesktop.get_country_from_code(
            country_code, add_encoding(local_locale)
        )
        if not native_name:
            return ""
        localized_name: str = GnomeDesktop.get_country_from_code(
            country_code, add_encoding(default_locale)
        )
        if native_name == localized_name:
            return native_name
        else:
            return f"{native_name} ({localized_name})"

    @staticmethod
    def _locale_name(locale_code: str) -> str:
        lang_code = language_from_locale(locale_code)
        country_code = country_from_locale(locale_code)
        language_name_locale = GnomeDesktop.get_language_from_code(lang_code)
        language_name_native = (
            GnomeDesktop.get_language_from_code(lang_code, add_encoding(locale_code))
            or language_name_locale
        )
        country_name_locale = GnomeDesktop.get_country_from_code(country_code)
        country_name_native = (
            GnomeDesktop.get_country_from_code(country_code, add_encoding(locale_code))
            or country_name_locale
        )

        try:
            if (
                language_name_native == language_name_locale
                and country_name_native == country_name_locale
            ):
                return f"{country_name_native} - {language_name_native.capitalize()}"
            else:
                return (
                    f"{country_name_native} - {language_name_native.capitalize()} "
                    f"({country_name_locale} - {language_name_locale.capitalize()})"
                )
        except AttributeError:
            return locale_code

    @staticmethod
    def _make_locales_per_country_dict(
        language_codes: list[str],
    ) -> dict[str, list[str]]:
        """assemble dictionary of country codes to corresponding locales list

        example {FR: [fr_FR, en_FR], ...}"""
        res: dict[str, list[str]] = {}
        for language_code in language_codes:
            country_code = country_from_locale(language_code)
            if country_code not in res:
                res[country_code] = []
            if language_code not in res[country_code]:
                res[country_code].append(language_code)
        return res
