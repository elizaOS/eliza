"""WhisperBack GUI

"""

import logging
import os
import smtplib  # for smtplib.SMTPException
import socket  # for socket.error
from gettext import gettext as _

# GIR imports
import gi

gi.require_version("GdkPixbuf", "2.0")
gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import (  # noqa: E402
    Gdk,
    GObject,
    Gtk,
)

# Import our modules
import whisperBack.exceptions  # noqa: E402
import whisperBack.utils  # noqa: E402
import whisperBack.whisperback  # noqa: E402

LOG = logging.getLogger(__name__)
CSS_FILE = "/usr/share/whisperback/style.css"


# pylint: disable=R0902
class WhisperBackUI:
    """
    This class provides a window containing the GTK+ user interface.

    """

    def __init__(self, debugging_info: str, prefill: dict | None):
        """Constructor of the class, which creates the main window

        This is where the main window will be created and filled with the
        widgets we want.
        """

        # Load custom CSS
        css_provider = Gtk.CssProvider()
        css_provider.load_from_path(CSS_FILE)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            css_provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )

        builder = Gtk.Builder()
        builder.set_translation_domain("tails")
        builder.add_from_file(
            os.path.join(whisperBack.utils.get_datadir(), "whisperback.ui"),
        )
        builder.connect_signals(self)

        self.main_window = builder.get_object("windowMain")
        self.hpaned_main = builder.get_object("hpanedMain")
        self.notebook = builder.get_object("notebook")
        self.progression_dialog = builder.get_object("dialogProgression")
        self.progression_main_text = builder.get_object("progressLabelMain")
        self.progression_progressbar = builder.get_object("progressProgressbar")
        self.progression_secondary_text = builder.get_object("progressLabelSecondary")
        self.progression_close = builder.get_object("progressButtonClose")
        self.gpg_dialog = builder.get_object("dialogGpgkeyblock")
        self.gpg_dialog.set_transient_for(self.main_window)
        self.gpg_keyblock = builder.get_object("textviewGpgKeyblock")
        self.gpg_ok = builder.get_object("buttonGpgOk")
        self.gpg_cancel = builder.get_object("buttonGpgClose")
        self.subject = builder.get_object("entrySubject")
        self.messageGoal = builder.get_object("textviewGoal")
        self.messageProblem = builder.get_object("textviewProblem")
        self.messageSteps = builder.get_object("textviewSteps")
        self.contact_email = builder.get_object("entryMail")
        self.contact_gpg_keyblock = builder.get_object("buttonGPGKeyBlock")
        self.prepended_details = builder.get_object("textviewPrependedInfo")
        self.include_prepended_details = builder.get_object(
            "checkbuttonIncludePrependedInfo",
        )
        self.include_bug_specific_details = builder.get_object(
            "checkbuttonIncludePrefill",
        )
        self.bug_specific_details = builder.get_object("textviewPrefill")
        self.bug_specific_details_frame = builder.get_object("framePrefill")
        self.appended_details = builder.get_object("textviewAppendedInfo")
        self.include_appended_details = builder.get_object(
            "checkbuttonIncludeAppendedInfo",
        )
        self.send_button = builder.get_object("buttonSend")

        try:
            self.main_window.set_icon_from_file(
                os.path.join(whisperBack.utils.get_pixmapdir(), "whisperback.svg"),
            )
        except GObject.GError as e:
            print(e)

        def add_to_bug_specific(header: str, value: str):
            text = (
                self.bug_specific_details.get_buffer().get_property("text")
                + f"{header}: {value}\n"
            )
            self.bug_specific_details.get_buffer().set_text(text)
            self.bug_specific_details_frame.set_visible(True)

        if prefill is not None:
            if "app" in prefill:
                add_to_bug_specific("Bug-specific app", prefill["app"].rstrip())

            if "summary" in prefill:
                add_to_bug_specific("Bug-specific summary", prefill["summary"].rstrip())

            if "details" in prefill:
                add_to_bug_specific("Bug-specific details", prefill["details"].rstrip())

        for textview in [self.messageGoal, self.messageProblem, self.messageSteps]:
            textview.get_buffer().create_tag(family="Monospace")

        self.main_window.show()

        # Launches the backend
        try:
            self.backend = whisperBack.whisperback.WhisperBackBackend(
                debugging_info=debugging_info,
                bug_specific_text=self.bug_specific_details.get_buffer().get_property(
                    "text",
                ),
            )
        except whisperBack.exceptions.MisconfigurationException as e:
            self.show_exception_dialog(
                _("Unable to load a valid configuration."),
                e,
                self.cb_close_application,
            )
            return

        # Shows the debugging details
        self.prepended_details.get_buffer().set_text(
            self.backend.prepended_data.rstrip(),
        )
        self.appended_details.get_buffer().set_text(self.backend.appended_data.rstrip())

    # CALLBACKS
    def cb_close_application(self, widget, data=None):
        """Callback function for the main window's close event"""
        self.close_application()
        return False

    def cb_enter_gpgkeyblock(self, widget, data=None):
        """Callback function to show the gpg public key block input dialog"""
        self.show_gpg_dialog()
        return False

    def cb_send_message(self, widget, data=None):
        """Callback function to actually send the message"""

        self.progression_dialog.set_title(_("Sending mail..."))
        self.progression_main_text.set_text(_("Sending mail"))
        # pylint: disable=C0301
        self.progression_secondary_text.set_text(_("This could take a while..."))
        self.progression_dialog.set_transient_for(self.main_window)
        self.progression_dialog.show()
        self.main_window.set_sensitive(False)

        self.backend.subject = self.subject.get_text()
        titles = [
            "What were you trying to achieve?",
            "What happened instead?",
            "What did you do that triggered this error?",
        ]
        parts = []
        for message in [self.messageGoal, self.messageProblem, self.messageSteps]:
            parts.append(
                message.get_buffer().get_text(
                    message.get_buffer().get_start_iter(),
                    message.get_buffer().get_end_iter(),
                    include_hidden_chars=False,
                ),
            )
        message_text = ""
        for title, part in zip(titles, parts, strict=True):
            if not part.strip():
                continue
            message_text += title + "\n" + "-" * len(title) + "\n\n"
            message_text += f"{part}\n\n"
        message_text += "\n\n\n"

        self.backend.message = whisperBack.utils.wrap_text(message_text)
        if self.contact_email.get_text():
            try:
                self.backend.contact_email = self.contact_email.get_text()
            except ValueError as e:
                self.show_exception_dialog(
                    _("The contact email address doesn't seem valid."),
                    e,
                )
                self.progression_dialog.hide()
                return None

        if not self.include_prepended_details.get_active():
            self.backend.prepended_data = ""
        if not self.include_bug_specific_details.get_active():
            self.backend.bug_specific_text = ""
        if not self.include_appended_details.get_active():
            self.backend.appended_data = ""

        # pylint: disable=C0111
        def cb_update_progress():
            self.progression_progressbar.pulse()

        # pylint: disable=C0111
        def cb_finished_progress(e):
            if isinstance(e, Exception):
                if isinstance(e, smtplib.SMTPException):
                    exception_string = _("Unable to send the mail: SMTP error.")
                elif isinstance(e, socket.error):
                    exception_string = _("Unable to connect to the server.")
                elif isinstance(e, whisperBack.exceptions.TorNotBootstrappedException):
                    exception_string = _("Tor is not ready yet")
                else:
                    exception_string = _("Unable to create or to send the mail.")

                self.show_exception_dialog(
                    exception_string
                    + _(
                        "\n\n"
                        "Make sure that you are connected to Tor and click send again.",
                    ),
                    e,
                )
                self.progression_dialog.hide()
            else:
                self.main_window.set_sensitive(False)
                self.progression_close.set_sensitive(True)
                self.progression_progressbar.set_fraction(1.0)
                self.progression_main_text.set_text(_("Your message has been sent."))
                self.progression_secondary_text.set_text("")

        try:
            self.backend.send(
                progress_callback=cb_update_progress,
                finished_callback=cb_finished_progress,
            )
        except whisperBack.exceptions.EncryptionException as e:
            self.show_exception_dialog(_("An error occurred during encryption."), e)
            self.progression_dialog.hide()

        return False

    def show_exception_dialog(
        self,
        message,
        exception,
        close_callback=None,
        parent=None,
        buttons=Gtk.ButtonsType.CLOSE,
    ):
        """Shows a dialog reporting an exception

        @param message          A string explaining the exception
        @param exception        The exception
        @param close_callback   An alternative callback to use on closing
        @param buttons          Buttons to display
        """

        LOG.debug("Show exception dialog")
        if not close_callback:
            close_callback = self.cb_close_exception_dialog

        if not parent:
            parent = self.main_window

        exception_message = str(exception)

        dialog = Gtk.MessageDialog(
            parent=parent,
            flags=Gtk.DialogFlags.MODAL,
            type=Gtk.MessageType.ERROR,
            buttons=buttons,
            message_format=message,
        )
        dialog.format_secondary_text(exception_message)

        dialog.connect("response", close_callback)
        dialog.show()

    def cb_close_exception_dialog(self, widget, data=None):
        """Callback function for the exception dialog close event"""
        self.main_window.set_sensitive(True)
        widget.hide()
        return False

    def show_gpg_dialog(self):
        """Show a text entry dialog to let the user enter a GPG public key block"""
        LOG.debug("Show gpg dialog")
        if self.backend.contact_gpgkey:
            # pylint: disable=C0301
            self.gpg_keyblock.get_buffer().set_text(str(self.backend.contact_gpgkey))
        else:
            self.gpg_keyblock.get_buffer().set_text("")
        self.gpg_dialog.show()

    def cb_gpg_close_ok(self, widget, data=None):
        """Callback function for the gpg public key entry close and apply event"""
        try:
            # pylint: disable=C0301
            self.backend.contact_gpgkey = self.gpg_keyblock.get_buffer().get_text(
                self.gpg_keyblock.get_buffer().get_start_iter(),
                self.gpg_keyblock.get_buffer().get_end_iter(),
                include_hidden_chars=False,
            )
        except ValueError as e:
            self.show_exception_dialog(
                _("This doesn't seem to be a valid URL or OpenPGP key."),
                e,
                parent=self.gpg_dialog,
            )
            return
        self.gpg_dialog.hide()

    def cb_gpg_close_cancel(self, widget, data=None):
        """Callback function for the gpg pyblick key entry cancel event"""
        self.gpg_dialog.hide()

    # pylint: disable=R0201
    def close_application(self):
        """
        Closes the application

        """
        Gtk.main_quit()
