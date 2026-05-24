# ruff: noqa: E402
import os.path

import inspect
from logging import getLogger
from typing import TYPE_CHECKING

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gdk, Gio, Gtk

from tps_frontend import (
    FEATURES_VIEW_UI_FILE,
    DBUS_FEATURES_PATH,
    DBUS_SERVICE_NAME,
    DBUS_FEATURE_INTERFACE,
    ICON_DIR,
)
from tps_frontend.view import View
from tps_frontend.feature import Feature, CustomFeatureRow

if TYPE_CHECKING:
    from tps_frontend.window import Window

logger = getLogger(__name__)


class PersistentDirectory(Feature):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.open_button = self.builder.get_object("persistent_directory_open_button")  # type: Gtk.Button
        self.open_button.set_visible(self.switch.get_state())

    @property
    def widgets_to_show_while_active(self) -> list[Gtk.Widget]:
        return [self.open_button]


class BrowserBookmarks(Feature):
    pass


class MiladyData(Feature):
    pass


class WelcomeScreen(Feature):
    pass


class Printers(Feature):
    pass


class NetworkConnections(Feature):
    pass


class TorConfiguration(Feature):
    pass


class Electrum(Feature):
    pass


class Thunderbird(Feature):
    pass


class GnuPG(Feature):
    widget_name_prefix = "gnupg"


class Pidgin(Feature):
    pass


class SSHClient(Feature):
    pass


class AdditionalSoftware(Feature):
    pass


class Dotfiles(Feature):
    pass


def get_feature_classes():
    return [
        g for g in globals().values() if inspect.isclass(g) and Feature in g.__bases__
    ]


class FeaturesView(View):
    _ui_file = FEATURES_VIEW_UI_FILE

    def __init__(self, window: "Window", bus: Gio.DBusConnection):
        super().__init__(window)
        self.bus = bus
        self.object_manager = Gio.DBusObjectManagerClient.new_sync(
            bus,
            Gio.DBusObjectManagerClientFlags.NONE,
            DBUS_SERVICE_NAME,
            DBUS_FEATURES_PATH,
            None,
            None,
            None,
        )  # type: Gio.DBusObjectManagerClient
        self.features = list()

        # Append all non-default paths that contain icons to the search
        # paths
        # noinspection PyArgumentList
        icon_theme = Gtk.IconTheme.get_default()  # type: Gtk.IconTheme
        icon_theme.append_search_path(ICON_DIR)
        icon_theme.append_search_path("/usr/share/pixmaps/cryptui/48x48")

        # Set listbox header functions. This is required to add
        # separators between listboxrows.
        for listbox_name in [
            "personal_data_list_box",
            "system_settings_list_box",
            "network_list_box",
            "applications_list_box",
            "advanced_settings_list_box",
            "custom_features_list_box",
        ]:
            listbox = self.builder.get_object(listbox_name)  # type: Gtk.ListBox
            listbox.set_header_func(self.add_separator)

        # Show custom features
        self.custom_features_box = self.builder.get_object("custom_features_box")  # type: Gtk.Box
        self.custom_features_list_box = self.builder.get_object(
            "custom_features_list_box"
        )  # type: Gtk.ListBox
        dbus_objects = self.object_manager.get_objects()  # type: list[Gio.DBusObjectProxy]
        for obj in dbus_objects:
            path = obj.get_object_path()
            if os.path.basename(path).startswith("CustomFeature"):
                # It should be possible to get the proxy from the
                # DBusObject instead via get_interface() but for some
                # reason that only returns None.
                proxy = Gio.DBusProxy.new_sync(
                    bus,
                    Gio.DBusProxyFlags.NONE,
                    None,
                    DBUS_SERVICE_NAME,
                    path,
                    DBUS_FEATURE_INTERFACE,
                    None,
                )  # type: Gio.DBusProxy
                self.add_custom_feature(proxy)

    def show(self):
        super().show()
        if not self.features:
            self.features = [
                c(self.window, self.builder, self.bus) for c in get_feature_classes()
            ]
        # Show the change passphrase button
        self.window.change_passphrase_button.show()
        self.window.delete_button.show()

    def on_hide(self):
        self.window.change_passphrase_button.hide()
        self.window.delete_button.hide()

    def add_separator(self, row, before):
        if not before:
            row.set_header(None)
        elif not row.get_header():
            row.set_header(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))

    def on_persistent_directory_open_button_clicked(self, button: Gtk.Button):
        # noinspection PyArgumentList
        display = Gdk.Display.get_default()  # type: Gdk.Display
        launch_context = display.get_app_launch_context()  # type: Gdk.AppLaunchContext
        launch_context.set_timestamp(Gtk.get_current_event_time())
        # noinspection PyArgumentList
        Gio.AppInfo.launch_default_for_uri(
            "file:///home/amnesia/Persistent",
            context=launch_context,
        )

    def on_additional_software_button_clicked(self, button: Gtk.Button):
        # noinspection PyArgumentList
        display = Gdk.Display.get_default()  # type: Gdk.Display
        launch_context = display.get_app_launch_context()  # type: Gdk.AppLaunchContext
        launch_context.set_timestamp(Gtk.get_current_event_time())
        # noinspection PyArgumentList
        # We use an absolute path, so qa-tails-20745-ok
        app = Gio.DesktopAppInfo.new_from_filename(
            "/usr/share/applications/org.boum.tails.AdditionalSoftware.desktop"
        )
        app.launch(context=launch_context)

    def on_activate_link(self, label: Gtk.Label, uri: str):
        self.window.open_documentation(uri)
        return True

    def on_activate_link_button(self, link_button: Gtk.LinkButton):
        self.window.open_documentation(link_button.get_uri())
        return True

    def add_custom_feature(self, proxy: Gio.DBusObject):
        description = proxy.get_cached_property("Description").get_string()
        row = CustomFeatureRow(title=description)
        self.custom_features_list_box.add(row)
        self.custom_features_box.show_all()
