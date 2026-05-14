from logging import getLogger
from gi.repository import Gtk
from typing import TYPE_CHECKING

from tps_frontend import SPINNER_VIEW_UI_FILE
from tps_frontend.view import View

if TYPE_CHECKING:
    from tps_frontend.window import Window

logger = getLogger(__name__)


class SpinnerView(View):
    _ui_file = SPINNER_VIEW_UI_FILE

    def __init__(self, window: "Window"):
        super().__init__(window)
        self.status_label = self.builder.get_object(
            "spinner_status_label"
        )  # type: Gtk.Label
