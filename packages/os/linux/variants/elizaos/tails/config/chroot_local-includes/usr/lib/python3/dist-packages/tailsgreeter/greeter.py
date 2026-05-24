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
#

import contextlib
import gettext
import gi
import logging
import os
from pathlib import Path

from tailslib.persistence import is_tails_media_writable

from tailsgreeter import config
from tailsgreeter.config import persistent_settings_dir, transient_settings_dir
from tailsgreeter.gdmclient import GdmClient
from tailsgreeter.settings import localization, SettingNotFoundError
from tailsgreeter.settings.admin import AdminSetting
from tailsgreeter.settings.localization_settings import LocalisationSettings
from tailsgreeter.settings.macspoof import MacSpoofSetting
from tailsgreeter.settings.network import NetworkSetting
from tailsgreeter.settings.persistence import PersistentStorageSettings
from tailsgreeter.settings.persistent_storage_create import (
    PersistentStorageCreateSetting,
)
from tailsgreeter.settings.unsafe_browser import UnsafeBrowserSetting
from tailsgreeter.translatable_window import TranslatableWindow
from tailsgreeter.ui.additional_settings import (
    AdminSettingUI,
    MACSpoofSettingUI,
    NetworkSettingUI,
    UnsafeBrowserSettingUI,
)
from tailsgreeter.ui.main_window import GreeterMainWindow
from tailsgreeter.ui.region_settings import (
    LanguageSettingUI,
    KeyboardSettingUI,
    FormatsSettingUI,
)
from tailsgreeter.ui.settings_collection import GreeterSettingsCollection

gi.require_version("Gio", "2.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gio, Gtk  # noqa: E402


class GreeterApplication:
    """Tails greeter main controller

    This class is the greeter dbus service"""

    def __init__(self):
        self.initialization_complete = False
        self.session = None
        self.forced = False
        self.postponed = False
        self.postponed_text = None
        self.ready = False
        self.translated = False

        self._sessionmanager = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            None,
            "org.gnome.SessionManager",
            "/org/gnome/SessionManager",
            "org.gnome.SessionManager",
        )

        # Create the settings directories
        os.makedirs(persistent_settings_dir, mode=0o700, exist_ok=True)
        os.makedirs(transient_settings_dir, mode=0o700, exist_ok=True)

        # Load models
        self.gdmclient = GdmClient(session_opened_cb=self.close_app)

        persistence = PersistentStorageSettings()
        self.localisationsettings = LocalisationSettings(
            usermanager_loaded_cb=self.usermanager_loaded,
        )
        self.persistent_storage_create = PersistentStorageCreateSetting()
        self.admin_setting = AdminSetting()
        self.macspoof_setting = MacSpoofSetting()
        self.network_setting = NetworkSetting()
        self.unsafe_browser_setting = UnsafeBrowserSetting()

        language_settings_ui = LanguageSettingUI(
            self.localisationsettings.language, self.on_language_changed
        )
        keyboard_settings_ui = KeyboardSettingUI(self.localisationsettings.keyboard)
        # Initialize the settings
        self.settings = GreeterSettingsCollection(
            language_settings_ui,
            keyboard_settings_ui,
            FormatsSettingUI(self.localisationsettings.formats),
            AdminSettingUI(self.admin_setting),
            MACSpoofSettingUI(self.macspoof_setting),
            NetworkSettingUI(self.network_setting),
            UnsafeBrowserSettingUI(self.unsafe_browser_setting),
        )

        # Initialize main window
        self.mainwindow = GreeterMainWindow(self, persistence, self.settings)

        # Apply the default settings
        logging.info("Applying default settings")
        for setting in self.settings:
            setting.apply()

        if is_tails_media_writable():
            logging.info("Loading cleartext settings...")
            with contextlib.suppress(SettingNotFoundError):
                language_settings_ui.load()
            with contextlib.suppress(SettingNotFoundError):
                keyboard_settings_ui.load()

        # Inhibit the session being marked as idle
        self.inhibit_idle()
        self.initialization_complete = True

    def translate_to(self, lang):
        """Translate all windows to target language"""
        TranslatableWindow.translate_all(lang)

    def login(self):
        """Login GDM to the server"""
        logging.debug("login called")
        self.mainwindow.hide()
        self.gdmclient.do_login()

    def usermanager_loaded(self):
        """UserManager is ready"""
        logging.debug("Entering usermanager_loaded")
        self.ready = True
        logging.info("tails-greeter is ready.")
        self.mainwindow.show()

        kernel_params = Path("/proc/cmdline").read_text().split()

        unlock_param = next(
            (param for param in kernel_params if param.startswith("unlock=")),
            None,
        )
        if unlock_param:
            password = unlock_param[len("unlock=") :]
            self.mainwindow.persistence_setting.unlock(password)
            self.mainwindow.cb_tps_unlocked()

        if "login" in kernel_params:
            self.login()

    def on_language_changed(self, locale_code: str):
        """Translate to the given locale"""
        for setting in self.settings.region_settings:
            setting.on_language_changed(locale_code)

        self.translate_to(locale_code)
        lang = localization.language_from_locale(locale_code)
        config.set_current_language(lang)

    def close_app(self):
        """We're done, quit gtk app"""
        logging.info("Finished.")
        Gtk.main_quit()

    def shutdown(self):
        """Shuts down the computer using GNOME Session Manager"""
        logging.info("Shutdown")
        self._sessionmanager.Shutdown()

    def inhibit_idle(self):
        cookie = self._sessionmanager.Inhibit(
            "(susu)", "org.boum.tails.Greeter", 0, "Greeter session shouldn't idle", 8
        )  # Inhibit the session being marked as idle
        logging.debug("inhibitor cookie=%i", cookie)
