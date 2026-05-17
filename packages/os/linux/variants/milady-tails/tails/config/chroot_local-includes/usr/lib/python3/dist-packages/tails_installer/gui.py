# Copyright © 2008-2013  Red Hat, Inc. All rights reserved.
# Copyright © 2008-2013  Luke Macken <lmacken@redhat.com>
# Copyright © 2008  Kushal Das <kushal@fedoraproject.org>
# Copyright © 2012-2016  Tails Developers <foundations@tails.net>
#
# This copyrighted material is made available to anyone wishing to use, modify,
# copy, or redistribute it subject to the terms and conditions of the GNU
# General Public License v.2.  This program is distributed in the hope that it
# will be useful, but WITHOUT ANY WARRANTY expressed or implied, including the
# implied warranties of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
# See the GNU General Public License for more details.  You should have
# received a copy of the GNU General Public License along with this program; if
# not, write to the Free Software Foundation, Inc., 51 Franklin Street, Fifth
# Floor, Boston, MA 02110-1301, USA. Any Red Hat trademarks that are
# incorporated in the source code or documentation are not subject to the GNU
# General Public License and may only be used or replicated with the express
# permission of Red Hat, Inc.
#
# Author(s): Luke Macken <lmacken@redhat.com>
#            Kushal Das <kushal@fedoraproject.org>
#            Tails Developers <foundations@tails.net>

"""
A graphical interface for the Tails Installer
"""

import os
import logging
import subprocess
import threading
import traceback
import time
import psutil

from time import sleep
from datetime import datetime

from gi.repository import Gdk, GLib, Gtk

from tails_installer.passphrase_dialog import PassphraseDialog

from tails_installer import (
    TailsInstallerCreator,
    TailsInstallerError,
    TargetDeviceBusy,
    _,
)
from tails_installer.config import CONFIG
from tails_installer.source import LocalIsoSource
from tails_installer.source import RunningLiveSystemSource
from tails_installer.utils import (
    _to_unicode,
    _format_bytes_in_gb,
    _get_datadir,
    get_persistent_storage_backup_size,
)

MAX_FAT16 = 2047
MAX_FAT32 = 3999
MAX_EXT = 2097152

# FIXME: port to Gtk.Application


class ProgressThread(threading.Thread):
    """A thread that monitors the progress of Live USB creation.

    This thread periodically checks the amount of free space left on the
    given drive and sends a signal to our main dialog window to update the
    progress bar.
    """

    totalsize = 0
    tps_totalsize = 0
    orig_free = 0
    drive = None
    get_free_bytes = None

    def __init__(self, parent: "TailsInstallerWindow"):
        threading.Thread.__init__(self)
        self.parent = parent
        self.terminate = threading.Event()

    def set_data(self, size, drive, freebytes):
        self.totalsize = size / 1024
        self.drive = drive
        self.get_free_bytes = freebytes
        self.orig_free = self.get_free_bytes()
        if self.parent.opts.clone_persistent_storage_requested:
            self.tps_totalsize = get_persistent_storage_backup_size() / 1024

    def run(self):
        value = 0
        tps_value = 0
        while not self.terminate.is_set():
            try:
                free = self.get_free_bytes()
            except FileNotFoundError:  # not mounted
                pass
            else:
                if free is not None:
                    value = (self.orig_free - free) / 1024
            if os.path.ismount("/media/amnesia/TailsData"):
                tps_value = psutil.disk_usage("/media/amnesia/TailsData").used / 1024
            GLib.idle_add(
                self.parent.progress,
                float(value + tps_value) / (self.totalsize + self.tps_totalsize),
            )
            sleep(0.1)

    def stop(self):
        self.terminate.set()


