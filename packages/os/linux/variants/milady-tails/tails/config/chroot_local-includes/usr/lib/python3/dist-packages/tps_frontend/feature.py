import contextlib
import logging
import os
import re
from typing import TYPE_CHECKING

from tps.dbus.errors import DBusError, SymlinkSourceDirectoryError, TargetIsBusyError

from tps_frontend import (
    DBUS_FEATURE_INTERFACE,
    DBUS_FEATURES_PATH,
    DBUS_JOB_INTERFACE,
    DBUS_SERVICE_NAME,
    _,
    CUSTOM_FEATURE_UI_FILE,
)

import gi

from tps_frontend.error_dialog import ErrorDetails

gi.require_version("Handy", "1")
from gi.repository import Gio, GLib, GObject, Gtk, Handy  # noqa: E402

if TYPE_CHECKING:
    from gi.repository import Atk

    from tps_frontend.window import Window

logger = logging.getLogger(__name__)


class Feature:
    @property
    def dbus_object_name(self) -> str:
        """The name of the D-Bus object representing this feature

        By default, the class name is used. Features for which
        the class name does not correspond with the D-Bus object
        can override this property."""
        return self.__class__.__name__

    @property
    def widget_name_prefix(self) -> str:
        """The string which widgets of this feature are prefixed with.
        By default, the class name converted to snake_case is used."""
        return camel_to_snake(self.__class__.__name__)

    @property
    def widgets_to_show_while_active(self) -> list[Gtk.Widget]:
        return []

    def __init__(self, window: "Window", builder: Gtk.Builder, bus: Gio.DBusConnection):
        logger.debug(f"Initializing feature {self.__class__.__name__}")
        self.window = window
        self.builder = builder
        self.object_path = os.path.join(DBUS_FEATURES_PATH, self.dbus_object_name)
        self.proxy = Gio.DBusProxy.new_sync(
            bus,
            Gio.DBusProxyFlags.NONE,
            None,
            DBUS_SERVICE_NAME,
            self.object_path,
            DBUS_FEATURE_INTERFACE,
            None,
        )  # type: Gio.DBusProxy
        self._ignore_switch_state_change = False

        self.is_enabled = self.proxy.get_cached_property("IsEnabled").get_boolean()
        self.is_active = self.proxy.get_cached_property("IsActive").get_boolean()
        self.has_data = self.proxy.get_cached_property("HasData").get_boolean()

        # Connect to properties-changed signal
        self.proxy.connect("g-properties-changed", self.on_properties_changed)

        box_name = self.widget_name_prefix + "_box"
        self.box = self.builder.get_object(box_name)  # type: Gtk.Box
        if not self.box:
            raise RuntimeError(f"Could not find {box_name}")

        action_row_name = self.widget_name_prefix + "_row"
        self.action_row: Handy.ActionRow = self.builder.get_object(
            action_row_name,
        )
        self.action_row.__setattr__("original_subtitle", self.action_row.get_subtitle())
        if not self.action_row:
            raise RuntimeError(f"Could not find {action_row_name}")

        self.name = self.dbus_object_name
        self.translated_name = self.action_row.get_title()

        # Add the delete data button
        self.delete_data_button = Gtk.Button(
            label=_("Delete Data…"),
            valign="center",
        )
        atk: Atk.Object = self.delete_data_button.get_accessible()
        # Translators: Don't translate {feature}, it's a placeholder
        # and will be replaced.
        atk.set_name(_("Delete {feature} data").format(feature=self.translated_name))
        self.delete_data_button.connect("clicked", self.on_delete_data_button_clicked)
        Gtk.StyleContext.add_class(
            self.delete_data_button.get_style_context(),
            "destructive-action",
        )
        self.box.add(self.delete_data_button)
        self.box.reorder_child(self.delete_data_button, 0)

        # Change style context of the subtitle label of the HdyActionRow
        self.subtitle_label = (
            self.action_row.get_child().get_children()[2].get_children()[1]
        )
        self.subtitle_style_context = self.subtitle_label.get_style_context()
        Gtk.StyleContext.add_class(self.subtitle_style_context, "caption")
        Gtk.StyleContext.remove_class(self.subtitle_style_context, "subtitle")

        self.spinner = Gtk.Spinner()  # type: Gtk.Spinner
        self.warning_icon = Gtk.Image(
            icon_name="gtk-dialog-warning",
            icon_size=Gtk.IconSize.LARGE_TOOLBAR,
            visible=True,
            tooltip_text=_("Activation failed"),
        )

        switch_name = self.widget_name_prefix + "_switch"
        self.switch = self.builder.get_object(switch_name)  # type: Gtk.Switch
        if self.switch is None:
            raise RuntimeError(f"Could not find {switch_name}")

        self.switch.connect("state-set", self.on_state_set)
        # Yes, it's confusing that we set the GtkSwitch.active property
        # to the value of the Feature.IsEnabled property and the
        # GtkSwitch.state property to the value of the Feature.IsActive
        # property, but that's what we want: We want the switch to be
        # in the on position (i.e. GtkSwitch.active == True) when the
        # feature is enabled in the config file and we want it's
        # underlying state (blue or gray color) to represent whether
        # the feature is currently active.
        self.switch.set_state(self.is_active)
        self.switch.set_active(self.is_enabled)
        self.switch.connect("notify::active", self.on_is_enabled_changed)

        self.refresh_ui()

        self.dialog = None

    def show_spinner(self):
        if self.spinner not in self.box.get_children():
            self.box.add(self.spinner)
            # Ensure that the spinner is the first widget in the box
            self.box.reorder_child(self.spinner, 0)
        self.spinner.start()
        self.spinner.set_visible(True)

    def hide_spinner(self):
        if self.spinner in self.box.get_children():
            self.box.remove(self.spinner)

    def show_warning_icon(self):
        if self.warning_icon not in self.box.get_children():
            self.box.add(self.warning_icon)
            # Ensure that the warning icon is the first widget in the box
            self.box.reorder_child(self.warning_icon, 0)

    def hide_warning_icon(self):
        if self.warning_icon in self.box.get_children():
            self.box.remove(self.warning_icon)

    def refresh_ui(self):
        error = self.is_enabled and not self.is_active

        if error:
            self.show_warning_icon()
        else:
            self.hide_warning_icon()

        if error and self.has_data:
            subtitle = _("Activation failed. Try again or delete data.")
        elif error:
            subtitle = _("Activation failed. Try again.")
        elif self.has_data and not self.is_enabled:
            subtitle = _("The data of this feature is still saved.")
        else:
            subtitle = self.action_row.original_subtitle

        if error:
            Gtk.StyleContext.add_class(self.subtitle_style_context, "error")
            self.subtitle_label.set_selectable(True)
        else:
            Gtk.StyleContext.remove_class(self.subtitle_style_context, "error")
            self.subtitle_label.set_selectable(False)

        self.action_row.set_subtitle(subtitle)

        show_delete_data_button = self.has_data and not self.is_enabled
        self.delete_data_button.set_visible(show_delete_data_button)

    def on_state_set(self, switch: Gtk.Switch, state: bool):
        # We return True here to prevent the default handler from
        # running, which would sync the "state" property with the
        # "active" property. We don't want this, because we want to set
        # "state" only to True when the feature was activated
        # successfully.
        # See https://developer.gnome.org/gtk3/stable/GtkSwitch.html#GtkSwitch-state-set
        return True

    def on_is_enabled_changed(self, switch: Gtk.Switch, pspec: GObject.ParamSpec):
        is_enabled = self.proxy.get_cached_property("IsEnabled").get_boolean()

        if self._ignore_switch_state_change:
            return
        if switch.get_active() == is_enabled:
            # The feature is already enabled.
            return
        if switch.get_active():
            self.activate()
        else:
            self.deactivate()

    def activate(self):
        logger.debug(f"Activating feature {self.name}")
        self.show_spinner()
        self.delete_data_button.hide()

        # Create a cancellable that can be used to cancel the activation job
        self.cancellable = Gio.Cancellable()

        self.proxy.call(
            method_name="Activate",
            parameters=None,
            flags=Gio.DBusCallFlags.NONE,
            timeout_msec=GLib.MAXINT,
            cancellable=self.cancellable,
            callback=self.on_activate_call_finished,
        )

    def deactivate(self):
        logger.debug(f"Deactivating feature {self.name}")
        self.show_spinner()

        # Already hide the widgets when we start deactivating the
        # feature, to:
        # * avoid races when the user clicks a widget and the action is
        #   only done when the feature is already deactivated
        # * avoid that showing the spinner causes the widgets to move
        for widget in self.widgets_to_show_while_active:
            widget.hide()

        # Create a cancellable that can be used to cancel the activation job
        self.cancellable = Gio.Cancellable()

        self.proxy.call(
            method_name="Deactivate",
            parameters=None,
            flags=Gio.DBusCallFlags.NONE,
            timeout_msec=GLib.MAXINT,
            cancellable=self.cancellable,
            callback=self.on_deactivate_call_finished,
        )

    def on_activate_call_finished(self, proxy: Gio.DBusProxy, res: Gio.AsyncResult):
        self.hide_spinner()

        if self.dialog:
            self.dialog.destroy()
            self.dialog = None
        try:
            proxy.call_finish(res)
        except GLib.Error as e:
            logger.error(f"Error activating feature {self.name}: {e.message}")

            if e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED):
                # The operation was cancelled by the user, so we cancel
                # the job of the backend.
                self.backend_job.call_sync(
                    method_name="Cancel",
                    parameters=None,
                    flags=Gio.DBusCallFlags.NONE,
                    timeout_msec=-1,
                    cancellable=None,
                )
            elif SymlinkSourceDirectoryError.is_instance(e):
                # The user did not create the source directory of a
                # feature that uses symlinks.
                # This is an expected error which we don't want error
                # reports for.
                SymlinkSourceDirectoryError.strip_remote_error(e)
                self.window.display_error(
                    _("Error activating feature {}").format(self.translated_name),
                    e.message,
                    with_send_report_button=False,
                )
            else:
                DBusError.strip_remote_error(e)
                self.window.display_error(
                    _("Error activating feature {}").format(self.translated_name),
                    _("An error occurred while activating the feature."),
                    details=(ErrorDetails(_("Details"), e.message)),
                )

            # Ensure that the switch displays the correct state
            is_enabled = self.proxy.get_cached_property("IsEnabled").get_boolean()
            self.switch.set_active(is_enabled)
            # Refresh the UI because we hid the delete button when we
            # started the activation and we might have to show it again
            self.refresh_ui()
            return

        logger.debug(f"Feature {self.name} successfully activated")

    def on_deactivate_call_finished(self, proxy: Gio.DBusProxy, res: Gio.AsyncResult):
        self.hide_spinner()

        if self.dialog:
            self.dialog.destroy()
            self.dialog = None
        try:
            proxy.call_finish(res)
        except GLib.Error as e:
            logger.error(f"Error deactivating feature {self.name}: {e.message}")

            if e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED):
                # The operation was cancelled by the user, so we cancel
                # the job of the backend.
                self.backend_job.call_sync(
                    method_name="Cancel",
                    parameters=None,
                    flags=Gio.DBusCallFlags.NONE,
                    timeout_msec=-1,
                    cancellable=None,
                )
            elif TargetIsBusyError.is_instance(e):
                # Some process is still accessing the target. This is
                # an expected error which we don't want error reports
                # for.
                TargetIsBusyError.strip_remote_error(e)
                self.window.display_error(
                    _("Error deactivating feature {}").format(self.translated_name),
                    e.message,
                    with_send_report_button=False,
                )
            else:
                DBusError.strip_remote_error(e)
                self.window.display_error(
                    _("Error deactivating feature {}").format(self.translated_name),
                    _("An error occurred while deactivating the feature."),
                    details=(ErrorDetails(_("Details"), e.message)),
                )

            # Ensure that the switch displays the correct state
            is_enabled = self.proxy.get_cached_property("IsEnabled").get_boolean()
            self.switch.set_active(is_enabled)

            # We hid the widgets in the deactivate() function, so ensure
            # that they now have the correct visibility
            is_active = self.proxy.get_cached_property("IsActive").get_boolean()
            for widget in self.widgets_to_show_while_active:
                widget.set_visible(is_active)

            return

        logger.debug(f"Feature {self.name} successfully deactivated")

    def on_delete_data_button_clicked(self, button: Gtk.Button):
        msg = _(
            "Delete all the data of the {} feature that is saved in the Persistent Storage?\n\n"
            "If you cancel, the data will be restored when you turn this feature on again.",
        ).format(self.translated_name)
        self.dialog = Gtk.MessageDialog(
            self.window,
            Gtk.DialogFlags.MODAL | Gtk.DialogFlags.DESTROY_WITH_PARENT,
            Gtk.MessageType.WARNING,
            Gtk.ButtonsType.NONE,
            msg,
        )
        self.dialog.add_button(_("Cancel"), Gtk.ResponseType.CANCEL)
        self.dialog.add_button(_("_Delete Data"), Gtk.ResponseType.OK)
        self.dialog.set_default_response(Gtk.ResponseType.CANCEL)
        button = self.dialog.get_widget_for_response(Gtk.ResponseType.OK)
        style_context = button.get_style_context()
        style_context.add_class("destructive-action")
        result = self.dialog.run()  # type: Gtk.ResponseType
        self.dialog.destroy()
        if result != Gtk.ResponseType.OK:
            return

        self.show_spinner()
        self.delete_data_button.hide()
        self.proxy.call(
            method_name="Delete",
            parameters=None,
            flags=Gio.DBusCallFlags.NONE,
            timeout_msec=GLib.MAXINT,
            cancellable=None,
            callback=self.on_delete_call_finished,
        )

    def on_delete_call_finished(self, proxy: Gio.DBusProxy, res: Gio.AsyncResult):
        self.hide_spinner()

        try:
            proxy.call_finish(res)
        except GLib.Error as e:
            DBusError.strip_remote_error(e)
            logger.error(f"Error deleting data of feature {self.name}: {e.message}")
            self.window.display_error(
                _("Error deleting data of feature {}").format(self.translated_name),
                _("An error occurred while deleting the data of feature {}.").format(
                    self.translated_name,
                ),
                details=(ErrorDetails(_("Details"), e.message)),
            )
            return
        finally:
            self.refresh_ui()

        logger.debug(f"Data of feature {self.name} successfully deleted")

    def on_properties_changed(
        self,
        proxy: Gio.DBusProxy,
        changed_properties: GLib.Variant,
        invalidated_properties: list[str],
    ):
        logger.debug("changed properties: %s", changed_properties)
        keys = set(changed_properties.keys())

        if "IsEnabled" in keys:
            self.is_enabled = changed_properties["IsEnabled"]
            self.switch.set_active(self.is_enabled)

        if "IsActive" in keys:
            self.is_active = changed_properties["IsActive"]

            with self.ignore_switch_state_change():
                self.switch.set_state(changed_properties["IsActive"])
                # Calling Gtk.Switch.set_state also sets the
                # Gtk.Switch.active property, which defines if the
                # switch is in the on/off position. We only want to
                # change the underlying state here, so we set the
                # Gtk.Switch.active property according to the IsEnabled
                # property again.
                if self.is_active != self.is_enabled:
                    self.switch.set_active(self.is_enabled)

            for widget in self.widgets_to_show_while_active:
                widget.set_visible(changed_properties["IsActive"])

            self.hide_spinner()

        if "HasData" in keys:
            self.has_data = changed_properties["HasData"]

        if keys.intersection({"IsEnabled", "IsActive", "HasData"}):
            self.refresh_ui()

        if "Job" in keys:
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

            self.backend_job.connect(
                "g-properties-changed",
                self.on_job_properties_changed,
            )

            self.handle_conflicting_apps()

    def on_job_properties_changed(
        self,
        proxy: Gio.DBusProxy,
        changed_properties: GLib.Variant,
        invalidated_properties: list[str],
    ):
        logger.debug("changed job properties: %s", changed_properties)
        if "ConflictingApps" in changed_properties.keys():  # noqa: SIM118
            self.handle_conflicting_apps()

    def handle_conflicting_apps(self):
        apps_variant: GLib.Variant = self.backend_job.get_cached_property(
            "ConflictingApps"
        )
        if apps_variant is None:
            return

        # Unpack the GLib.Variant
        apps: dict[str, list[int]] = apps_variant.unpack()
        if not apps:
            return

        # Show the conflicting apps message dialog
        self.dialog = Gtk.MessageDialog(
            self.window,
            Gtk.DialogFlags.MODAL | Gtk.DialogFlags.DESTROY_WITH_PARENT,
            Gtk.MessageType.INFO,
            Gtk.ButtonsType.CANCEL,
            self.get_conflicting_apps_message(apps),
        )
        result = self.dialog.run()  # type: Gtk.ResponseType
        if result == Gtk.ResponseType.CANCEL:
            self.dialog.destroy()
            self.cancellable.cancel()

    def get_conflicting_apps_message(self, apps: dict[str, list[int]]):
        app_reprs = [self.app_repr_string(app, apps[app]) for app in apps]
        # Translators: Don't translate {applications}, it's a placeholder
        return _("Close {applications} to continue").format(
            applications=_(" and ").join(app_reprs),
        )

    @staticmethod
    def app_repr_string(app: str, pids: list[int]):
        # We list each app with the conflicting PIDs. The app names are
        # already translated.
        if len(pids) == 1:
            pid = str(pids[0])
            # Translators: Don't translate {app} and {pid}, they
            # are placeholders.
            return _("{app} (PID: {pid})").format(app=app, pid=pid)

        pids_repr = ", ".join(str(pid) for pid in pids)
        # Translators: Don't translate {app} and {pids}, they
        # are placeholders.
        return _("{app} (PIDs: {pids})").format(app=app, pids=pids_repr)

    @contextlib.contextmanager
    def ignore_switch_state_change(self):
        try:
            self._ignore_switch_state_change = True
            yield
        finally:
            self._ignore_switch_state_change = False


@Gtk.Template.from_file(CUSTOM_FEATURE_UI_FILE)
class CustomFeatureRow(Handy.ActionRow):
    __gtype_name__ = "CustomFeatureRow"

    def __init__(self, title: str):
        super().__init__()
        self.set_title(title)


def camel_to_snake(name):
    """From https://stackoverflow.com/a/1176023
    Original authors:
    epost (https://stackoverflow.com/users/129879/epost)
    Zarathustra (https://stackoverflow.com/users/1248724/zarathustra)
    danijar (https://stackoverflow.com/users/1079110/danijar)"""
    name = re.sub("(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub("([a-z0-9])([A-Z])", r"\1_\2", name).lower()
