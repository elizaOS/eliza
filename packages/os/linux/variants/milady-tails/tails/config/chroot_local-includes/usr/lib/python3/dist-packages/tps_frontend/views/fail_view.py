from logging import getLogger

from gi.repository import Gtk

from tps_frontend import FAIL_VIEW_UI_FILE
from tps_frontend.view import View

logger = getLogger(__name__)


class FailView(View):
    _ui_file = FAIL_VIEW_UI_FILE

    def __init__(self, window):
        super().__init__(window)
        self.image = self.builder.get_object("image")  # type: Gtk.Image

    def show(self):
        super().show()
        # noinspection PyArgumentList
        icon_theme = Gtk.IconTheme.get_default()
        fail_icon = icon_theme.load_icon("computer-fail-symbolic", 128, 0)
        if fail_icon:
            self.image.set_from_pixbuf(fail_icon)

    def on_send_error_report_button_clicked(self, button: Gtk.Button):
        self.window.app.launch_whisperback()