class TailsInstallerThread(threading.Thread):
    def __init__(
        self,
        live: TailsInstallerCreator,
        progress: ProgressThread,
        parent: "TailsInstallerWindow",
    ):
        threading.Thread.__init__(self)
        self.progress = progress
        self.live = live
        self.parent = parent
        self.maximum = 0

    def status(self, text):
        GLib.idle_add(self.parent.status, text)

    def rescan_partition(self, udi):
        self._waiting_detection = True

        def detection_done():
            self._waiting_detection = False

        self.live.detect_partition(udi, callback=detection_done, force_partitions=True)

        while self._waiting_detection:
            time.sleep(1)

    def installation_complete(self):
        GLib.idle_add(self.parent.on_installation_complete, None)

    def run(self):
        self.handler = TailsInstallerLogHandler(self.status)
        self.live.log.addHandler(self.handler)
        self.now = datetime.now()
        self.live.save_full_drive()
        try:
            if self.parent.opts.partition:
                try:
                    self.live.unmount_device()
                except TargetDeviceBusy:
                    self.status(
                        _(
                            "Unable to clone because the target USB stick is being "
                            "used. Close all open files on the target USB stick, "
                            "restart elizaOS USB Cloner, and try to clone again."
                        )
                    )
                    self.live.log.removeHandler(self.handler)
                    return

                if not self.live.can_read_partition_table():
                    self.live.log.info("Clearing unreadable partition table.")
                    self.live.clear_all_partition_tables()
                # If there is a partition already in place and we need
                # to reinstall, then we need to change the selected
                # device for its saved parent, if it exists
                if (
                    self.parent.force_reinstall
                    and self.live.drive["parent_data"] is not None
                ):
                    parent_data = self.live.drive["parent_data"]
                    self.live.drives[parent_data["device"]] = parent_data
                    self.live.drive = parent_data["device"]
                    self.live.save_full_drive()
                partition_udi = self.live.partition_device()
                self.rescan_partition(partition_udi)
                self.live.switch_drive_to_system_partition()
                self.live.format_device()
                self.live.mount_device()

            self.live.verify_filesystem()
            if not self.live.drive["uuid"] and not self.live.label:
                self.status(
                    _(
                        "Error: Cannot set the label or obtain "
                        "the UUID of your device.  Unable to continue."
                    )
                )
                self.live.log.removeHandler(self.handler)
                return

            self.live.check_free_space()

            # Setup the progress bar
            self.progress.set_data(
                size=self.live.totalsize,
                drive=self.live.drive["device"],
                freebytes=self.live.get_free_bytes,
            )
            self.progress.start()

            self.live.extract_iso()
            self.live.read_extracted_mbr()
            self.live.create_persistent_overlay()
            self.live.update_configs()

            self.live.install_bootloader()
            # self.live.bootable_partition()

            if self.parent.opts.clone_persistent_storage_requested:
                self.live.clone_persistent_storage()

            # Set progress to 100% after cloning persistent storage
            self.set_max_progress(float(1))
            self.update_progress(1)

            self.progress.stop()

            # Flush all filesystem buffers and unmount
            self.live.flush_buffers()
            self.live.unmount_device()

            if self.parent.opts.partition:
                self.live.switch_back_to_full_drive()

            self.live.reset_mbr_and_write_random_seed()
            self.live.flush_buffers()

            duration = str(datetime.now() - self.now).split(".")[0]
            self.status(_("Cloning complete! (%s)") % duration)
            self.installation_complete()

        except Exception as ex:
            self.status(ex)
            self.status(_("elizaOS installation failed!"))
            self.live.log.exception(str(ex))
            self.live.log.debug(traceback.format_exc())

        self.live.log.removeHandler(self.handler)
        self.progress.stop()

    def set_max_progress(self, maximum):
        self.maximum = maximum

    def update_progress(self, value):
        GLib.idle_add(self.parent.progress, float(value) / self.maximum)


class TailsInstallerLogHandler(logging.Handler):
    def __init__(self, cb):
        logging.Handler.__init__(self)
        self.cb = cb

    def emit(self, record):
        if record.levelname in ("INFO", "ERROR", "WARN"):
            self.cb(record.msg)


