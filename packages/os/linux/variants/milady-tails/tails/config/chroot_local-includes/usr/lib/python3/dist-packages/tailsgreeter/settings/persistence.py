# Copyright 2012-2016 Tails developers <foundations@tails.net>
# Copyright 2011 Max <govnototalitarizm@gmail.com>
# Copyright 2011 Martin Owens
#
# This program is free software: you can redistribute it and/or modify
#  it under the terms of the GNU General Public License as published by
#  the Free Software Foundation, either version 3 of the License, or
#  (at your option) any later version.
#
#  This program is distributed in the hope that it will be useful,
#  but WITHOUT ANY WARRANTY; without even the implied warranty of
#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#  GNU General Public License for more details.
#
#  You should have received a copy of the GNU General Public License
#  along with this program.  If not, see <http://www.gnu.org/licenses/>
#
"""Persistent Storage handling"""
import gettext
import logging
import os
from typing import Optional

from gi.repository import Gio, GLib

import tailsgreeter.errors
import tps.dbus.errors as tps_errors
from tailsgreeter import config  # NOQA: E402
from tps import InvalidBootDeviceErrorType


_ = gettext.gettext

BUS_NAME = "org.boum.tails.PersistentStorage"
OBJECT_PATH = "/org/boum/tails/PersistentStorage"
INTERFACE_NAME = "org.boum.tails.PersistentStorage"


