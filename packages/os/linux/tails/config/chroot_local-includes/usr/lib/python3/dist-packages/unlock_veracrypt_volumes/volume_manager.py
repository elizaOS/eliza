import subprocess
import time
import os
from logging import getLogger
from typing import Union
from threading import Lock

from gi.repository import Gtk, Gio, UDisks, GUdev, GLib

from unlock_veracrypt_volumes import _
from unlock_veracrypt_volumes.volume_list import ContainerList, DeviceList
from unlock_veracrypt_volumes.volume import Volume
from unlock_veracrypt_volumes.exceptions import (
    UdisksObjectNotFoundError,
    VolumeNotFoundError,
)
from unlock_veracrypt_volumes.config import MAIN_UI_FILE, TRANSLATION_DOMAIN


WAIT_FOR_LOOP_SETUP_TIMEOUT = 1


logger = getLogger(__name__)


class VolumeManager:
    def __init__(self, application: Gtk.Application):
        self.udisks_client = UDisks.Client.new_sync()
        self.udisks_manager = self.udisks_client.get_manager()
        self.gio_volume_monitor = Gio.VolumeMonitor.get()
        self.gio_volume_monitor.connect("volume-changed", self.on_volume_changed)
        self.gio_volume_monitor.connect("volume-added", self.on_volume_added)
        self.gio_volume_monitor.connect("volume-removed", self.on_volume_removed)
        self.udev_client = GUdev.Client()
        self.mount_op_lock = Lock()

        self.builder = Gtk.Builder.new_from_file(MAIN_UI_FILE)
        self.builder.set_translation_domain(TRANSLATION_DOMAIN)
        self.builder.connect_signals(self)

        self.window = self.builder.get_object("window")  # type: Gtk.ApplicationWindow
        self.window.set_application(application)
        self.window.set_title(_("Unlock VeraCrypt Volumes"))

        self.container_list = ContainerList()
        self.device_list = DeviceList()

        containers_frame = self.builder.get_object("containers_frame")
        containers_frame.add(self.container_list.list_box)
        devices_frame = self.builder.get_object("devices_frame")
        devices_frame.add(self.device_list.list_box)

        self.add_tcrypt_volumes()

        logger.debug("showing window")
        self.window.show_all()
        self.window.present()

    def add_tcrypt_volumes(self):
        logger.debug("in add_tcrypt_volumes")
        for volume in self.get_tcrypt_volumes():
            self.add_volume(volume)

    def add_volume(self, volume: Volume):
        logger.info("Adding volume %s", volume.device_file)
        if volume.is_file_container:
            self.container_list.add(volume)
        else:
            self.device_list.add(volume)

    def remove_volume(self, volume: Volume):
        logger.info("Removing volume %s", volume.device_file)
        if volume in self.container_list:
            self.container_list.remove(volume)
        elif volume in self.device_list:
            self.device_list.remove(volume)

    def update_volume(self, volume: Volume):
        logger.debug("Updating volume %s", volume.device_file)
        if volume.is_file_container:
            self.container_list.remove(volume)
            self.container_list.add(volume)
        else:
            self.device_list.remove(volume)
            self.device_list.add(volume)

    def get_tcrypt_volumes(self) -> list[Volume]:
        """Returns all connected TCRYPT volumes"""
        return [volume for volume in self.get_all_volumes() if volume.is_tcrypt]

    def get_all_volumes(self) -> list[Volume]:
        """Returns all connected volumes"""
        volumes = list()
        gio_volumes = self.gio_volume_monitor.get_volumes()

        for gio_volume in gio_volumes:
            device_file = gio_volume.get_identifier(
                Gio.VOLUME_IDENTIFIER_KIND_UNIX_DEVICE
            )
            if not device_file:
                continue

            logger.debug("volume: %s", device_file)

            try:
                volumes.append(Volume(self, gio_volume))
                logger.debug("is_file_container: %s", volumes[-1].is_file_container)
                logger.debug("is_tcrypt: %s", volumes[-1].is_tcrypt)
                logger.debug("is_unlocked: %s", volumes[-1].is_unlocked)
            except UdisksObjectNotFoundError as e:
                logger.exception(e)

        return volumes

    def on_add_file_container_button_clicked(self, button, data=None):
        path = self.choose_container_path()

        if path in self.container_list.backing_file_paths:
            self.show_warning(
                title=_("Container already added"),
                body=_("The file container %s should already be listed.") % path,
            )
            return

        if path:
            self.attach_file_container(path)

    def attach_file_container(self, path: str) -> Union[Volume, None]:
        logger.debug(
            "attaching file %s. backing_file_paths: %s",
            path,
            self.container_list.backing_file_paths,
        )
        warning = dict()

        try:
            fd = os.open(path, os.O_RDWR)
        except PermissionError as e:
            # Try opening read-only
            try:
                fd = os.open(path, os.O_RDONLY)
                warning["title"] = _("Container opened read-only")
                # Translators: Don't translate {path}, it's a placeholder  and will be replaced.
                warning["body"] = _(
                    "The file container {path} could not be opened with write access. "
                    "It was opened read-only instead. You will not be able to modify the "
                    "content of the container.\n"
                    "{error_message}"
                ).format(path=path, error_message=str(e))
            except PermissionError as e:
                self.show_warning(title=_("Error opening file"), body=str(e))
                return None

        fd_list = Gio.UnixFDList()
        fd_list.append(fd)
        udisks_path, __ = self.udisks_manager.call_loop_setup_sync(
            GLib.Variant("h", 0),  # fd index
            GLib.Variant("a{sv}", {}),  # options
            fd_list,  # the fd list
            None,
        )  # cancellable
        logger.debug("Created loop device %s", udisks_path)

        volume = self._wait_for_loop_setup(path)
        if volume:
            if warning:
                self.show_warning(title=warning["title"], body=warning["body"])
            return volume
        elif not self._udisks_object_is_tcrypt(udisks_path):
            # Remove the loop device
            self.udisks_client.get_object(udisks_path).get_loop().call_delete(
                GLib.Variant("a{sv}", {}),  # options
                None,  # cancellable
                None,  # callback
                None,
            )  # user data
            self.show_warning(
                title=_("Not a VeraCrypt container"),
                body=_("The file %s does not seem to be a VeraCrypt container.") % path,
            )
        else:
            self.show_warning(
                title=_("Failed to add container"),
                body=_(
                    "Could not add file container %s: Timeout while waiting for loop setup.\n"
                    "Please try using the <i>Disks</i> application instead."
                )
                % path,
            )

    def _wait_for_loop_setup(self, path: str) -> Union[Volume, None]:
        start_time = time.perf_counter()
        while time.perf_counter() - start_time < WAIT_FOR_LOOP_SETUP_TIMEOUT:
            try:
                return self.container_list.find_by_backing_file(path)
            except VolumeNotFoundError:
                self.process_mainloop_events()
                time.sleep(0.1)

    def _udisks_object_is_tcrypt(self, path: str) -> bool:
        if not path:
            return False

        udisks_object = self.udisks_client.get_object(path)
        if not udisks_object:
            return False

        return Volume(self, udisks_object=udisks_object).is_tcrypt

    @staticmethod
    def process_mainloop_events():
        context = GLib.MainLoop().get_context()
        while context.pending():
            context.iteration()

    def open_file_container(self, path: str):
        volume = self.ensure_file_container_is_attached(path)
        if volume:
            volume.open_()

    def unlock_file_container(self, path: str, open_after_unlock=False):
        volume = self.ensure_file_container_is_attached(path)
        if volume:
            volume.unlock(open_after_unlock=open_after_unlock)

    def ensure_file_container_is_attached(self, path: str) -> Volume:
        try:
            return self.container_list.find_by_backing_file(path)
        except VolumeNotFoundError:
            return self.attach_file_container(path)

    def file_container_is_attached(self, path: str) -> bool:
        try:
            self.container_list.find_by_backing_file(path)
            return True
        except VolumeNotFoundError:
            return False

    def choose_container_path(self):
        dialog = Gtk.FileChooserDialog(
            _("Choose File Container"),
            self.window,
            Gtk.FileChooserAction.OPEN,
            (
                Gtk.STOCK_CANCEL,
                Gtk.ResponseType.CANCEL,
                Gtk.STOCK_OPEN,
                Gtk.ResponseType.ACCEPT,
            ),
        )
        result = dialog.run()
        if result != Gtk.ResponseType.ACCEPT:
            dialog.destroy()
            return

        path = dialog.get_filename()
        dialog.destroy()
        return path

    def on_volume_changed(
        self, volume_monitor: Gio.VolumeMonitor, gio_volume: Gio.Volume
    ):
        logger.debug(
            "in on_volume_changed. volume: %s",
            gio_volume.get_identifier(Gio.VOLUME_IDENTIFIER_KIND_UNIX_DEVICE),
        )
        try:
            volume = Volume(self, gio_volume)
            if volume.is_tcrypt:
                self.update_volume(volume)
        except UdisksObjectNotFoundError:
            self.remove_volume(Volume(self, gio_volume, with_udisks=False))

    def on_volume_added(
        self, volume_monitor: Gio.VolumeMonitor, gio_volume: Gio.Volume
    ):
        logger.debug(
            "in on_volume_added. volume: %s",
            gio_volume.get_identifier(Gio.VOLUME_IDENTIFIER_KIND_UNIX_DEVICE),
        )
        volume = Volume(self, gio_volume)
        if volume.is_tcrypt:
            self.add_volume(volume)

    def on_volume_removed(
        self, volume_monitor: Gio.VolumeMonitor, gio_volume: Gio.Volume
    ):
        logger.debug(
            "in on_volume_removed. volume: %s",
            gio_volume.get_identifier(Gio.VOLUME_IDENTIFIER_KIND_UNIX_DEVICE),
        )
        self.remove_volume(Volume(self, gio_volume, with_udisks=False))

    def open_uri(self, uri: str):
        Gtk.show_uri_on_window(self.window, uri, Gtk.get_current_event_time())

    def show_warning(self, title: str, body: str):
        dialog = Gtk.MessageDialog(
            self.window,
            Gtk.DialogFlags.DESTROY_WITH_PARENT,
            Gtk.MessageType.WARNING,
            Gtk.ButtonsType.CLOSE,
            title,
        )
        dialog.format_secondary_markup(body)
        # Make the body selectable to allow users to easily copy/paste the error message
        dialog.get_message_area().get_children()[-1].set_selectable(True)

        dialog.run()
        dialog.close()

    def acquire_mount_op_lock(self):
        while True:
            if self.mount_op_lock.acquire(timeout=0.1):
                return
            self.process_mainloop_events()
