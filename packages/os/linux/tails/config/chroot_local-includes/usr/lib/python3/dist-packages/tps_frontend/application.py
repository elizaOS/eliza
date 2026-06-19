from logging import getLogger
import tempfile
import json
from gi.repository import Gdk, Gio, GLib, Gtk
from typing import Optional

from tps_frontend import (
    _,
    DBUS_SERVICE_NAME,
    DBUS_ROOT_OBJECT_PATH,
    DBUS_SERVICE_INTERFACE,
    APPLICATION_ID,
    CSS_FILE,
)
from tps_frontend.window import Window

logger = getLogger(__name__)


class Application(Gtk.Application):
    def __init__(self, bus: Gio.DBusConnection):
        logger.debug("Initializing Application")
        self.bus = bus
        self.window = None

        super().__init__(
            application_id=APPLICATION_ID,
            flags=Gio.ApplicationFlags.FLAGS_NONE,
        )
        GLib.set_application_name(_("Persistent Storage"))

        # Initialize style
        style_provider = Gtk.CssProvider()
        style_provider.load_from_path(CSS_FILE)
        # noinspection PyArgumentList
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            style_provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )

        # Initialize the D-Bus proxy
        try:
            self.service_proxy = Gio.DBusProxy.new_sync(
                bus,
                Gio.DBusProxyFlags.NONE,
                None,
                DBUS_SERVICE_NAME,
                DBUS_ROOT_OBJECT_PATH,
                DBUS_SERVICE_INTERFACE,
                None,
            )  # type: Gio.DBusProxy
        except GLib.Error as e:
            logger.error(f"Failed to create D-Bus proxy: {e.message}")
            self.display_error(
                _("Failed to start the Persistent Storage service"),
            )
            raise

    def do_activate(self):
        if not self.window:
            self.window = Window(self, self.bus)
            self.window.set_default_icon_name("persistent-storage")

        self.add_window(self.window)
        self.window.present()

    def launch_whisperback(
        self,
        error_summary: str = "PersistentStorage",
        error_report_msg: Optional[str] = None,
    ) -> None:
        # Get the WhisperBack app
        # noinspection PyArgumentList
        apps = [a for a in Gio.AppInfo.get_all() if a.get_executable() == "whisperback"]
        if not apps:
            logger.error("Could not find whisperback app")
            self.display_error(
                _("Error"),
                _("Could not find the WhisperBack application"),
                with_send_report_button=False,
            )
        app = apps[0]  # type: Gtk.AppInfo

        prefill_data = {
            "app": "tps_frontend",
            "summary": error_summary,
        }
        if error_report_msg is not None:
            prefill_data["details"] = error_report_msg
        prefill_tmp = tempfile.NamedTemporaryFile(mode="w", delete=False)
        json.dump(prefill_data, prefill_tmp.file)
        # noinspection PyArgumentList
        display = Gdk.Display.get_default()  # type: Gdk.Display
        launch_context = display.get_app_launch_context()  # type: Gdk.AppLaunchContext
        launch_context.set_timestamp(Gtk.get_current_event_time())
        app.launch([Gio.File.new_for_path(prefill_tmp.name)], launch_context)
