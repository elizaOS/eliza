import locale
import logging
from collections.abc import Callable

import gi

import tailsgreeter.config
from tailsgreeter.settings.formats import FormatsSetting
from tailsgreeter.settings.keyboard import KeyboardSetting
from tailsgreeter.settings.language import LanguageSetting
from tailsgreeter.utils import glib_idle_add_once

gi.require_version("AccountsService", "1.0")
gi.require_version("GLib", "2.0")
from gi.repository import AccountsService  # noqa: E402
from gi.repository import GLib  # noqa: E402


class LocalisationSettings:
    """Controller for localisation settings"""

    def __init__(self, usermanager_loaded_cb: Callable):
        self._usermanager_loaded_cb = usermanager_loaded_cb

        self._user_account = None
        self._actusermanager_loadedid = None

        locales = self._get_locales()

        self._actusermanager = AccountsService.UserManager.get_default()
        self._actusermanager_loadedid = self._actusermanager.connect(
            "notify::is-loaded",
            self.__on_usermanager_loaded,
        )
        self.user_account = None
        self.pending_set_language = None

        self.language = LanguageSetting(locales, self)
        self.keyboard = KeyboardSetting()
        self.formats = FormatsSetting(locales)

    def __del__(self):
        if self._actusermanager_loadedid:
            self._actusermanager.disconnect(self._actusermanager_loadedid)

    @staticmethod
    def _get_locales() -> list[str]:
        with open(tailsgreeter.config.supported_locales_path) as f:
            return [line.rstrip("\n") for line in f.readlines()]

    def __on_usermanager_loaded(self, manager, pspec, data=None):
        logging.info("Received AccountsManager signal is-loaded")
        self.user_account = manager.get_user(tailsgreeter.config.LUSER)
        logging.info("User account is %s", str(self.user_account))

        if self.pending_set_language:
            # For some reason, setting the language immediately doesn't always work, as
            # if AccountsManager wasn't really loaded. Let's wait some more before
            # actually setting language:
            GLib.timeout_add_seconds(
                1,
                lambda: self.set_language(self.pending_set_language) and False,
            )

        if self._usermanager_loaded_cb:
            glib_idle_add_once(lambda: self._usermanager_loaded_cb())

    def set_language(self, language_code: str) -> bool:
        if not self.user_account:
            logging.warning("AccountsManager not ready, enqueuing for later")
            self.pending_set_language = language_code
            return False

        normalized_code = locale.normalize(
            language_code + "." + locale.getpreferredencoding()
        )
        logging.info("Setting session language to %s", normalized_code)

        # For some reason, this produces the following warning, but
        # the language is actually applied.
        #     AccountsService-WARNING **: 19:29:39.181: SetLanguage for language de_DE.UTF-8 failed:
        #     GDBus.Error:org.freedesktop.Accounts.Error.PermissionDenied: Not authorized
        glib_idle_add_once(lambda: self.user_account.set_language(normalized_code))

        return True
