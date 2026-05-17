import os

from gi.repository import Gdk, Gio, GLib, Gtk
from typing import TYPE_CHECKING

from tails_installer import _, TailsInstallerError
from tails_installer.tps_proxy import tps_proxy
from tails_installer.utils import _get_datadir
from tps.dbus.errors import DBusError
from tps_frontend.passphrase_strength_hint import set_passphrase_strength_hint
from tps_frontend import CSS_FILE

PASSPHRASE_DIALOG_UI_FILE = os.path.join(_get_datadir(), "passphrase_dialog.ui")

if TYPE_CHECKING:
    from gi.repository import GObject
    from tails_installer.creator import TailsInstallerCreator
    from tails_installer.gui import TailsInstallerWindow


@Gtk.Template.from_file(PASSPHRASE_DIALOG_UI_FILE)
class PassphraseDialog(Gtk.Dialog):
    __gtype_name__ = "PassphraseDialog"

    ok_button = Gtk.Template.Child()  # type: Gtk.Button
    cancel_button = Gtk.Template.Child()  # type: Gtk.Button
    passphrase_entry = Gtk.Template.Child()  # type: Gtk.Entry
    verify_entry = Gtk.Template.Child()  # type: Gtk.Entry
    verify_hint_box = Gtk.Template.Child()  # type: Gtk.Box
    passphrase_hint_progress_bar = Gtk.Template.Child()  # type: Gtk.ProgressBar

    def __init__(
        self,
        parent: "TailsInstallerWindow",
        creator: "TailsInstallerCreator",
        *args,
        **kwargs,
    ):
        super().__init__(use_header_bar=1, *args, **kwargs)
        self.parent = parent
        self.live = creator
        self.passphrase = None

        self.set_transient_for(self.parent)
        self.set_destroy_with_parent(True)

        # Initialize style
        style_provider = Gtk.CssProvider()
        style_provider.load_from_path(CSS_FILE)
        # noinspection PyArgumentList
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            style_provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )
        set_passphrase_strength_hint(self.passphrase_hint_progress_bar, "")

    def run(self):
        self.passphrase_entry.grab_focus()
        self.ok_button.grab_default()
        super().run()

    @Gtk.Template.Callback()
    def on_cancel_button_clicked(self, button: Gtk.Button):
        self.destroy()

    @Gtk.Template.Callback()
    def on_ok_button_clicked(self, button: Gtk.Button):
        # The operation will take a few seconds, so we make the cursor a
        # spinner to signal that things are in progress
        spinning_cursor = Gdk.Cursor.new(Gdk.CursorType.WATCH)
        self.get_window().set_cursor(spinning_cursor)

        self.set_sensitive(False)

        self.passphrase = self.passphrase_entry.get_text()
        self.destroy()

    @Gtk.Template.Callback()
    def on_passphrase_entry_changed(self, entry: Gtk.Entry):
        passphrase = entry.get_text()
        set_passphrase_strength_hint(self.passphrase_hint_progress_bar, passphrase)
        self.update_passphrase_match()

    @Gtk.Template.Callback()
    def on_verify_entry_changed(self, entry: Gtk.Entry):
        self.update_passphrase_match()

    def update_passphrase_match(self):
        verify = self.verify_entry.get_text()
        if not verify:
            # Don't display anything if the verify entry is empty
            self.verify_hint_box.set_visible(False)
            self.ok_button.set_sensitive(False)
            return

        match = verify == self.passphrase_entry.get_text()
        self.ok_button.set_sensitive(match)
        self.verify_hint_box.set_visible(not match)

    @Gtk.Template.Callback()
    def on_show_passphrase_button_toggled(self, button: Gtk.CheckButton):
        is_active = button.get_active()
        self.passphrase_entry.set_visibility(is_active)
        self.verify_entry.set_visibility(is_active)
