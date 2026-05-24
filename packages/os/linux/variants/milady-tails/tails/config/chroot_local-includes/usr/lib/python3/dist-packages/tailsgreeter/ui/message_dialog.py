from gettext import gettext
import gi

from tailsgreeter.translatable_window import TranslatableWindow

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

_ = gettext


class MessageDialog(Gtk.MessageDialog, TranslatableWindow):
    """
    MessageDialog is a simple wrapper over Gtk.MessageDialog.

    The main addition is the integration with TranslatableWindow, which means it will be automatically translated
    whenever the global language is changed.

    For this to work, it's necessary to instantiate this *early* (not when the dialog is needed), because otherwise calling TranslatableWindow.translate_all would have no effect.
    """

    def __init__(
        self,
        message_type: Gtk.MessageType,
        title: str,
        text: str,
        cancel_label: str | None = None,
        ok_label: str | None = None,
        third_button_label: str | None = None,
        destructive: bool = False,
    ):
        Gtk.MessageDialog.__init__(self, message_type=message_type, text=title)
        TranslatableWindow.__init__(self, self)
        self.format_secondary_text(text)
        if cancel_label:
            self.cancel_button = self.add_button(cancel_label, Gtk.ResponseType.CANCEL)
        if third_button_label:
            self.third_button = self.add_button(
                third_button_label, Gtk.ResponseType.REJECT
            )
        if ok_label:
            self.ok_button = self.add_button(ok_label, Gtk.ResponseType.OK)
        if destructive:
            self.ok_button.get_style_context().add_class("destructive-action")
        self.store_translations(self)