class PersistentStorageSettings:
    """Controller for settings related to Persistent Storage"""

    def __init__(self) -> None:
        self.failed_with_unrecoverable_error = False
        self.cleartext_name = "TailsData_unlocked"
        self.cleartext_device = "/dev/mapper/" + self.cleartext_name
        self.service_proxy = Gio.DBusProxy.new_sync(
            Gio.bus_get_sync(Gio.BusType.SYSTEM, None),
            Gio.DBusProxyFlags.NONE,
            None,
            BUS_NAME,
            OBJECT_PATH,
            INTERFACE_NAME,
            None,
        )  # type: Gio.DBusProxy
        device_variant = self.service_proxy.get_cached_property("Device")  # type: GLib.Variant
        self.device = device_variant.get_string() if device_variant else "/"
        self.is_unlocked = False
        self.is_created = self.service_proxy.get_cached_property("IsCreated")
        self.can_unlock = self.service_proxy.get_cached_property("CanUnlock")
        self.is_upgraded = self.service_proxy.get_cached_property("IsUpgraded")
        self.error: GLib.Variant = self.service_proxy.get_cached_property("Error")
        self.error_type: InvalidBootDeviceErrorType | None = None
        if self.error:
            self.error_type = InvalidBootDeviceErrorType(self.error.get_uint32())
        self.service_proxy.connect("g-properties-changed", self.on_properties_changed)

    def on_properties_changed(
        self,
        proxy: Gio.DBusProxy,
        changed_properties: GLib.Variant,
        invalidated_properties: list[str],
    ):
        """Callback for when the Persistent Storage properties change"""
        logging.debug("changed properties: %s", changed_properties)
        keys = set(changed_properties.keys())

        if "CanUnlock" in keys:
            self.can_unlock = changed_properties["CanUnlock"]
        if "Error" in keys:
            self.error = changed_properties["Error"]
            if self.error:
                self.error_type = InvalidBootDeviceErrorType(self.error.get_uint32())
        if "IsCreated" in keys:
            self.is_created = changed_properties["IsCreated"]
        if "IsUpgraded" in keys:
            self.is_upgraded = changed_properties["IsUpgraded"]
        if "Device" in keys:
            self.device = changed_properties["Device"]

    def unlock(self, passphrase: str):
        """Unlock the Persistent Storage partition

        Raises:
            * WrongPassphraseError if the passphrase is incorrect.
            * FilesystemErrorsLeftUncorrectedError if `e2fsck -f -p`
              found some errors that it could not correct.
            * PersistentStorageError if something else went wrong."""
        logging.debug("Unlocking Persistent Storage")

        try:
            self.service_proxy.call_sync(
                method_name="Unlock",
                parameters=GLib.Variant("(s)", (passphrase,)),
                flags=Gio.DBusCallFlags.NONE,
                # In some cases, the default timeout of 25 seconds was not
                # enough, especially since we now run fsck as part of the unlock
                # operation, so we use a larger timeout instead.
                timeout_msec=480000,
            )
        except GLib.GError as err:
            if tps_errors.IncorrectPassphraseError.is_instance(err):
                raise tailsgreeter.errors.WrongPassphraseError from err

            # All of the following errors are considered unrecoverable
            # (so we don't ask the user to unlock before starting Tails)
            self.failed_with_unrecoverable_error = True

            if tps_errors.IOErrorsDetectedError.is_instance(err):
                raise tailsgreeter.errors.IOErrorsDetectedError from err

            if tps_errors.FilesystemErrorsLeftUncorrectedError.is_instance(err):
                raise tailsgreeter.errors.FilesystemErrorsLeftUncorrectedError from err

            raise tailsgreeter.errors.PersistentStorageError(
                _("Error unlocking Persistent Storage: {}").format(err)
            ) from err
        self.is_unlocked = True

    def upgrade_luks(self, passphrase):
        """Upgrade the Persistent Storage to the latest format

        Raises:
            WrongPassphraseError if the passphrase is incorrect.
            PersistentStorageError if something else went wrong."""
        logging.debug("Upgrading Persistent Storage")
        try:
            self.service_proxy.call_sync(
                method_name="UpgradeLUKS",
                parameters=GLib.Variant("(s)", (passphrase,)),
                flags=Gio.DBusCallFlags.NONE,
                # GLib.MAXINT (largest 32-bit signed integer) disables
                # the timeout
                timeout_msec=GLib.MAXINT,
            )
        except GLib.GError as err:
            if tps_errors.IncorrectPassphraseError.is_instance(err):
                raise tailsgreeter.errors.WrongPassphraseError from err
            self.failed_with_unrecoverable_error = True
            raise tailsgreeter.errors.PersistentStorageError(
                _("Error upgrading Persistent Storage: {}").format(err)
            ) from err

    def activate_persistent_storage(self):
        """Activate the already unlocked Persistent Storage"""
        try:
            self.service_proxy.call_sync(
                method_name="Activate",
                parameters=None,
                flags=Gio.DBusCallFlags.NONE,
                # We have seen this take almost 4 minutes (tails/tails#19944)
                # so let's try 5 minutes for now. We don't want to disable
                # the timeout completely (yet) since we still want to catch
                # situations where e.g. some of our on-activation scripts
                # gets in an infinite loop or similar.
                timeout_msec=300000,
            )
        except GLib.GError as err:
            if tps_errors.FeatureActivationFailedError.is_instance(err):
                tps_errors.FeatureActivationFailedError.strip_remote_error(err)
                features = err.message.split(":")
                # translate feature names
                features = [config.gettext(feature) for feature in features]
                # Translators: Don't translate {features}, it's a placeholder
                # and will be replaced.
                msg = config.gettext(
                    "Failed to activate some features of the Persistent Storage: {features}."
                ).format(features=", ".join(features))
                raise tailsgreeter.errors.FeatureActivationFailedError(msg) from err
            self.failed_with_unrecoverable_error = True
            raise tailsgreeter.errors.PersistentStorageError(
                _("Error activating Persistent Storage: {}").format(err)
            ) from err

    def abort_repair_filesystem(self):
        """Abort any ongoing filesystem check on the Persistent
        Storage.

        Raises PersistentStorageError if something went wrong."""

        try:
            self.service_proxy.call_sync(
                method_name="AbortRepairFilesystem",
                parameters=None,
                flags=Gio.DBusCallFlags.NONE,
                # GLib.MAXINT (largest 32-bit signed integer) disables
                # the timeout
                timeout_msec=GLib.MAXINT,
            )
        except GLib.GError as err:
            raise tailsgreeter.errors.PersistentStorageError(
                _(
                    "Failed to abort when repairing Persistent Storage filesystem: {}"
                ).format(err)
            ) from err

    def repair_filesystem(self, finish_callback: callable) -> Gio.Cancellable:
        """Asynchronously start a forceful filesystem check (e2fsck -f -y)
        on the Persistent Storage.

        The finish_callback is called once the operation has finished
        and will receive any errors raised during the operation.

        Returns a Gio.Cancellable so the caller can abort the
        filesystem check by calling its cancel() method.

        Raises PersistentStorageError if something went wrong."""

        cancellable = Gio.Cancellable()

        self.service_proxy.call(
            method_name="RepairFilesystem",
            parameters=None,
            flags=Gio.DBusCallFlags.NONE,
            # GLib.MAXINT (largest 32-bit signed integer) disables
            # the timeout
            timeout_msec=GLib.MAXINT,
            cancellable=cancellable,
            callback=finish_callback,
        )

        return cancellable
