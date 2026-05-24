#!/usr/bin/python3 -I
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
"""
GDM greeter for Tails project using gtk
"""

import gettext
import locale
import logging.config
import sys
import traceback
from pathlib import Path

import gi
import tailsgreeter.config
import tailsgreeter.gdmclient
from tailsgreeter.greeter import GreeterApplication

gi.require_version("GLib", "2.0")
gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk  # noqa: E402

# Logging
logging.config.fileConfig("tails-logging.conf")
# Set loglevel if debug is found in kernel command line
with open("/proc/cmdline") as cmdline_fd:
    cmdline = cmdline_fd.read()
if "debug" in cmdline.split() or (len(sys.argv) > 1 and sys.argv[1] == "--debug"):
    logging.getLogger().setLevel(logging.DEBUG)


def log_exc(etype, value, tb):
    for line in traceback.format_exception(etype, value, tb):
        print(line, file=sys.stderr)


sys.excepthook = log_exc


gettext.install(tailsgreeter.__appname__, tailsgreeter.config.system_locale_dir)
locale.bindtextdomain(tailsgreeter.__appname__, tailsgreeter.config.system_locale_dir)
_ = gettext.gettext

if __name__ == "__main__":
    flagfile = Path("/var/lib/gdm3/tails.greeter-seen")
    try:
        flagfile.touch(exist_ok=False)
    except FileExistsError:
        logging.error(
            "Spawning a second greeter instance prevented. Remove /var/lib/gdm3/tails.greeter-seen to spawn another greeter instance."
        )  # noqa: TRY400
        sys.exit(1)
    GLib.set_prgname(tailsgreeter.APPLICATION_TITLE)
    GLib.set_application_name(_(tailsgreeter.APPLICATION_TITLE))
    Gtk.init(sys.argv)
    Gtk.Window.set_default_icon_name(tailsgreeter.APPLICATION_ICON_NAME)

    application = GreeterApplication()
    Gtk.main()
