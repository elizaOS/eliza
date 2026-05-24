import gi

from logging import getLogger
from typing import Union

from unlock_veracrypt_volumes import _
from unlock_veracrypt_volumes.config import TRANSLATION_DOMAIN, VOLUME_UI_FILE
from unlock_veracrypt_volumes.exceptions import (
    UdisksObjectNotFoundError,
    AlreadyUnlockedError,
)

gi.require_version("Gtk", "3.0")
gi.require_version("GLib", "2.0")
gi.require_version("Gio", "2.0")
from gi.repository import Gtk, GLib, Gio, UDisks  # noqa: E402


logger = getLogger(__name__)


class Volume:
    def __init__(
        self,
        manager,
        gio_volume: Gio.Volume = None,
        udisks_object: UDisks.Object = None,
        with_udisks=True,
    ):
        self.manager = manager
        self.udisks_client = manager.udisks_client
        self.udev_client = manager.udev_client
        self.gio_volume = gio_volume

        if udisks_object:
            self.udisks_object = udisks_object
        elif self.gio_volume and with_udisks:
            self.udisks_object = self._find_udisks_object()
        else:
            self.udisks_object = None

        self.spinner_is_showing = False
        self.dialog_is_showing = False

        self.builder = Gtk.Builder.new_from_file(VOLUME_UI_FILE)
        self.builder.set_translation_domain(TRANSLATION_DOMAIN)
        self.builder.connect_signals(self)
        self.list_box_row = self.builder.get_object(
            "volume_row"
        )  # type: Gtk.ListBoxRow
        self.box = self.builder.get_object("volume_box")  # type: Gtk.Box
        self.label = self.builder.get_object("volume_label")  # type: Gtk.Label
        self.button_box = self.builder.get_object(
            "volume_button_box"
        )  # type: Gtk.ButtonBox
        self.open_button = self.builder.get_object("open_button")  # type: Gtk.Button
        self.lock_button = self.builder.get_object("lock_button")  # type: Gtk.Button
        self.unlock_button = self.builder.get_object(
            "unlock_button"
        )  # type: Gtk.Button
        self.detach_button = self.builder.get_object(
            "detach_button"
        )  # type: Gtk.Button
        self.spinner = Gtk.Spinner(visible=True, margin_right=10)

    def __eq__(self, other: "Volume"):
        return self.device_file == other.device_file

    @property
    def name(self) -> str:
        """Short description for display to the user. The block device
        label or partition label, if any, plus the size"""
        block_label = self.udisks_object.get_block().props.id_label
        partition = self.udisks_object.get_partition()
        if block_label:
            # Translators: Don't translate {volume_label} or {volume_size},
            # they are placeholders and will be replaced. They need
            # to be present in the translated string.
            return _("{volume_label} ({volume_size})").format(
                volume_label=block_label, volume_size=self.size_for_display
            )
        elif partition and partition.props.name:
            # Translators: Don't translate {partition_name} or {partition_size},
            # they are placeholders and will be replaced. They need
            # to be present in the translated string.
            return _("{partition_name} ({partition_size})").format(
                partition_name=partition.props.name,
                partition_size=self.size_for_display,
            )
        else:
            # Translators: Don't translate {volume_size}, it's a placeholder
            # and will be replaced. It needs to be present in the translated
            # string.
            return _("{volume_size} Volume").format(volume_size=self.size_for_display)

    @property
    def size_for_display(self) -> str:
        size = self.udisks_object.get_block().props.size
        return self.udisks_client.get_size_for_display(
            size, use_pow2=False, long_string=False
        )

    @property
    def drive_name(self) -> str:
        if self.is_file_container:
            return ""

        if self.is_unlocked:
            drive_object = self.udisks_client.get_object(
                self.backing_udisks_object.get_block().props.drive
            )
        else:
            drive_object = self.drive_object

        if drive_object:
            return "{} {}".format(
                drive_object.get_drive().props.vendor,
                drive_object.get_drive().props.model,
            )
        else:
            return ""

    @property
    def backing_file_name(self) -> str:
        if not self.is_file_container:
            return ""
        if self.is_unlocked:
            return self.backing_udisks_object.get_loop().props.backing_file
        elif self.is_loop_device:
            return self.udisks_object.get_loop().props.backing_file
        elif self.partition_table_object and self.partition_table_object.get_loop():
            return self.partition_table_object.get_loop().props.backing_file

    @property
    def description(self) -> str:
        """Longer description for display to the user."""
        if self.udisks_object.get_block().props.read_only:
            # Translators: Don't translate {volume_name}, it's a placeholder and
            # will be replaced. It needs to be present in the translated string.
            desc = _("{volume_name} (Read-Only)").format(volume_name=self.name)
        else:
            desc = self.name

        if self.partition_table_object and self.partition_table_object.get_loop():
            # This is a partition of a loop device, so lets include the backing file name
            # Translators: Don't translate {partition_name} and {container_path}, they
            # are placeholders and will be replaced. They need to be present
            # in the translated string.
            return _("{partition_name} in {container_path}").format(
                partition_name=desc, container_path=self.backing_file_name
            )
        elif self.is_file_container:
            # This is file container, lets include the file name
            # Translators: Don't translate {volume_name} and {path_to_file_container},
            # they are placeholders and will be replaced. You should only have to translate
            # this string if it makes sense to reverse the order of the placeholders.
            return _("{volume_name} – {path_to_file_container}").format(  # noqa: RUF001
                volume_name=desc, path_to_file_container=self.backing_file_name
            )
        elif self.is_partition and self.drive_object:
            # This is a partition on a drive, lets include the drive name
            # Translators: Don't translate {partition_name} and {drive_name}, they
            # are placeholders and will be replaced. They need to be present
            # in the translated string.
            return _("{partition_name} on {drive_name}").format(
                partition_name=desc, drive_name=self.drive_name
            )
        elif self.drive_name:
            # This is probably an unpartitioned drive, so lets include the drive name
            # Translators: Don't translate {volume_name} and {drive_name},
            # they are placeholders and will be replaced. You should only have to translate
            # this string if it makes sense to reverse the order of the placeholders.
            return _("{volume_name} – {drive_name}").format(  # noqa: RUF001
                volume_name=desc, drive_name=self.drive_name
            )
        else:
            return desc

    @property
    def device_file(self) -> str:
        if self.gio_volume:
            return self.gio_volume.get_identifier(
                Gio.VOLUME_IDENTIFIER_KIND_UNIX_DEVICE
            )
        elif self.udisks_object:
            return self.udisks_object.get_block().props.device

    @property
    def backing_volume(self) -> Union["Volume", None]:
        if self.backing_udisks_object:
            return Volume(self.manager, udisks_object=self.backing_udisks_object)
        return None

    @property
    def backing_udisks_object(self) -> Union[UDisks.Object, None]:
        return self.udisks_client.get_object(
            self.udisks_object.get_block().props.crypto_backing_device
        )

    @property
    def partition_table_object(self) -> Union[UDisks.Object, None]:
        if not self.udisks_object.get_partition():
            return None
        return self.udisks_client.get_object(
            self.udisks_object.get_partition().props.table
        )

    @property
    def drive_object(self) -> Union[UDisks.Object, None]:
        return self.udisks_client.get_object(self.udisks_object.get_block().props.drive)

    @property
    def is_unlocked(self) -> bool:
        return bool(self.backing_udisks_object)

    @property
    def is_loop_device(self) -> bool:
        return bool(self.udisks_object.get_loop())

    @property
    def is_loop_device_partition(self) -> bool:
        return bool(
            self.partition_table_object and self.partition_table_object.get_loop()
        )

    @property
    def is_partition(self) -> bool:
        return bool(self.udisks_object.get_partition())

    @property
    def is_tcrypt(self) -> bool:
        if self.is_unlocked:
            udisks_object = self.backing_udisks_object
        else:
            udisks_object = self.udisks_object

        return bool(
            udisks_object.get_encrypted()
            and udisks_object.get_block().props.id_type
            in ("crypto_TCRYPT", "crypto_unknown")
        )

    @property
    def is_file_container(self) -> bool:
        if "/dev/loop" in self.device_file:
            return True

        if "/dev/dm" in self.device_file:
            return bool(
                self.backing_udisks_object and self.backing_udisks_object.get_loop()
            )

    def unlock(self, open_after_unlock=False):
        def on_mount_operation_reply(
            mount_op: Gtk.MountOperation, result: Gio.MountOperationResult
        ):
            logger.debug("in on_mount_operation_reply")
            if result == Gio.MountOperationResult.HANDLED:
                self.show_spinner()

        def mount_cb(gio_volume: Gio.Volume, result: Gio.AsyncResult):
            logger.debug("in mount_cb")
            self.hide_spinner()
            try:
                gio_volume.mount_finish(result)
            except GLib.Error as e:
                if e.code == Gio.IOErrorEnum.FAILED_HANDLED:
                    logger.warning("Couldn't unlock volume: %s:", e.message)
                    return

                logger.exception(e)

                if (
                    "No key available with this passphrase" in e.message
                    or "No device header detected with this passphrase" in e.message
                    or "Failed to load device's parameters" in e.message
                ):
                    title = _("Wrong passphrase or parameters")
                else:
                    title = _("Error unlocking volume")

                # Translators: Don't translate {volume_name} or {error_message},
                # they are placeholder and will be replaced.  They need
                # to be present in the translated string.
                body = _(
                    "Couldn't unlock volume {volume_name}:\n{error_message}",
                ).format(volume_name=self.name, error_message=e.message)
                self.manager.show_warning(title, body)
                return
            finally:
                self.manager.mount_op_lock.release()

            if open_after_unlock:
                # The GVolume now changed from the loop device to the dm device, so
                # by also updating the udisks object we change this volume from the
                # crypto backing loop device to the unlocked device-mapper device,
                # which we can then open
                self.udisks_object = self._find_udisks_object()
                self.open_()

        if self.is_unlocked:
            raise AlreadyUnlockedError(
                "Volume %s is already unlocked" % self.device_file
            )

        logger.info("Unlocking volume %s", self.device_file)
        self.dialog_is_showing = False
        mount_operation = Gtk.MountOperation()
        mount_operation.set_username("user")
        mount_operation.connect("reply", on_mount_operation_reply)

        # Things break if multiple mount operations are running at the same time,
        # so we use a lock to prevent that
        self.manager.acquire_mount_op_lock()
        self.gio_volume.mount(
            0,  # Gio.MountMountFlags
            mount_operation,  # Gtk.MountOperation
            None,  # Gio.Cancellable
            mount_cb,
        )  # callback

    def lock(self):
        logger.info("Locking volume %s", self.device_file)
        self.udisks_object.get_encrypted().call_lock_sync(
            GLib.Variant("a{sv}", {}), None  # options
        )  # cancellable

    def ensure_not_mounted(self):
        filesystem = self.udisks_object.get_filesystem()
        if not filesystem:
            logger.info("Volume %s is not mounted", self.device_file)
            return

        logger.info("Unmounting volume %s", self.device_file)
        while filesystem.props.mount_points:
            try:
                filesystem.call_unmount_sync(
                    GLib.Variant("a{sv}", {}), None  # options
                )  # cancellable
            except GLib.Error as e:
                if (
                    e.domain == "udisks-error-quark"
                    and e.code == UDisks.Error.NOT_MOUNTED
                ):
                    return
                raise

    def detach_loop_device(self):
        logger.info("Detaching volume %s", self.device_file)
        if self.is_loop_device:
            self.udisks_object.get_loop().call_delete_sync(
                GLib.Variant("a{sv}", {}), None  # options
            )  # cancellable
        elif self.is_loop_device_partition:
            self.partition_table_object.get_loop().call_delete_sync(
                GLib.Variant("a{sv}", {}), None  # options
            )  # cancellable

    def open_(self):
        logger.info("Opening volume %s", self.device_file)
        mount_points = self.udisks_object.get_filesystem().props.mount_points
        if not mount_points:
            self.mount()
            self.open_()
        else:
            self.manager.open_uri(GLib.filename_to_uri(mount_points[0]))

    def mount(self):
        logger.info("Mounting volume %s", self.device_file)
        self.udisks_object.get_filesystem().call_mount_sync(
            GLib.Variant("a{sv}", {}), None  # options
        )  # cancellable

    def show_spinner(self):
        logger.debug("in show_spinner")
        self.button_box.hide()
        self.button_box.set_no_show_all(True)
        self.box.add(self.spinner)
        self.spinner.start()
        self.spinner.show()

    def hide_spinner(self):
        logger.debug("in hide_spinner")
        self.button_box.set_no_show_all(False)
        self.button_box.show()
        self.spinner.stop()
        self.box.remove(self.spinner)

    def on_lock_button_clicked(self, button):
        logger.debug("in on_lock_button_clicked")
        loop = self.backing_volume.udisks_object.get_loop()
        if loop:
            # Ensure that the loop device is removed after locking the volume
            loop.call_set_autoclear_sync(
                True, GLib.Variant("a{sv}", {}), None  # options
            )  # cancellable
        try:
            self.ensure_not_mounted()
            self.backing_volume.lock()
        except GLib.Error as e:
            # Show a more helpful message for the known error cases
            if e.domain == "udisks-error-quark" and e.code == UDisks.Error.DEVICE_BUSY:
                body = _("One or more applications are keeping the volume busy.")
            # Show a general error message and print the detailed, technical
            # message in unknown error cases
            else:
                # Translators: Don't translate {volume_name} or {error_message},
                # they are placeholder and will be replaced. They need
                # to be present in the translated string.
                body = _(
                    "Couldn't lock volume {volume_name}:\n{error_message}",
                ).format(volume_name=self.name, error_message=e.message)
            self.manager.show_warning(_("Locking the volume failed"), body)
            return

    def on_unlock_button_clicked(self, button):
        logger.debug("in on_unlock_button_clicked")
        self.unlock()

    def on_detach_button_clicked(self, button):
        logger.debug("in on_detach_button_clicked")
        self.detach_loop_device()

    def on_open_button_clicked(self, button):
        logger.debug("in on_open_button_clicked")
        self.open_()

    def update_list_box_row(self):
        logger.debug("in update_list_box_row. is_unlocked: %s", self.is_unlocked)
        self.label.set_label(self.description)
        self.open_button.set_visible(self.is_unlocked)
        self.lock_button.set_visible(self.is_unlocked)
        self.unlock_button.set_visible(not self.is_unlocked)
        self.detach_button.set_visible(
            not self.is_unlocked
            and (self.is_loop_device or self.is_loop_device_partition)
        )

    def _find_udisks_object(self) -> UDisks.Object:
        device_file = self.gio_volume.get_identifier(
            Gio.VOLUME_IDENTIFIER_KIND_UNIX_DEVICE
        )
        if not device_file:
            raise UdisksObjectNotFoundError("Couldn't get device file for volume")

        udev_volume = self.udev_client.query_by_device_file(device_file)
        if not udev_volume:
            raise UdisksObjectNotFoundError(
                "Couldn't get udev volume for %s" % device_file
            )

        device_number = udev_volume.get_device_number()
        udisks_block = self.udisks_client.get_block_for_dev(device_number)
        if not udisks_block:
            raise UdisksObjectNotFoundError(
                "Couldn't get UDisksBlock for volume %s" % device_file
            )

        object_path = udisks_block.get_object_path()
        return self.udisks_client.get_object(object_path)
