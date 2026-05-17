from logging import getLogger
from gi.repository import Gtk

from tps_frontend import DELETED_VIEW_UI_FILE
from tps_frontend.view import View

logger = getLogger(__name__)


class DeletedView(View):
    _ui_file = DELETED_VIEW_UI_FILE

    def on_close_button_clicked(self, button: Gtk.Button):
        self.window.destroy()
