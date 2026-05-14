from logging import getLogger
from gi.repository import GLib, Gtk
import subprocess

from tps import InvalidBootDeviceErrorType
from tps_frontend import _, WELCOME_VIEW_UI_FILE
from tps_frontend.view import View

logger = getLogger(__name__)


class WelcomeView(View):
    _ui_file = WELCOME_VIEW_UI_FILE

    def __init__(self, window) -> None:
        super().__init__(window)
        self.continue_button = self.builder.get_object("continue_button")  # type: Gtk.Button
        self.device_not_supported_label = self.builder.get_object(
            "device_not_supported_label"
        )  # type: Gtk.Box
        self.warning_icon = self.builder.get_object("warning_icon")  # type: Gtk.Image

    def show(self) -> None:
        super().show()

        # Check if the boot device is supported
        variant = self.window.service_proxy.get_cached_property("BootDeviceIsSupported")
        device_is_supported = bool(variant and variant.get_boolean())

        if not device_is_supported:
            error: GLib.Variant = self.window.service_proxy.get_cached_property("Error")
            if error:
                error_type = InvalidBootDeviceErrorType(error.get_uint32())
                logger.warning("Error: %s", error_type)
                if error_type == InvalidBootDeviceErrorType.TOO_MANY_PARTITIONS:
                    self.device_not_supported_label.set_label(
                        _(
                            "Sorry, it is impossible to create a Persistent Storage "
                            "because there is already a second partition "
                            "on the USB stick.\n\n"
                            "To be able to use Tails with a Persistent Storage, "
                            "please try to follow our instructions on "
                            '<a href="install">installing Tails on a USB stick</a> '
                            "again.",
                        ),
                    )
                elif (
                    error_type
                    == InvalidBootDeviceErrorType.UNSUPPORTED_INSTALLATION_METHOD
                ):
                    logger.warning(
                        "You can only create a Persistent Storage on a USB stick "
                        "installed with a USB image or Tails Cloner.",
                    )

        if device_is_supported:
            self.continue_button.grab_focus()

        self.device_not_supported_label.set_visible(not device_is_supported)
        self.warning_icon.set_visible(not device_is_supported)
        self.continue_button.set_visible(device_is_supported)

    def on_cancel_button_clicked(self, button: Gtk.Button):
        self.window.destroy()

    def on_activate_link(self, label: Gtk.Label, uri: str):
        self.window.open_documentation(uri)
        return True

    def on_continue_button_clicked(self, button: Gtk.Button):
        self.window.passphrase_view.show()
