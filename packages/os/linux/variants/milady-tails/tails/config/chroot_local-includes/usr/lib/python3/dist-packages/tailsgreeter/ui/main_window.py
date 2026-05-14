#
# Copyright 2015-2016 Tails developers <foundations@tails.net>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>

import json
import logging
import os
import subprocess
import threading
from typing import TYPE_CHECKING

import gi

import tailsgreeter  # NOQA: E402
from tailsgreeter import (
    TRANSLATION_DOMAIN,
    config,  # NOQA: E402
)
from tailsgreeter.config import persistent_settings_dir
from tailsgreeter.errors import (
    FeatureActivationFailedError,
    FilesystemErrorsLeftUncorrectedError,
    IOErrorsDetectedError,
    PersistentStorageError,
    WrongPassphraseError,
)
from tailsgreeter.settings import SettingNotFoundError
from tailsgreeter.translatable_window import TranslatableWindow
from tailsgreeter.ui.popover import Popover
from tailsgreeter.ui import _
from tailsgreeter.ui.add_settings_dialog import AddSettingsDialog
from tailsgreeter.ui.additional_settings import AdditionalSetting
from tailsgreeter.ui.help_window import GreeterHelpWindow
from tailsgreeter.ui.message_dialog import MessageDialog
from tailsgreeter.ui.region_settings import LocalizationSettingUI
from tailsgreeter.utils import glib_idle_add_once
from tailslib import LIVE_USERNAME
from tailslib.persistence import is_tails_media_writable
from tps import InvalidBootDeviceErrorType

gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
gi.require_version("Handy", "1")
from gi.repository import Gdk, Gio, GLib, Gtk, Handy  # noqa: E402

Handy.init()

if TYPE_CHECKING:
    from tailsgreeter.greeter import GreeterApplication
    from tailsgreeter.settings.persistence import PersistentStorageSettings
    from tailsgreeter.ui.settings_collection import GreeterSettingsCollection


MAIN_UI_FILE = "main.ui"
CSS_FILE = "greeter.css"
ICON_DIR = "icons/"
PREFERRED_WIDTH = 620
PREFERRED_HEIGHT = 470