class TailsInstallerWindow(Gtk.ApplicationWindow):
    """Our main dialog class"""

    def __init__(self, app=None, opts=None, args=None):
        Gtk.ApplicationWindow.__init__(self, application=app)

        self.opts = opts
        self.args = args
        self.signals_connected = []
        self.source_available = False
        self.target_available = False
        self.target_selected = False
        self.force_reinstall = False
        self.force_reinstall_button_available = False

        try:
            subprocess.check_call(["/usr/local/lib/tpscli", "is-created"])
            self.persistent_storage_is_created = True
        except subprocess.CalledProcessError as e:
            if e.returncode != 1:
                raise
            self.persistent_storage_is_created = False

        try:
            subprocess.check_call(["/usr/local/lib/tpscli", "is-unlocked"])
            self.persistent_storage_is_unlocked = True
        except subprocess.CalledProcessError as e:
            if e.returncode != 1:
                raise
            self.persistent_storage_is_unlocked = False

        self._build_ui()

        self.opts.clone = True
        self.live = TailsInstallerCreator(opts=opts)

        # Intercept all tails_installer.INFO log messages, and display them
        # in the GUI
        self.handler = TailsInstallerLogHandler(lambda x: self.append_to_log(str(x)))
        self.live.log.addHandler(self.handler)

        # Initialize the visibility and state of the clone/ISO source
        # selection widgets. This triggers on_radio_button_source_iso_toggled
        # that will in turn initialize self.live.source, self.source_available,
        # and populate the list of candidate devices.
        # - inside Tails
        if self.opts.clone:
            self.__radio_button_source_device.set_active(True)
            self.__filechooserbutton_source_file.set_sensitive(False)
            if self.opts.clone_persistent_storage_requested:
                self.__check_button_clone_persistent_storage.set_active(True)
        # - outside of Tails
        else:
            self.__radio_button_source_device.set_visible(False)
            self.__filechooserbutton_source_file.set_sensitive(True)

        self.update_start_button()
        self.update_clone_persistent_storage_check_button()
        self.downloader = None
        self.progress_thread = ProgressThread(parent=self)
        self.live_thread = TailsInstallerThread(
            live=self.live, progress=self.progress_thread, parent=self
        )
        self.live.connect_drive_monitor(self.populate_devices)

        # If an ISO was specified on the command line, use it.
        if args:
            for arg in self.args:
                if arg.lower().endswith(".iso") and os.path.exists(arg):
                    self.select_source_iso(arg)

        # Show the UI
        self.show()

    def _build_ui(self):
        # Set windows properties
        self.set_deletable(True)
        self.connect("delete-event", Gtk.main_quit)
        self.set_title(_("elizaOS USB Cloner"))

        # Import window content from UI file
        builder = Gtk.Builder.new_from_file(
            os.path.join(_get_datadir(), "tails-installer.ui")
        )
        self.__box_installer = builder.get_object("box_installer")
        self.__image_header = builder.get_object("image_header")
        self.__infobar = builder.get_object("infobar")
        self.__label_infobar_title = builder.get_object("label_infobar_title")
        self.__label_infobar_details = builder.get_object("label_infobar_details")
        self.__box_source = builder.get_object("box_source")
        self.__box_source_select = builder.get_object("box_source_select")
        self.__box_source_file = builder.get_object("box_source_file")
        self.__filechooserbutton_source_file = builder.get_object(
            "filechooserbutton_source_file"
        )
        self.__box_target = builder.get_object("box_target")
        self.__combobox_target = builder.get_object("combobox_target")
        self.__liststore_target = builder.get_object("liststore_target")
        self.__textview_log = builder.get_object("textview_log")
        self.__progressbar = builder.get_object("progressbar_progress")
        self.__button_start = builder.get_object("button_start")
        self.__radio_button_source_iso = builder.get_object("radio_button_source_iso")
        self.__radio_button_source_device = builder.get_object(
            "radio_button_source_device"
        )
        self.__check_button_clone_persistent_storage = builder.get_object(
            "check_button_clone_persistent_storage"
        )
        self.__button_force_reinstall = builder.get_object("check_force_reinstall")
        self.__help_link = builder.get_object("help_link")

        self.add(self.__box_installer)
        builder.connect_signals(self)

        # Add a cell renderer to the comboboxes
        cell = Gtk.CellRendererText()
        self.__combobox_target.pack_start(cell, True)
        self.__combobox_target.add_attribute(cell, "text", 0)

        # Add image header
        self.__image_header.set_from_file(
            os.path.join(_get_datadir(), CONFIG["branding"]["header"])
        )
        rgba = Gdk.RGBA()
        rgba.parse(CONFIG["branding"]["color"])
        self.__image_header.override_background_color(Gtk.StateFlags.NORMAL, rgba)

    def on_radio_button_source_iso_toggled(self, radio_button):
        self.live.log.debug("Entering on_radio_button_source_iso_toggled")
        active_radio = next(r for r in radio_button.get_group() if r.get_active())
        if active_radio.get_label() == _("Clone the current elizaOS"):
            self.live.log.debug("Mode: clone")
            self.opts.clone = True
            self.live.source = RunningLiveSystemSource(
                path=CONFIG["running_liveos_mountpoint"]
            )
            self.source_available = True
            self.__filechooserbutton_source_file.set_sensitive(False)
        elif active_radio.get_label() == _("Use a downloaded elizaOS ISO image"):
            self.live.log.debug("Mode: from ISO")
            self.opts.clone = False
            self.live.source = None
            self.source_available = False
            self.__filechooserbutton_source_file.set_sensitive(True)
        # previous error messages may be invalid now
        self.clear_log()
        # some previously rejected devices may now be valid candidates
        # and vice-versa
        self.live.log.debug(
            "Calling populate_devices() from on_radio_button_source_iso_toggled"
        )
        self.populate_devices()
        self.update_clone_persistent_storage_check_button()

    def on_check_button_clone_persistent_storage_toggled(self, check_button):
        self.live.log.debug("Entering on_check_button_clone_persistent_storage_toggled")
        self.opts.clone_persistent_storage_requested = check_button.get_active()
        self.update_start_button()
        self.on_target_partitions_changed(None)

    def on_activate_link_button(self, link_button: Gtk.LinkButton):
        uri = link_button.get_uri()
        self.live.log.debug("Opening Documentation: %s", uri)
        subprocess.run(["/usr/local/bin/tails-documentation", uri], check=False)
        return True

    def on_force_reinstall_clicked(self, button):
        # If the user has chosen install from ISO, but no ISO is selected
        if not self.live.opts.clone and not self.is_ISO_selected():
            self.warn_ISO_not_selected()
            return True
        self.force_reinstall = True
        self.opts.partition = True
        self.on_start_clicked(button)
        return True

    def on_source_file_set(self, filechooserbutton):
        self.select_source_iso(filechooserbutton.get_filename())

    def on_target_partitions_changed(self, combobox_target):
        # get selected device
        drive = self.get_selected_drive()
        if drive is None:
            self.enable_widgets(False)
        else:
            device = self.live.drives[drive]

        if drive and self.live.device_can_be_upgraded(device):
            self.opts.partition = False
            self.force_reinstall = False
            self.__button_start.set_label(_("Upgrade"))
            self.__help_link.set_label(_("Manual Upgrade Instructions"))
            self.__help_link.set_uri("https://tails.net/doc/upgrade/")
            if device["is_device_big_enough_for_reinstall"]:
                self.force_reinstall_button_available = True
                self.__button_force_reinstall.set_visible(True)
            else:
                self.force_reinstall_button_available = False
                self.__button_force_reinstall.set_visible(False)
        else:
            self.opts.partition = True
            self.force_reinstall = True
            self.__button_start.set_label(_("Install"))
            self.force_reinstall_button_available = False
            self.__button_force_reinstall.set_visible(False)
            self.__help_link.set_label(_("Installation Instructions"))
            self.__help_link.set_uri("https://tails.net/install/")
            if self.opts.clone_persistent_storage_requested:
                self.__help_link.set_label(_("Backup Instructions"))
                self.__help_link.set_uri(
                    "https://tails.net/doc/persistent_storage/backup/"
                )
        self.update_clone_persistent_storage_check_button()
        self.update_start_button()

    def get_device_pretty_name(self, device):
        size = _format_bytes_in_gb(
            device["parent_size"] if device["parent_size"] else device["size"]
        )
        pretty_name = _("%(size)s %(vendor)s %(model)s device (%(device)s)") % {
            "size": size,
            "vendor": device["vendor"],
            "model": device["model"],
            "device": device["device"],
        }
        return pretty_name

    def is_ISO_selected(self):
        return self.live.source.__class__ == LocalIsoSource

    def warn_ISO_not_selected(self):
        self.show_confirmation_dialog(
            _("No ISO image selected"), _("Please select an elizaOS ISO image."), True
        )

    def on_start_clicked(self, button):
        # If the user has chosen install from ISO, but no ISO is selected
        if not self.live.opts.clone and not self.is_ISO_selected():
            self.warn_ISO_not_selected()
            return

        self.begin()

    def on_infobar_response(self, infobar, response):
        self.__infobar.set_visible(False)
        self.__label_infobar_title.set_text("")
        self.__label_infobar_details.set_text("")

    def clear_log(self):
        text_buffer = self.__textview_log.get_buffer()
        text_buffer.set_text("")

    def append_to_log(self, text):
        if not text.endswith("\n"):
            text = text + "\n"
        text_buffer = self.__textview_log.get_buffer()
        text_buffer.insert(text_buffer.get_end_iter(), text)
        self.__textview_log.scroll_to_iter(text_buffer.get_end_iter(), 0, False, 0, 0)

    def update_start_button(self):
        # Make the start button insensitive if the target device already
        # contains a Tails installation (i.e. self.opts.partition is False)
        # and the "Clone the current Persistent Storage" button is checked,
        # because in that case we only support reinstalling (via the
        # separate "Reinstall (delete all data)" button).
        if (
            not self.opts.partition
            and self.__check_button_clone_persistent_storage.get_active()
        ):
            sensitive = False
        elif self.source_available and self.target_available:
            sensitive = True
        else:
            sensitive = False
        self.__button_start.set_sensitive(sensitive)

    def update_clone_persistent_storage_check_button(self):
        if not self.persistent_storage_is_created:
            self.__check_button_clone_persistent_storage.hide()
            return

        if not self.persistent_storage_is_unlocked:
            text = _(
                "Clone the current Persistent Storage\n"
                "Impossible to clone the Persistent Storage because it is locked."
            )
        elif self.opts.partition or not self.get_selected_drive():
            text = _("Clone the current Persistent Storage")
        else:
            text = _(
                "Clone the current Persistent Storage\n"
                "You can only choose to reinstall when cloning the Persistent Storage."
            )
        self.__check_button_clone_persistent_storage.set_label(text)

        sensitive = self.persistent_storage_is_unlocked and self.opts.clone
        self.__check_button_clone_persistent_storage.set_sensitive(sensitive)
        if not sensitive:
            self.__check_button_clone_persistent_storage.set_active(False)

    def populate_devices(self, *args, **kw):
        if self.target_selected:
            return

        def add_devices():
            self.__liststore_target.clear()
            self.live.log.debug("drives: %s" % self.live.drives)
            target_list = []
            for device, info in list(self.live.drives.items()):
                # Skip the device that is the source of the copy
                if (
                    self.live.source
                    and self.live.source.dev
                    and (
                        info["udi"] == self.live.source.dev
                        or info["parent_udi"] == self.live.source.dev
                    )
                ):
                    self.live.log.debug("Skipping source device: %s" % info["device"])
                    continue
                # Skip the running device
                if self.live.running_device() in [info["udi"], info["parent_udi"]]:
                    self.live.log.debug("Skipping running device: %s" % info["device"])
                    continue
                pretty_name = self.get_device_pretty_name(info)
                # Skip devices with non-removable bit enabled
                if not info["removable"]:
                    message = _(
                        'The USB stick "%(pretty_name)s"'
                        " is configured as non-removable by its"
                        " manufacturer and elizaOS will fail to start from it."
                        " Please try installing on a different model."
                    ) % {"pretty_name": pretty_name}
                    self.status(message)
                    continue
                # Skip ROM devices
                if info["read_only"]:
                    message = _('The device "%(pretty_name)s" is read-only.') % {
                        "pretty_name": pretty_name
                    }
                    self.status(message)
                    continue
                # Skip too small devices, but inform the user
                if not info["is_device_big_enough_for_installation"]:
                    message = _(
                        'The device "%(pretty_name)s"'
                        " is too small to install"
                        " elizaOS (at least %(size)s GB is required)."
                    ) % {
                        "pretty_name": pretty_name,
                        "size": (
                            float(CONFIG["official_min_installation_device_size"])
                            / 1000
                        ),
                    }
                    self.status(message)
                    continue
                # Skip devices too small for cloning, but inform the user
                if self.opts.clone and not info["is_device_big_enough_for_upgrade"]:
                    message = _(
                        'To upgrade device "%(pretty_name)s"'
                        " from this elizaOS, you need to use"
                        " a downloaded elizaOS ISO image:\n"
                        "%(dl_url)s"
                    ) % {
                        "pretty_name": pretty_name,
                        "dl_url": "https://tails.net/install/download",
                    }
                    self.status(message)
                    continue
                target_list.append([pretty_name, device])
            if len(target_list):
                self.__infobar.set_visible(False)
                for target in target_list:
                    self.__liststore_target.append(target)
                self.target_available = True
                self.__combobox_target.set_active(0)
                self.update_start_button()
            else:
                self.__infobar.set_message_type(Gtk.MessageType.INFO)
                self.__label_infobar_title.set_text(
                    _("No device suitable to install elizaOS could be found")
                )
                self.__label_infobar_details.set_text(
                    _("Plug in a USB stick of at least %0.1f GB.")
                    % (CONFIG["official_min_installation_device_size"] / 1000.0)
                )
                self.__infobar.set_visible(True)
                self.target_available = False
                self.update_start_button()
                return

        try:
            self.live.detect_supported_drives(callback=add_devices)
        except TailsInstallerError as e:
            self.__infobar.set_message_type(Gtk.MessageType.ERROR)
            self.__label_infobar_title.set_text(
                _("An error happened while installing elizaOS")
            )
            self.__label_infobar_details.set_text(e.args[0])
            self.__infobar.set_visible(True)
            self.append_to_log(str(e.args[0]))
            self.target_available = False
            self.update_start_button()

    def progress(self, value):
        self.__progressbar.set_fraction(value)

    def status(self, obj):
        try:
            if isinstance(obj, str) or isinstance(obj, str):
                text = obj
            elif (
                isinstance(obj, Exception)
                and hasattr(obj, "args")
                and type(obj.args).__name__ == "list"
            ):
                text = obj.args[0]
            else:
                text = str(obj)
            self.append_to_log(text)
        except Exception as ex:
            self.live.log.exception(
                "Failed to set status to object of type %s",
                type(obj).__name__,
            )
            raise ex

    def enable_widgets(self, enabled=True):
        if enabled:
            self.update_start_button()
            if self.force_reinstall_button_available:
                self.__button_force_reinstall.set_visible(True)
        else:
            self.__button_start.set_sensitive(False)
            self.__button_force_reinstall.set_visible(False)
        self.__box_source.set_sensitive(not self.target_selected)
        self.__combobox_target.set_sensitive(not self.target_selected)

    def get_selected_drive(self):
        drive = None
        _iter = self.__combobox_target.get_active_iter()
        if _iter is not None:
            drive = self.__liststore_target.get(_iter, 1)[0]
        if drive:
            return _to_unicode(drive)

    def on_installation_complete(self, data=None):
        # FIXME: replace content by a specific page
        dialog = Gtk.MessageDialog(
            parent=self,
            flags=Gtk.DialogFlags.DESTROY_WITH_PARENT,
            message_type=Gtk.MessageType.INFO,
            buttons=Gtk.ButtonsType.OK,
            message_format=_("Installation complete!"),
        )
        dialog.run()
        dialog.destroy()

    def show_confirmation_dialog(
        self,
        title,
        message,
        warning,
        label_string=None,
    ):
        if label_string is None:
            label_string = _("Install")
        if warning:
            buttons = Gtk.ButtonsType.OK
        else:
            buttons = Gtk.ButtonsType.NONE
        dialog = Gtk.MessageDialog(
            parent=self,
            flags=Gtk.DialogFlags.DESTROY_WITH_PARENT,
            message_type=Gtk.MessageType.QUESTION,
            buttons=buttons,
            message_format=title,
        )
        dialog.format_secondary_text(message)
        if not warning:
            dialog.add_button(_("Cancel"), Gtk.ResponseType.CANCEL)
            dialog.add_button(label_string, Gtk.ResponseType.YES)
            ok_button = dialog.get_widget_for_response(response_id=Gtk.ResponseType.YES)
            Gtk.StyleContext.add_class(
                ok_button.get_style_context(), "destructive-action"
            )
        reply = dialog.run()
        dialog.hide()
        if reply == Gtk.ResponseType.YES:
            return True
        else:
            self.target_selected = None
            self.enable_widgets(True)
            return False

    def begin(self):
        """Begin the elizaOS installation process.

        This method is called when the "Install elizaOS" button is clicked.
        """
        self.enable_widgets(False)
        if not self.target_selected:
            self.live.drive = self.get_selected_drive()
        self.target_selected = True
        for signal_match in self.signals_connected:
            signal_match.remove()

        if self.opts.partition:
            description = _(
                "%(parent_size)s %(vendor)s %(model)s device (%(device)s)"
            ) % {
                "vendor": self.live.drive["vendor"],
                "model": self.live.drive["model"],
                "device": self.live.drive["device"],
                "parent_size": _format_bytes_in_gb(
                    self.live.drive["parent_size"]
                    if self.live.drive["parent_size"]
                    else self.live.drive["size"]
                ),
            }
            if self.live.has_persistent_storage():
                delete_message = _(
                    "\n\nThe Persistent Storage on this USB stick will be lost."
                )
                confirmation_label = _("Delete Persistent Storage and Reinstall")
            else:
                delete_message = _("\n\nAll data on this USB stick will be lost.")
                confirmation_label = _("Delete All Data and Install")
            msg = _("%(description)s%(delete_message)s") % {
                "description": description,
                "delete_message": delete_message,
            }
            if not self.show_confirmation_dialog(
                _("Confirm the target USB stick"), msg, False, confirmation_label
            ):
                if self.force_reinstall_button_available:
                    self.force_reinstall = False
                    self.opts.partition = False
                self.update_start_button()
                return

        if self.opts.clone_persistent_storage_requested:
            passphrase_dialog = PassphraseDialog(self, self.live)
            passphrase_dialog.run()
            if not passphrase_dialog.passphrase:
                self.force_reinstall = False
                self.opts.partition = False
                self.target_selected = None
                self.enable_widgets(True)
                self.update_start_button()
                return
            self.live.passphrase = passphrase_dialog.passphrase

        if not self.opts.partition:
            # We delete the Live OS in order to accurately calculate
            # progress later, and make sure there are no leftover files.
            try:
                self.live.mount_device()
            except TailsInstallerError as e:
                self.status(e.args[0])
                self.enable_widgets(True)
                return
            except OSError:
                self.status(_("Unable to mount device"))
                self.enable_widgets(True)
                return
            try:
                self.live.delete_liveos()
            except TailsInstallerError as ex:
                self.status(ex.args[0])
                # self.live.unmount_device()
                self.enable_widgets(True)
                return

        # Remove the log handler, because our live thread will register its own
        self.live.log.removeHandler(self.handler)

        # If we are running in clone mode, move on.
        if self.live.opts.clone:
            self.enable_widgets(False)
            self.live_thread.start()
        # If the user has selected an ISO, use it.
        elif self.live.source.__class__ == LocalIsoSource:
            self.enable_widgets(False)
            self.live_thread.start()
        else:
            raise NotImplementedError

    def select_source_iso(self, isofile):
        if not os.access(isofile, os.R_OK):
            self.status(
                _(
                    "The selected file is unreadable. "
                    "Please fix its permissions or select another file."
                )
            )
            return False
        try:
            self.live.source = LocalIsoSource(path=isofile)
        except Exception as ex:
            self.status(
                _(
                    "Unable to use the selected file.  "
                    "You may have better luck if you move your ISO "
                    "to the root of your drive (ie: C:\\)"
                )
            )
            self.live.log.exception(ex.args[0])
            return False

        self.live.log.info(
            _("%(filename)s selected")
            % {"filename": str(os.path.basename(self.live.source.path))}
        )
        self.source_available = True
        self.live.log.debug("Calling populate_devices() from select_source_iso")
        self.populate_devices()

    def terminate(self):
        """Final clean up"""
        self.live.terminate()
