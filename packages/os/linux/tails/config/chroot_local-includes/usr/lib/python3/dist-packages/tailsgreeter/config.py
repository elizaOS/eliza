# Copyright 2012-2016 Tails developers <foundations@tails.net>
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
"""Tails Greeter configuration"""

from tailsgreeter import TRANSLATION_DOMAIN
import locale
import gettext as _gettext_orig
import os.path

# default Tails credentials
LPASSWORD = "live"
LUSER = "amnesia"

# data path
data_path = "/usr/share/tails/greeter/"

# File containing the locales for the supported languages
supported_locales_path = os.path.join(data_path, "supported_locales")

# System locales directory
system_locale_dir = "/usr/share/locale/"

# Directory where the Greeter settings are stored. Settings stored in
# this directory are copied to the persistent settings directory when
# the Welcome Screen feature is enabled in the Persistent Storage
# settings, so only store settings there which should be made
# persistent. Else use the transient settings directory.
persistent_settings_dir = "/var/lib/gdm3/settings/persistent"

# Directory where Greeter settings are stored that should not be made
# persistent. After login, these settings can also be accessed under
# /var/lib/gdm3/settings/persistent.
transient_settings_dir = "/var/lib/gdm3/settings/transient"

# Legacy: these were created before tails#5501, but we still want to read them
legacy_language_setting_path = os.path.join(persistent_settings_dir, "tails.language")
legacy_keyboard_setting_path = os.path.join(persistent_settings_dir, "tails.keyboard")

# File where the session formats setting is stored
formats_setting_path = os.path.join(persistent_settings_dir, "tails.formats")

# File where the session sudo password is stored
admin_password_path = os.path.join(persistent_settings_dir, "tails.password")

# File where the network setting is stored
network_setting_path = os.path.join(persistent_settings_dir, "tails.network")

# File where the MAC address spoofing setting is stored
macspoof_setting_path = os.path.join(persistent_settings_dir, "tails.macspoof")

# File where the unsafe browser setting is stored
unsafe_browser_setting_filename = "tails.unsafe-browser"
unsafe_browser_setting_path = os.path.join(
    persistent_settings_dir, unsafe_browser_setting_filename
)

# World-readable file where Tails persistence status is stored
persistence_state_file = "/var/lib/live/config/tails.persistence"

# World-readable file which represents the intent to create a Persistent
# Storage after login. Store this in the transient settings dir because
# we don't want to persist this setting.
persistence_create_file = os.path.join(
    transient_settings_dir, "tails.create-persistence"
)

locale.bindtextdomain(TRANSLATION_DOMAIN, system_locale_dir)
current_language = "en"
gettext = _gettext_orig.gettext


def set_current_language(lang: str):
    global current_language  # noqa: PLW0603
    global gettext  # noqa: PLW0603
    current_language = lang
    gettext = _gettext_orig.translation(
        TRANSLATION_DOMAIN,
        system_locale_dir,
        [lang],
    ).gettext
