import locale
import subprocess
from logging import getLogger
from gi.repository import Gio, GLib, Gtk
from typing import TYPE_CHECKING

from tps_frontend import PASSPHRASE_VIEW_UI_FILE
from tps_frontend.passphrase_strength_hint import set_passphrase_strength_hint
from tps_frontend.view import View

if TYPE_CHECKING:
    from tps_frontend.window import Window

logger = getLogger(__name__)


def wordlist():
    wordlist_dict = {
        "ca": "ca",
        "de": "de",
        "es": "es",
        "fr": "fr",
        "it": "it",
        "pt": "pt-br",
    }
    default_wordlist = "en_securedrop"
    return wordlist_dict.get(locale.getlocale()[0].split("_")[0], default_wordlist)


def get_passphrase_suggestion():
    passphrase = ""
    try:
        p = subprocess.run(
            [  # noqa: S603
                "/usr/bin/diceware",
                "--no-caps",
                "-d",
                " ",
                "--wordlist",
                wordlist(),
            ],
            stdout=subprocess.PIPE,
            check=True,
            text=True,
        )
        if p.returncode == 0:
            passphrase = p.stdout.rstrip()
    except Exception as e:
        logger.warning("Couldn't generate a diceware suggestion: %s", e)
    return passphrase


class PassphraseView(View):
    _ui_file = PASSPHRASE_VIEW_UI_FILE

    def __init__(self, window: "Window"):
        super().__init__(window)
        self.passphrase_entry = self.builder.get_object("passphrase_entry")  # type: Gtk.Entry
        self.verify_entry = self.builder.get_object("verify_entry")  # type: Gtk.Entry
        self.progress_bar = self.builder.get_object("passphrase_hint_progress_bar")  # type: Gtk.ProgressBar
        self.verify_hint_box = self.builder.get_object("verify_hint_box")  # type: Gtk.Box
        self.create_button = self.builder.get_object("create_button")  # type: Gtk.Button
        self.passphrase_hint_label = self.builder.get_object(
            "passphrase_suggestion_label"
        )
        self.example_label = self.builder.get_object("placeholder_label3")
        self.refresh_image = self.builder.get_object("refresh_image")
        self.set_new_passphrase_hint()
        set_passphrase_strength_hint(self.progress_bar, "")

    def show(self):
        super().show()
        self.passphrase_entry.grab_focus()
        self.create_button.grab_default()

    def on_back_button_clicked(self, button: Gtk.Button):
        self.window.welcome_view.show()

    def on_create_button_clicked(self, button: Gtk.Button):
        # Get the passphrase
        passphrase = self.passphrase_entry.get_text()
        # Clear the entries
        self.passphrase_entry.set_text("")
        self.verify_entry.set_text("")
        # Show the creation view
        self.window.creation_view.show()
        # Call Create
        self.window.service_proxy.call(
            method_name="Create",
            parameters=GLib.Variant("(s)", (passphrase,)),
            flags=Gio.DBusCallFlags.NONE,
            timeout_msec=GLib.MAXINT,
            cancellable=None,
            callback=self.window.on_create_call_finished,
        )

    def on_refresh_image_clicked(self, *args):
        self.set_new_passphrase_hint()

    def on_passphrase_entry_changed(self, entry: Gtk.Entry):
        passphrase = entry.get_text()
        set_passphrase_strength_hint(self.progress_bar, passphrase)
        self.update_passphrase_match()

    def on_verify_entry_changed(self, entry: Gtk.Entry):
        self.update_passphrase_match()

    def set_new_passphrase_hint(self):
        label_text = get_passphrase_suggestion()
        if label_text:
            self.show_passphrase_hint_ui()
        else:
            self.hide_passphrase_hint_ui()

        self.passphrase_hint_label.set_text(label_text)

    def show_passphrase_hint_ui(self):
        self.example_label.show()
        self.passphrase_hint_label.show()
        self.refresh_image.show()

    def hide_passphrase_hint_ui(self):
        self.example_label.hide()
        self.passphrase_hint_label.hide()
        self.refresh_image.hide()

    def update_passphrase_match(self):
        verify = self.verify_entry.get_text()
        if not verify:
            # Don't display anything if the verify entry is empty
            self.verify_hint_box.set_visible(False)
            self.create_button.set_sensitive(False)
            return

        match = verify == self.passphrase_entry.get_text()
        self.create_button.set_sensitive(match)
        self.verify_hint_box.set_visible(not match)

    def on_show_passphrase_button_toggled(self, button: Gtk.CheckButton):
        is_active = button.get_active()
        self.passphrase_entry.set_visibility(is_active)
        self.verify_entry.set_visibility(is_active)
