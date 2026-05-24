#!/usr/bin/python3 -I
import sys

import gi

gi.require_version("Gdk", "3.0")
from gi.repository import Gdk  # NOQA: E402

gi.require_version("GLib", "2.0")
from gi.repository import GLib  # NOQA: E402

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # NOQA: E402

print(sys.argv)
if len(sys.argv) > 1 and sys.argv[1] == "watch":
    cursor = Gdk.CursorType.WATCH
else:
    cursor = Gdk.CursorType.LEFT_PTR


def reset_cursor():
    Gdk.get_default_root_window().set_cursor(Gdk.Cursor.new(cursor))
    Gtk.main_quit()


GLib.idle_add(reset_cursor)
Gtk.main()
