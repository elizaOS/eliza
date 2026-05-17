from abc import ABCMeta, abstractmethod
from gi.repository import Gtk
from typing import TYPE_CHECKING

from tps_frontend import TRANSLATION_DOMAIN

if TYPE_CHECKING:
    from tps_frontend.window import Window


class View(object, metaclass=ABCMeta):
    @property
    @abstractmethod
    def _ui_file(self) -> str:
        pass

    def __init__(self, window: "Window"):
        self.window = window
        self.builder = Gtk.Builder()
        self.builder.add_from_file(self._ui_file)
        self.builder.set_translation_domain(TRANSLATION_DOMAIN)
        self.builder.connect_signals(self)
        self.box = self.builder.get_object("box")

    def show(self):
        # Hide all other views
        for child in self.window.view_box.get_children():
            self.window.view_box.remove(child)
        # Call on_hide of the last active view
        if self.window.active_view:
            self.window.active_view.on_hide()
        # Set this view as the active view
        self.window.active_view = self
        # Show this view
        self.window.view_box.add(self.box)

    def on_hide(self):
        pass