class GreeterMainWindow(Gtk.Window, TranslatableWindow):
    def __init__(
        self,
        greeter: "GreeterApplication",
        persistence_setting: "PersistentStorageSettings",
        settings: "GreeterSettingsCollection",
    ):
        Gtk.Window.__init__(self, title=_(tailsgreeter.APPLICATION_TITLE))
        TranslatableWindow.__init__(self, self)
        self.greeter = greeter
        self.persistence_setting = persistence_setting
        self.settings = settings

        # Set the main_window attribute for the settings. This is required
        # in order to allow the settings to trigger changes in the main
        # window, for example showing an info bar.
        for setting in self.settings:
            setting.main_window = self

        self.connect("delete-event", self.cb_window_delete_event, None)
        self.set_position(Gtk.WindowPosition.CENTER)

        # Load custom CSS
        css_provider = Gtk.CssProvider()
        css_provider.load_from_path(config.data_path + CSS_FILE)
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            css_provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )

        # Load UI interface definition
        builder = Gtk.Builder()
        builder.set_translation_domain(TRANSLATION_DOMAIN)
        builder.add_from_file(config.data_path + MAIN_UI_FILE)
        builder.connect_signals(self)

        for widget in builder.get_objects():
            # Store translations for the builder objects
            self.store_translations(widget)
            # Workaround Gtk bug #710888 - GtkInfoBar not shown after calling
            # gtk_widget_show:
            # https://bugzilla.gnome.org/show_bug.cgi?id=710888
            if isinstance(widget, Gtk.InfoBar):
                revealer = widget.get_template_child(Gtk.InfoBar, "revealer")
                revealer.set_transition_type(Gtk.RevealerTransitionType.NONE)

        self.box_language = builder.get_object("box_language")
        self.box_language_header = builder.get_object("box_language_header")
        self.box_main = builder.get_object("box_main")
        self.box_settings = builder.get_object("box_settings")
        self.box_settings_header = builder.get_object("box_settings_header")
        self.box_settings_values = builder.get_object("box_settings_values")
        self.box_storage = builder.get_object("box_storage")
        self.box_storage_unlock = builder.get_object("box_storage_unlock")
        self.box_storage_unlock_status = builder.get_object("box_storage_unlocked")
        self.entry_storage_passphrase = builder.get_object("entry_storage_passphrase")
        self.button_storagecreate_create = builder.get_object(
            "button_storagecreate_create",
        )
        self.box_create_tps = builder.get_object("create_tps_box")

        self.frame_language = builder.get_object("frame_language")
        self.infobar_settings_loaded = builder.get_object("infobar_settings_loaded")
        self.label_settings_default = builder.get_object("label_settings_default")
        self.listbox_add_setting = builder.get_object("listbox_add_setting")
        self.listbox_settings = builder.get_object("listbox_settings")
        self.toolbutton_settings_add = builder.get_object("toolbutton_settings_add")
        self.listbox_settings = builder.get_object("listbox_settings")
        self.listbox_region = builder.get_object("listbox_region")
        self.region_save_switch = builder.get_object("save_language_keyboard_switch")
        self.button_start = builder.get_object("button_start")
        self.headerbar = builder.get_object("headerbar")

        # Set preferred width
        self.set_default_size(
            min(Gdk.Screen.get_default().get_width(), PREFERRED_WIDTH),
            min(Gdk.Screen.get_default().get_height(), PREFERRED_HEIGHT),
        )
        self.set_valign(Gtk.Align.START)

        # Add our icon dir to icon theme
        icon_theme = Gtk.IconTheme.get_default()
        icon_theme.prepend_search_path(config.data_path + ICON_DIR)

        # Add placeholder to settings ListBox
        self.listbox_settings.set_placeholder(self.label_settings_default)

        # Add children to ApplicationWindow
        self.add(self.box_main)
        self.set_titlebar(self.headerbar)

        # Set keyboard focus chain
        self._set_focus_chain()

        # Add settings to region listbox
        for setting in self.settings.region_settings:
            logging.debug("Adding '%s' to region listbox", setting.name)
            self.listbox_region.add(setting.listboxrow)

        # Add settings dialog - it's a TranslatableWindow, so it must be created early
        # see TranslatableWindow doc for details
        self.dialog_add_setting = AddSettingsDialog(builder, self.settings)
        self.dialog_add_setting.set_transient_for(self)

        # Confirm dialog - must be created early, see MessageDialog docstring why
        self.confirm_dialog = MessageDialog(
            message_type=Gtk.MessageType.WARNING,
            title=_("Persistent Storage Still Locked"),
            text=_(
                "Do you really want to start Tails without unlocking your Persistent Storage?",
            ),
            cancel_label=_("Cancel"),
            ok_label=_("Start Without Persistent Storage"),
        )
        self.confirm_dialog.set_transient_for(self)

        # Save unencrypted dialog - must be created early, see MessageDialog docstring why
        self.save_unencrypted_dialog = MessageDialog(
            message_type=Gtk.MessageType.QUESTION,
            title=_("Language and Keyboard layout"),
            text=_(
                "Your language and keyboard layout will be saved unencrypted "
                "on your Tails USB stick and applied automatically in the future.\n\n"
                "Someone who finds your Tails USB stick can see your language and keyboard layout.",
            ),
            cancel_label=_("Cancel"),
            ok_label=_("Save Unencrypted"),
            destructive=False,
        )

        # Setup keyboard accelerators
        self._build_accelerators()

        self.store_translations(self)

        # Region

        for setting in [
            self.greeter.localisationsettings.keyboard,
            self.greeter.localisationsettings.language,
        ]:
            setting.connect(
                "notify::saveEnabled",
                self.cb_language_or_keyboard_loaded_changed,
            )
            self.cb_language_or_keyboard_loaded_changed(
                setting,
                None,
                user_data="__init__",
            )

        if not is_tails_media_writable():
            self.region_save_switch.set_sensitive(False)

        # Persistent Storage
        self.tps_upgrade_failed = False

        self.box_storage = builder.get_object("box_storage")
        self.box_storagecreate = builder.get_object("box_storagecreate")
        self.create_tps_switch = builder.get_object("create_tps_switch")
        self.box_storage_unlock = builder.get_object("box_storage_unlock")
        self.box_storage_unlock_status = builder.get_object("box_storage_unlock_status")
        self.label_storage_unlock_status = builder.get_object(
            "label_storage_unlock_status",
        )
        self.image_storage_unlock_failed = builder.get_object(
            "image_storage_unlock_failed",
        )

        self.box_storage_error = builder.get_object("box_storage_error")
        self.box_partition_errors = builder.get_object("box_partition_errors")
        self.button_storage_unlock = builder.get_object("button_storage_unlock")  # type: Gtk.Button
        self.checkbutton_storage_show_passphrase = builder.get_object(
            "checkbutton_storage_show_passphrase",
        )
        self.entry_storage_passphrase = builder.get_object("entry_storage_passphrase")
        self.image_storage_state = builder.get_object("image_storage_state")
        self.label_storage_error = builder.get_object("label_storage_error")
        self.linkbutton_storage_readonly_help = builder.get_object(
            "linkbutton_storage_readonly_help",
        )
        self.spinner_storage_unlock = builder.get_object("spinner_storage_unlock")
        self.button_start = builder.get_object("button_start")

        self.checkbutton_storage_show_passphrase.connect(
            "toggled",
            self.cb_checkbutton_storage_show_passphrase_toggled,
        )

        self.box_storage.set_focus_chain(
            [
                self.box_storage_unlock,
                self.checkbutton_storage_show_passphrase,
            ],
        )

        is_created = self.persistence_setting.is_created
        can_unlock = self.persistence_setting.can_unlock
        self.box_storagecreate.set_visible(not is_created)
        self.box_storage.set_visible(is_created)

        if is_created:
            self.box_storage_unlock.set_visible(can_unlock)
            self.checkbutton_storage_show_passphrase.set_visible(can_unlock)
            self.image_storage_state.set_visible(True)
            self.entry_storage_passphrase.set_visible(can_unlock)
            self.spinner_storage_unlock.set_visible(False)
            self.linkbutton_storage_readonly_help.set_visible(False)
            if not can_unlock and (
                self.persistence_setting.error_type
                == InvalidBootDeviceErrorType.READ_ONLY
            ):
                self.label_storage_error.set_label(
                    _(
                        "Impossible to unlock the Persistent Storage "
                        "because the USB stick is read-only.",
                    ),
                )
                self.linkbutton_storage_readonly_help.set_visible(True)
            self.box_storage_error.set_visible(not can_unlock)
        else:
            partition_error_flag_file = (
                "/var/lib/live/config/tails.disk-partitioning-errors"
            )
            if os.path.isfile(partition_error_flag_file):
                with open(partition_error_flag_file) as f:
                    error_reason = f.read().strip()
                    if error_reason == "partitioning-corruption":
                        # This is "case 3", which we might want to
                        # make fatal as well, see tails#20705.
                        self.create_tps_switch.set_sensitive(False)
                    else:
                        self.button_start.set_sensitive(False)
                        self.box_storagecreate.set_visible(False)
                        self.box_settings.set_sensitive(False)
                        # The first element is language, which we
                        # skip, the other two are keyboard layout and
                        # formats. We only want language to still be
                        # available so the user can see the error
                        # message in their preferred language.
                        for row in list(self.listbox_region)[1:]:
                            row.set_sensitive(False)
                        self.box_partition_errors.set_visible(True)

    # Utility methods

    def _build_accelerators(self):
        accelgroup = Gtk.AccelGroup()
        self.add_accel_group(accelgroup)
        for accel_key in [s.accel_key for s in self.settings if s.accel_key]:
            accelgroup.connect(
                accel_key,
                Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.CONTROL_MASK,
                Gtk.AccelFlags.VISIBLE,
                self.cb_accelgroup_setting_activated,
            )

    def _set_focus_chain(self):
        self.box_language.set_focus_chain(
            [self.frame_language, self.box_language_header],
        )
        self.box_settings.set_focus_chain(
            [self.box_settings_values, self.box_settings_header],
        )

    # Actions

    def apply_settings(self):
        for setting in self.settings:
            setting.apply()

    def load_settings(self):
        # We have to load formats and keyboard before language, because
        # changing the language also changes the other two, which causes
        # the settings files to be overwritten. So we load the region
        # settings in reversed order.
        settings_loaded = False
        for setting in reversed(list(self.settings.region_settings)):
            try:
                changed = setting.load()
                if changed:
                    # We only want to show the "settings loaded" notification
                    # if settings were actually changed, i.e. the settings
                    # in the persistent settings dir were not the same as
                    # the already configured ones.
                    # Else, the notification would also be shown the first time
                    # the system is booted after creating the Persistent Storage
                    # (which currently means that the Persistent Storage is empty,
                    # but that's WIP on #11529), because then the persistent
                    # settings dir doesn't exist yet, which means that live-boot
                    # copies the current settings dir to the Persistent Storage -
                    # which contains the currently configured settings, which are
                    # then loaded.
                    settings_loaded = True
            except SettingNotFoundError as e:
                logging.debug(e)
                # The settings file does not exist, so we create it by
                # applying the setting's default value.
                setting.apply()

        for setting in self.settings.additional_settings:
            try:
                changed = setting.load()
                # We only add the setting to the list of additional settings
                # if it was actually changed. Else it is either already added or
                # it has the default value.
                if not changed:
                    continue
                settings_loaded = True
                # Add the setting to the listbox of added settings, if it was
                # not added before (by the user, before unlocking perrsistence).
                if self.setting_added(setting.name):
                    # The setting was already added, we only have to call apply()
                    # to update the label
                    setting.apply()
                else:
                    self.add_setting(setting.name)
            except SettingNotFoundError as e:
                logging.debug(e)
                # The settings file does not exist, so we create it by
                # applying the setting's default value.
                setting.apply()

        if settings_loaded:
            self.infobar_settings_loaded.set_visible(True)

    def run_add_setting_dialog(self, id_=None):
        response = self.dialog_add_setting.run(id_)
        if response == Gtk.ResponseType.YES:
            row = self.listbox_add_setting.get_selected_row()
            id_ = self.settings.id_from_row(row)
            setting = self.settings.additional_settings[id_]

            self.dialog_add_setting.set_visible(False)
            self.dialog_add_setting.stack.remove(setting.box)

            self.add_setting(id_)
        else:
            old_details = self.dialog_add_setting.stack.get_child_by_name(
                "setting-details",
            )
            if old_details:
                self.dialog_add_setting.stack.remove(old_details)
            self.dialog_add_setting.set_visible(False)

    def add_setting(self, id_):
        logging.debug("Adding setting '%s'", id_)
        setting = self.settings.additional_settings[id_]
        setting.apply()
        setting.build_popover()

        self.listbox_add_setting.remove(setting.listboxrow)
        self.listbox_settings.add(setting.listboxrow)
        self.listbox_settings.unselect_all()

        if not self.listbox_add_setting.get_children():
            self.toolbutton_settings_add.set_sensitive(False)

    def edit_setting(self, id_):
        if self.settings[id_].has_popover():
            self.settings[id_].listboxrow.emit("activate")
        else:
            self.run_add_setting_dialog(id_)

    def setting_added(self, id_):
        setting = self.settings.additional_settings[id_]
        return setting.listboxrow in self.listbox_settings.get_children()

    def show(self):
        super().show()
        self.button_start.grab_focus()
        self.get_root_window().set_cursor(Gdk.Cursor.new(Gdk.CursorType.ARROW))

    def unlock_tps(self, already_attempted_forceful_fsck: bool = False):
        self.box_storage_unlock.set_visible(False)
        self.label_storage_unlock_status.set_label(_("Unlocking…"))
        self.label_storage_unlock_status.set_visible(True)
        self.image_storage_unlock_failed.set_visible(False)
        self.box_storage_unlock_status.set_visible(True)
        self.checkbutton_storage_show_passphrase.set_visible(False)
        self.image_storage_state.set_visible(False)
        self.spinner_storage_unlock.set_visible(True)

        passphrase = self.entry_storage_passphrase.get_text()

        # Let's execute the unlocking in a thread
        def do_unlock_tps():
            try:
                # First, upgrade the storage if needed (skip if we
                # already attempted a forceful fsck, because then we
                # already ran this code and tried to upgrade)
                if (
                    not self.persistence_setting.is_upgraded
                    and not already_attempted_forceful_fsck
                ):
                    try:
                        glib_idle_add_once(self.on_tps_upgrading)
                        self.persistence_setting.upgrade_luks(passphrase)
                    except PersistentStorageError as e:
                        # We continue unlocking the storage even if the upgrade
                        # failed, but we display an error message
                        logging.error(e)
                        self.tps_upgrade_failed = True

                # Reset the label in case it was altered by
                # on_tps_upgrading() above.
                glib_idle_add_once(
                    self.label_storage_unlock_status.set_label,
                    _("Unlocking…"),
                )

                # If unlocking takes a long time we assume it is
                # because the filesystem integrity check is taking a
                # long time and give that as feedback to the user.
                def cb_unlocking_is_slow():
                    self.label_storage_unlock_status.set_label(
                        _("Checking the file system…"),
                    )
                    # Only run this callback once when passed to GLib.timeout_add*()
                    return False

                timeout_cb_id = GLib.timeout_add_seconds(5, cb_unlocking_is_slow)

                # Then, unlock the storage
                try:
                    self.persistence_setting.unlock(passphrase)
                finally:
                    GLib.source_remove(timeout_cb_id)
                glib_idle_add_once(self.cb_tps_unlocked)
            except WrongPassphraseError:
                glib_idle_add_once(self.cb_tps_unlock_failed_with_incorrect_passphrase)
            except IOErrorsDetectedError:
                glib_idle_add_once(self.cb_tps_unlock_failed_with_io_errors)
            except FilesystemErrorsLeftUncorrectedError:
                if already_attempted_forceful_fsck:
                    glib_idle_add_once(self.on_tps_unlock_failed)
                else:
                    glib_idle_add_once(self.cb_unlock_failed_with_filesystem_errors)
            except PersistentStorageError as e:
                logging.error(e)
                glib_idle_add_once(self.on_tps_unlock_failed)
                return

        unlocking_thread = threading.Thread(target=do_unlock_tps)
        unlocking_thread.start()

    def repair_tps_filesystem(self):
        dialog = MessageDialog(
            message_type=Gtk.MessageType.INFO,
            title=_("Repairing the File System"),
            text=_("This might take a long time..."),
            cancel_label=_("Cancel"),
        )
        dialog.set_transient_for(self)
        # Add a spinner to the dialog, next to the secondary label
        box = Gtk.Box(spacing=6, margin=12)
        spinner = Gtk.Spinner()
        spinner.start()
        box.pack_start(spinner, False, False, 0)
        label = dialog.get_message_area().get_children()[1]
        dialog.get_message_area().remove(label)
        box.pack_start(label, False, False, 0)
        box.show_all()
        dialog.get_message_area().pack_start(box, False, False, 0)

        def on_tps_repair_failed():
            dialog.response(Gtk.ResponseType.CANCEL)
            label = "{}\n\n{}".format(
                _("Failed to repair the file system of your Persistent Storage."),
                _(
                    "Start Tails to send an error report and learn how to recover your data.",
                ),
            )
            self.on_tps_activation_failed(label)
            self.open_prefilled_whisperback_after_login(
                "fsck",
                "Failed to repair the file system of your Persistent Storage",
            )
            self.open_help_after_login("doc/persistent_storage/fsck")

        def on_tps_repair_success():
            dialog.response(Gtk.ResponseType.OK)
            # Show a separate dialog to support closing it via Alt+F4 or Escape
            dialog_ = MessageDialog(
                message_type=Gtk.MessageType.INFO,
                title=_("File System Repaired Successfully"),
                text=_(
                    "It's possible that some data was lost during the repair. "
                    "Please check the contents of your Persistent Storage and "
                    "restore any lost data from a backup.",
                ),
                ok_label=_("Close"),
            )
            dialog_.set_transient_for(self)
            dialog_.run()
            dialog_.destroy()

        def on_tps_repair_finished(proxy: Gio.DBusProxy, res: Gio.AsyncResult):
            try:
                proxy.call_finish(res)
            except GLib.GError as err:
                logging.error(err)
                if err.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED):
                    self.persistence_setting.abort_repair_filesystem()
                    self.on_tps_activation_failed(
                        _(
                            "You aborted the repair of the file system. You can "
                            "either start Tails without Persistent Storage or restart "
                            "the computer to try repairing the file system again.",
                        ),
                    )

                else:
                    glib_idle_add_once(on_tps_repair_failed)
            else:
                glib_idle_add_once(on_tps_repair_success)

        def on_repairing_dialog_response(dialog, response):
            dialog.destroy()
            if response == Gtk.ResponseType.OK:
                self.unlock_tps(already_attempted_forceful_fsck=True)
            else:
                cancellable.cancel()

        cancellable = self.persistence_setting.repair_filesystem(on_tps_repair_finished)
        dialog.connect("response", on_repairing_dialog_response)
        dialog.show_all()

    def open_prefilled_whisperback_after_login(self, app: str, summary: str):
        path = "/var/lib/gdm3/post-greeter-whisperback.json"
        with open(path, "w") as f:
            json.dump(
                {
                    "app": app,
                    "summary": summary,
                },
                f,
            )
        # Make file not only readable but also writable by the user
        # that will run WhisperBack, so it can be redacted.
        subprocess.check_call(["/usr/bin/setfacl", "-m", f"u:{LIVE_USERNAME}:rw", path])

    def open_help_after_login(self, doc: str):
        with open("/var/lib/gdm3/post-greeter-docs.url", "w") as f:
            f.write(doc)

    @staticmethod
    def open_help_window(page: str) -> GreeterHelpWindow:
        def localize_page(page: str) -> str:
            """Try to get a localized version of the page"""
            if config.current_language == "en":
                return page

            localized_page = page.replace(".en.", ".%s." % config.current_language)

            # Strip the fragment identifier
            index = localized_page.find("#")
            filename = localized_page[:index] if index > 0 else localized_page

            if os.path.isfile("/usr/share/doc/tails/website/" + filename):
                return localized_page
            return page

        page = localize_page(page)

        # Note that we add the "file://" part here, not in the URI.
        # We're forced to add this
        # callback *in addition* to the standard one (Gtk.show_uri),
        # which will do nothing for uri:s without a protocol
        # part. This is critical since we otherwise would open the
        # default browser (iceweasel) in T-G. If pygtk had a mechanism
        # like gtk's g_signal_handler_find() this could be dealt with
        # in a less messy way by just removing the default handler.
        uri = "file:///usr/share/doc/tails/website/" + page
        logging.debug(f"Opening help window for {uri}")
        helpwindow = GreeterHelpWindow(uri)
        helpwindow.show()
        return helpwindow

    # Callbacks

    def cb_accelgroup_setting_activated(
        self,
        accel_group,
        accelerable,
        keyval,
        modifier,
    ):
        for setting in self.settings:
            if setting.accel_key == keyval:
                self.edit_setting(setting.name)
        return False

    def cb_linkbutton_help_activate(self, linkbutton, user_data=None):
        linkbutton.set_sensitive(False)
        # Display progress cursor and update the UI
        self.get_window().set_cursor(Gdk.Cursor.new(Gdk.CursorType.WATCH))
        while Gtk.events_pending():
            Gtk.main_iteration()

        page = linkbutton.get_uri()
        helpwindow = self.open_help_window(page)

        def restore_linkbutton_status(widget, event, linkbutton):
            linkbutton.set_sensitive(True)
            return False

        helpwindow.connect("delete-event", restore_linkbutton_status, linkbutton)
        # Restore default cursor
        self.get_window().set_cursor(None)

    def cb_button_shutdown_clicked(self, widget, user_data=None):
        self.greeter.shutdown()
        return False

    def cb_button_start_clicked(self, widget, user_data=None):
        # Ask for confirmation when Persistent Storage exists but is not
        # unlocked
        if (
            self.persistence_setting.is_created
            and self.persistence_setting.can_unlock
            and not self.persistence_setting.is_unlocked
            and not self.persistence_setting.failed_with_unrecoverable_error
        ):
            response = self.confirm_dialog.run()
            self.confirm_dialog.set_visible(False)
            if response != Gtk.ResponseType.OK:
                return None

        self.greeter.login()
        return False

    def cb_button_storage_unlock_clicked(self, widget, user_data=None):
        self.unlock_tps()
        return False

    def cb_entry_storage_passphrase_activated(self, entry, user_data=None):
        # Don't try to unlock if the entry is empty
        if entry.get_text():
            self.unlock_tps()

        return False

    def cb_entry_storage_passphrase_changed(self, editable, user_data=None):
        # Only allow starting if the password entry is empty. We used to
        # attempt unlocking with the entered password when the "Start Tails"
        # button was clicked, but changed that behavior (see #17136), so
        # we now force users to click the "Unlock" button first before
        # they can click "Start Tails".
        passphrase_empty = not bool(editable.get_text())
        self.button_start.set_sensitive(passphrase_empty)
        self.button_storage_unlock.set_sensitive(not passphrase_empty)
        return False

    def cb_create_tps_switch_active_changed(self, widget, user_data=None):
        self.greeter.persistent_storage_create.toggle()

    def cb_infobar_close(self, infobar, user_data=None):
        infobar.set_visible(False)
        return False

    def cb_infobar_response(self, infobar, response_id, user_data=None):
        infobar.set_visible(False)
        return False

    def cb_listbox_add_setting_focus(self, widget, direction, user_data=None):
        self.dialog_add_setting.listbox_focus()
        return False

    def cb_listbox_add_setting_row_activated(self, listbox, row, user_data=None):
        self.dialog_add_setting.listbox_row_activated(row)
        return False

    def cb_listbox_region_row_activated(self, listbox, row, user_data=None):
        setting = self.settings[self.settings.id_from_row(row)]
        if not setting.popover.is_open():
            setting.popover.open(self.on_region_setting_popover_closed, setting)
        return False

    def on_region_setting_popover_closed(
        self,
        popover: Popover,
        setting: LocalizationSettingUI,
    ):
        # Unselect the listbox row
        self.listbox_region.unselect_all()

        if popover.response != Gtk.ResponseType.YES:
            return

        setting.apply()

    def cb_language_or_keyboard_loaded_changed(
        self,
        setting,
        paramspec,
        user_data=None,
    ):
        # This callbacks keep the UI in sync with the save state
        save_enabled = setting.get_property("saveEnabled")
        logging.info(
            "%s loaded (from %s) %s saving",
            setting.__class__.__name__,
            user_data,
            "" if save_enabled else "not",
        )
        self.region_save_switch.set_state(save_enabled)
        self.region_save_switch.set_active(save_enabled)

    def cb_save_language_keyboard_switch_changed(self, widget, user_data=None):
        settings = [
            self.greeter.localisationsettings.keyboard,
            self.greeter.localisationsettings.language,
        ]
        if not self.greeter.initialization_complete:
            # We won't show the dialog for changes happening to widgets before the user
            # had a chance to interact with the window
            return True

        if not widget.get_active():
            for setting in settings:
                setting.set_property("saveEnabled", False)
            return True

        logging.info(
            "Widget save active=%s state=%s",
            widget.get_active(),
            widget.get_state(),
        )
        dialog = self.save_unencrypted_dialog
        dialog.set_modal(True)
        dialog.set_transient_for(self)

        def on_save_language_dialog_response(dialog, response):
            dialog.set_visible(False)
            if response == Gtk.ResponseType.OK:
                for setting in settings:
                    setting.set_property("saveEnabled", True)
                return
            widget.set_active(False)

        dialog.connect("response", on_save_language_dialog_response)
        dialog.show_all()

        # Returning TRUE prevents the default handler from running
        return True

    def cb_listbox_settings_row_activated(self, listbox, row, user_data=None):
        setting = self.settings[self.settings.id_from_row(row)]
        if not setting.popover.is_open():
            setting.popover.open(self.on_additional_setting_popover_closed, setting)
        return False

    def on_additional_setting_popover_closed(
        self,
        popover: Popover,
        setting: AdditionalSetting,
    ):
        logging.debug(
            "'%s' popover closed. response: %s",
            setting.name,
            popover.response,
        )
        # Unselect the listbox row
        self.listbox_settings.unselect_all()
        if popover.response == Gtk.ResponseType.YES:
            setting.apply()

    def cb_toolbutton_settings_add_clicked(self, user_data=None):
        self.run_add_setting_dialog()
        return False

    def cb_toolbutton_settings_mnemonic_activate(self, widget, group_cycling):
        self.run_add_setting_dialog()
        return False

    def cb_window_delete_event(self, widget, event, user_data=None):
        # Don't close the toplevel window on user request (e.g. pressing
        # Alt+F4)
        return True

    def cb_tps_unlocked(self):
        logging.debug("Storage unlocked")

        # Activate the Persistent Storage
        try:
            self.persistence_setting.activate_persistent_storage()
        except FeatureActivationFailedError as e:
            label = (
                str(e)
                + "\n"
                + _(
                    "Start Tails and open the Persistent Storage settings to find out more.",
                )
            )
            self.on_tps_activation_failed(label)
            return
        except PersistentStorageError as e:
            logging.error(e)
            self.on_tps_activation_failed()
            return
        if self.tps_upgrade_failed:
            self.on_tps_upgrade_failed()
            return

        self.box_storage_unlock.set_visible(False)
        self.spinner_storage_unlock.set_visible(False)
        self.image_storage_state.set_from_icon_name(
            "tails-unlocked",
            Gtk.IconSize.BUTTON,
        )

        if not os.listdir(persistent_settings_dir):
            self.apply_settings()
        else:
            self.load_settings()

        # We're done unlocking and activating the Persistent Storage
        self.image_storage_state.set_visible(True)
        self.image_storage_unlock_failed.set_visible(False)
        self.label_storage_unlock_status.set_label(
            _(
                "Your Persistent Storage is unlocked. Its content will be available until you shut down Tails.",
            ),
        )
        self.button_start.set_sensitive(True)

    def cb_checkbutton_storage_show_passphrase_toggled(self, widget):
        self.entry_storage_passphrase.set_visibility(widget.get_active())

    def cb_tps_unlock_failed_with_incorrect_passphrase(self):
        logging.debug("Storage unlock failed")
        self.box_storage_unlock.set_visible(True)
        self.checkbutton_storage_show_passphrase.set_visible(True)
        self.image_storage_state.set_visible(True)
        self.spinner_storage_unlock.set_visible(False)
        self.label_storage_unlock_status.set_label(
            _("Incorrect passphrase. Please try again."),
        )
        self.image_storage_unlock_failed.set_visible(True)
        self.entry_storage_passphrase.select_region(0, -1)
        self.entry_storage_passphrase.grab_focus()

    def cb_tps_unlock_failed_with_io_errors(self):
        logging.debug("Persistent Storage unlock failed due to IO errors")

        label = "{}\n\n{}".format(
            _(
                "Error reading data from your Persistent Storage. The hardware of your USB stick is probably failing.",
            ),
            _("Start Tails to learn how to recover your data."),
        )
        self.on_tps_activation_failed(label)
        self.open_help_after_login("doc/persistent_storage/fsck")

    def cb_unlock_failed_with_filesystem_errors(self):
        logging.debug("Persistent Storage unlock failed due to file system errors")

        # Ask the user if they want to repair the filesystem
        dialog = MessageDialog(
            message_type=Gtk.MessageType.WARNING,
            title=_("File System Errors"),
            text=_(
                """Errors were detected in the file system of your Persistent Storage.

Tails can try to fix these errors, but this might erase some of your data and take a long time.

If you already have an up-to-date backup of your Persistent Storage, we recommend that you try to repair.

If you don't have a backup, we recommend that you create a partition image of your Persistent Storage first.""",
            ),
            cancel_label=_("Cancel"),
            ok_label=_("Repair File System"),
            third_button_label=_("Create Partition Image"),
            destructive=True,
        )
        dialog.set_transient_for(self)

        def on_fs_errors_dialog_response(dialog, response):
            dialog.destroy()
            # The REJECT response is not used by GTK by default, so we use
            # it for the "Create Backup" button out of better options.
            if response == Gtk.ResponseType.REJECT:
                label = _(
                    "Start Tails to learn how to create a partition image of your Persistent Storage.",
                )
                self.on_tps_activation_failed(label)
                self.open_help_after_login("doc/persistent_storage/fsck")
                return
            elif response == Gtk.ResponseType.OK:
                self.repair_tps_filesystem()
            else:
                label = _(
                    "Failed to unlock the Persistent Storage due to file system errors.",
                )
                self.on_tps_activation_failed(label)

        dialog.connect("response", on_fs_errors_dialog_response)
        dialog.show_all()

    def on_tps_upgrade_failed(self):
        label = _(
            "Failed to upgrade the Persistent Storage. "
            "Please start Tails and send an error report.",
        )
        self.on_tps_activation_failed(label)

    def on_tps_unlock_failed(self):
        label = _(
            "Failed to unlock the Persistent Storage. "
            "Please start Tails and send an error report.",
        )
        self.on_tps_activation_failed(label)

    def on_tps_activation_failed(self, label=None):
        if not label:
            label = _(
                "Failed to activate the Persistent Storage. "
                "Please start Tails and send an error report.",
            )
        self.image_storage_state.set_visible(True)
        self.spinner_storage_unlock.set_visible(False)
        self.label_storage_unlock_status.set_label(label)
        self.image_storage_unlock_failed.set_visible(True)
        self.button_start.set_sensitive(True)
        self.box_storage_unlock_status.set_visible(True)

    def on_tps_upgrading(self):
        label = _("Upgrading the Persistent Storage. This might take a while…")
        self.label_storage_unlock_status.set_label(label)


class GreeterBackgroundWindow(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(app)
        Gtk.Window.__init__(
            self,
            title=_(tailsgreeter.APPLICATION_TITLE),
            application=app,
        )
        self.override_background_color(Gtk.StateFlags.NORMAL, Gdk.RGBA(0, 0, 0, 1))
