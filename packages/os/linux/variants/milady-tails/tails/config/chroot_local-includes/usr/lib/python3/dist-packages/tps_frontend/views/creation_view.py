from logging import getLogger
from gi.repository import Gio, GLib, Gtk
from typing import TYPE_CHECKING

from tps_frontend import CREATION_VIEW_UI_FILE, DBUS_SERVICE_NAME, DBUS_JOB_INTERFACE
from tps_frontend.view import View

if TYPE_CHECKING:
    from tps_frontend.window import Window

logger = getLogger(__name__)


class CreationView(View):
    _ui_file = CREATION_VIEW_UI_FILE

    def __init__(self, window: "Window"):
        super().__init__(window)
        self.backend_job = None
        self.status_label = self.builder.get_object("creation_status_label")  # type: Gtk.Label
        self.progress_bar = self.builder.get_object("creation_progress_bar")  # type: Gtk.ProgressBar

        # Connect to properties-changed signal
        self.window.service_proxy.connect(
            "g-properties-changed", self.on_properties_changed
        )

    def on_properties_changed(
        self,
        proxy: Gio.DBusProxy,
        changed_properties: GLib.Variant,
        invalidated_properties: list[str],
    ):
        if "Job" not in changed_properties.keys():
            return

        job_path = changed_properties["Job"]
        # noinspection PyArgumentList
        self.backend_job = Gio.DBusProxy.new_sync(
            connection=proxy.get_connection(),
            flags=Gio.DBusProxyFlags.NONE,
            info=None,
            name=DBUS_SERVICE_NAME,
            object_path=job_path,
            interface_name=DBUS_JOB_INTERFACE,
            cancellable=None,
        )  # type: Gio.DBusProxy

        status_variant = self.backend_job.get_cached_property("Status")
        if status_variant is not None:
            self.set_status(status_variant.get_string())

        progress_variant = self.backend_job.get_cached_property("Progress")
        if progress_variant is not None:
            self.set_progress(progress_variant.get_uint32())

        self.backend_job.connect("g-properties-changed", self.on_job_properties_changed)

    def on_job_properties_changed(
        self,
        proxy: Gio.DBusProxy,
        changed_properties: GLib.Variant,
        invalidated_properties: list[str],
    ):
        if "Status" in changed_properties.keys():
            self.set_status(changed_properties["Status"])
        if "Progress" in changed_properties.keys():
            self.set_progress(changed_properties["Progress"])

    def set_status(self, status: str):
        self.status_label.set_label(status)

    def set_progress(self, progress: int):
        self.progress_bar.set_fraction(progress / 100)
