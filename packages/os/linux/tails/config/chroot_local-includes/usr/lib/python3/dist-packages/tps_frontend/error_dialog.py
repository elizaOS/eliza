from gi.repository import GLib, Gtk
from typing import TYPE_CHECKING

from tps_frontend import _

if TYPE_CHECKING:
    from tps_frontend.window import Window


class ErrorDetails:
    def __init__(self, title: str, text: str):
        self.title = title
        self.text = text


class ErrorDialog(Gtk.MessageDialog):
    def __init__(
        self,
        parent: "Window",
        title: str,
        msg: str,
        msg_is_markup: bool = False,
        details: ErrorDetails = None,
        with_send_report_button: bool = True,
    ):
        super().__init__(
            parent,
            Gtk.DialogFlags.DESTROY_WITH_PARENT,
            Gtk.MessageType.ERROR,
            Gtk.ButtonsType.CLOSE,
            title,
            use_markup=True,
        )
        self.launch_whisperback = parent.app.launch_whisperback
        self.title = title
        self.msg = msg

        if details:
            self.add_details(details)

        message_area = self.get_message_area()  # type: Gtk.Box
        title_label, secondary_label = message_area.get_children()  # type: Gtk.Label

        # Make the title bold
        title = GLib.markup_escape_text(title)
        title_label.set_markup(f"<b>{title}</b>")

        # Make the error message selectable to allow the user to search
        # for the error via copy-and-paste.
        secondary_label.set_selectable(True)

        if with_send_report_button:
            error_report_msg = _(
                "You can send an error report to help solve the issue."
            )
            if msg:
                msg += "\n\n" + error_report_msg
            else:
                msg = error_report_msg

            self.add_button(_("_Send Error Report"), Gtk.ResponseType.OK)
            button = self.get_widget_for_response(Gtk.ResponseType.OK)
            style_context = button.get_style_context()
            style_context.add_class("suggested-action")

        if not msg_is_markup:
            msg = GLib.markup_escape_text(msg)
        msg = f"<span insert-hyphens='no'>{msg}</span>"
        self.format_secondary_markup(msg)
        self.set_default_response(Gtk.ResponseType.CLOSE)

    def add_details(self, details: ErrorDetails):
        # Add a details expander
        expander = Gtk.Expander()
        expander.set_use_markup(True)
        expander.set_label(details.title)
        expander.set_expanded(False)
        expander.set_margin_start(12)
        expander.set_margin_end(12)

        # Add a scrolled window to the expander
        scrolled_window = Gtk.ScrolledWindow()
        # Automatically show the scrollbars when needed
        scrolled_window.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scrolled_window.set_margin_top(6)
        scrolled_window.set_margin_start(6)
        scrolled_window.set_margin_end(6)
        expander.add(scrolled_window)

        # Add a text view to the scrolled window
        text_view = Gtk.TextView()
        text_view.set_editable(False)
        text_view.set_cursor_visible(False)
        text_view.set_wrap_mode(Gtk.WrapMode.CHAR)
        text_view.set_monospace(True)
        text_view.get_buffer().set_text(details.text)
        scrolled_window.add(text_view)
        scrolled_window.set_vexpand(True)

        # Add the expander to the dialog
        self.get_content_area().pack_start(expander, True, True, 0)
        expander.show_all()

        # Allow the user to resize the dialog (the default size might
        # be too small to comfortably read the details)
        self.set_resizable(True)

    def do_response(self, response_id: int):
        if response_id == Gtk.ResponseType.OK:
            self.launch_whisperback(
                error_summary="PersistentStorage - %s" % self.title,
                error_report_msg=self.msg,
            )
        self.destroy()
