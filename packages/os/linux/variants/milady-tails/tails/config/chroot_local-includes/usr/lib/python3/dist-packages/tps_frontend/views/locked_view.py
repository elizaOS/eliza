from logging import getLogger
from gi.repository import Gtk
from typing import TYPE_CHECKING

from tps_frontend import LOCKED_VIEW_UI_FILE
from tps_frontend.view import View

if TYPE_CHECKING:
    from tps_frontend.window import Window

logger = getLogger(__name__)


class LockedView(View):
    _ui_file = LOCKED_VIEW_UI_FILE

    def __init__(self, window: "Window"):
        super().__init__(window)
        self.restart_button = self.builder.get_object(
            "restart_button"
        )  # type: Gtk.Button

    def show(self):
        super().show()
        self.window.restart_button.show()
        self.window.delete_button.show()

    def on_hide(self):
        self.window.restart_button.hide()
        self.window.delete_button.hide()
