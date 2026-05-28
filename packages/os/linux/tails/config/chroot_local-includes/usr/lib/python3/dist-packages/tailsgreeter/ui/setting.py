from typing import TYPE_CHECKING
import gi

from tailsgreeter import TRANSLATION_DOMAIN
import tailsgreeter.config

if TYPE_CHECKING:
    from tailsgreeter.ui.main_window import GreeterMainWindow
    from tailsgreeter.ui.popover import Popover

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # NOQA: E402


SETTING_UI_FILE = "setting.ui"


class GreeterSetting:
    """Base class of all settings in the greeter"""

    @property
    def name(self) -> str:
        return ""

    @property
    def title(self) -> str:
        return ""

    @property
    def icon_name(self) -> str:
        return ""

    @property
    def value_for_display(self) -> str:
        return ""

    def __init__(self) -> None:
        self.accel_key = None
        self.popover: Popover | None = None
        self.main_window: GreeterMainWindow | None = None

        self.builder = Gtk.Builder()
        self.builder.set_translation_domain(TRANSLATION_DOMAIN)
        self.builder.add_from_file(tailsgreeter.config.data_path + SETTING_UI_FILE)
        self.listboxrow = self.builder.get_object("listboxrow")  # type: Gtk.ListBoxRow
        image = self.builder.get_object("image")  # type: Gtk.Image
        image.set_from_icon_name(self.icon_name, Gtk.IconSize.LARGE_TOOLBAR)
        self.title_label = self.builder.get_object("label_caption")
        self.value_label = self.builder.get_object("label_value")
        self.title_label.set_label(self.title)

        # Strip the underscore which marks the mnemonic
        setting_name = self.title.replace("_", "", 1)
        # This is a hack to make the listboxrow usable in the Test Suite:
        # We configure a tooltip text which allows us to use it through
        # AT-SPI, but we set has_tooltip to false to not display that
        # tooltip, because the UI is self-explanatory without a tooltip
        # and the tooltip would just be noise.
        self.listboxrow.set_tooltip_text(f"Configure {setting_name}")
        self.listboxrow.set_has_tooltip(False)

    def apply(self):
        self.update_value_label()

    def load(self):
        pass

    def update_value_label(self):
        self.value_label.set_label(self.value_for_display)

    def has_popover(self) -> bool:
        return self.popover is not None
