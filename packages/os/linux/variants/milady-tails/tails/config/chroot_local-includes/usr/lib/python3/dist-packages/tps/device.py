import json
import os
import subprocess
import tempfile
from pathlib import Path
import time
import re
import signal
import stat
from typing import Optional
from collections.abc import Callable

import psutil
from gi.repository import GLib, UDisks, Gio

from tailslib import LIVE_USER_UID, LIVE_USERNAME
import tailslib.utils
import tps.logging
from tps import executil, LUKS_HEADER_BACKUP_PATH
from tps import _, TPS_MOUNT_POINT, udisks
from tps import InvalidBootDeviceErrorType
from tps.dbus.errors import (
    IncorrectPassphraseError,
    TargetIsBusyError,
    NotEnoughMemoryError,
    FilesystemRepairFailure,
    FilesystemErrorsLeftUncorrectedError,
    FilesystemRepairAborted,
)
from tps.job import Job

logger = tps.logging.get_logger(__name__)

PARTITION_GUID = "8DA63339-0007-60C0-C436-083AC8230908"  # Linux reserved
TPS_PARTITION_LABEL = "TailsData"
UDISKS_BLOCK_DEVICES_PATH = "/org/freedesktop/UDisks2/block_devices"

# Leave at least 200 MiB of memory to the system to avoid triggering the
# OOM killer.
MEMORY_LEFT_TO_SYSTEM_KIB = 200 * 1024

# Use at least 256 MiB of memory for Argon2id. That should be low enough
# that even when the system doesn't have enough available memory, the
# user can free up some memory by closing applications and try again.
# It's also well within the range that's chosen by cryptsetup by default
# (32 KiB to 1 GiB).
MINIMUM_PBKDF_MEMORY_KIB = 256 * 1024

# This is the maximum value that's chosen by cryptsetup by default and
# it's low enough that even the lowest-end devices we support (3 GiB
# RAM) can still unlock the Persistent Storage:
#  - at the Welcome Screen;
#  - logged into GNOME in another Tails
#    (https://tails.net/doc/persistent_storage/recover/#rsync)
#    as of Tails 7.2;
#  - from another operating system, that likely will have swap.
DESIRED_PBKDF_MEMORY_KIB = 1 * 1024 * 1024


class InvalidPartitionError(Exception):
    pass


class PartitionNotUnlockedError(Exception):
    pass


class InvalidBootDeviceError(Exception):
    # Assume that any problem that's not handled differently in specific subclasses
    # is the result of installing Tails in an unsupported manner.
    error_type: (
        InvalidBootDeviceErrorType
    ) = InvalidBootDeviceErrorType.UNSUPPORTED_INSTALLATION_METHOD


class InvalidPartitionTableTypeError(InvalidBootDeviceError):
    def __init__(self, partition_table_type: str):
        super().__init__(f"Partition table type: {partition_table_type}")


class InvalidCleartextDeviceError(Exception):
    pass


class InvalidStatError(Exception):
    pass


class BootDevice:
    def __init__(self, udisks_object: UDisks.Object):
        self.udisks_object = udisks_object
        self.partition_table = udisks_object.get_partition_table()  # type: UDisks.PartitionTable
        if not self.partition_table:
            # Note: This error is expected when the boot device is a DVD
            raise InvalidBootDeviceError("Device has no partition table")
        partition_table_type = self.partition_table.props.type
        if partition_table_type != "gpt":
            raise InvalidPartitionTableTypeError(partition_table_type)
        self.block = self.udisks_object.get_block()
        if not self.block:
            raise InvalidBootDeviceError("Device is not a block device")
        self.device_path = self.block.props.device

    @classmethod
    def get_tails_boot_device(cls) -> "BootDevice":
        """Get the device which Tails was booted from.
        Raises an InvalidBootDeviceError if it can't be found."""
        device_path = tailslib.utils.get_boot_device()
        logger.info(f"Boot device: {device_path}")
        device_basename = os.path.basename(device_path)
        udisks_obj_path = os.path.join(UDISKS_BLOCK_DEVICES_PATH, device_basename)
        device_object = udisks().get_object(udisks_obj_path)
        if not device_object:
            raise InvalidBootDeviceError(
                f"Could not get udisks object {udisks_obj_path} of boot device {device_path}"
            )
        return BootDevice(device_object)

    def get_beginning_of_free_space(self) -> int:
        """Get the beginning of the free space on the device, in bytes"""
        # Get the partitions
        partitions = [
            udisks().get_object(p).get_partition()
            for p in self.partition_table.props.partitions
        ]
        # Get the ends of the partitions, in bytes
        partition_ends = [p.props.offset + p.props.size for p in partitions]
        # Return the end of the last partition, which is the beginning
        # of the free space.
        return max(partition_ends)


class TPSPartition:
    """The Persistent Storage encrypted partition"""

    def __init__(self, udisks_object: UDisks.Object):
        self.udisks_object = udisks_object
        self.block = self.udisks_object.get_block()
        if not self.block:
            raise InvalidPartitionError("Device is not a block device")
        self.device_path = self.block.props.device
        self.partition = self.udisks_object.get_partition()  # type: UDisks.Partition
        if not self.partition:
            raise InvalidPartitionError(f"Device {self.device_path} is not a partition")

    def get_cleartext_device(self) -> "CleartextDevice":
        """Get the cleartext device of Persistent Storage encrypted
        partition"""
        encrypted = self._get_encrypted()
        cleartext_device_path = encrypted.props.cleartext_device
        if cleartext_device_path == "/":
            raise PartitionNotUnlockedError(
                f"Device {self.device_path} is not unlocked"
            )
        return CleartextDevice(udisks().get_object(cleartext_device_path))

    def try_get_cleartext_device(self) -> Optional["CleartextDevice"]:
        """Get the cleartext device of Persistent Storage encrypted
        partition, or None if it's not unlocked"""
        try:
            return self.get_cleartext_device()
        except PartitionNotUnlockedError as e:
            logger.info(e)
            return None

    def _get_encrypted(self) -> UDisks.Encrypted:
        """Get the UDisks.Encrypted interface of the partition"""
        encrypted = self.udisks_object.get_encrypted()
        if not encrypted:
            raise InvalidPartitionError(f"Device {self.device_path} is not encrypted")
        return encrypted

    def is_unlocked(self) -> bool:
        try:
            self.get_cleartext_device()
            return True
        except (InvalidPartitionError, PartitionNotUnlockedError):
            return False

    def is_unlocked_and_mounted(self) -> bool:
        try:
            cleartext_device = self.get_cleartext_device()
            return cleartext_device.is_mounted()
        except (InvalidPartitionError, PartitionNotUnlockedError):
            return False

    def is_upgraded(self) -> bool:
        logger.debug("Calling is_upgraded()")
        cmd = ["cryptsetup", "luksDump", "--dump-json-metadata", self.device_path]
        p = executil.run(cmd, stdout=subprocess.PIPE)
        if p.returncode != 0:
            m = "Command 'cryptsetup luksDump' failed"
            if p.stderr.startswith(
                "Dump operation is not supported for this device type"
            ):
                m += (
                    ": dump operation was not supported for the device which implies "
                    "it uses LUKS version 1"
                )
            else:
                m += f": {p.stderr.strip()}"
            logger.debug(m)
            return False
        try:
            luks_json = json.loads(str(p.stdout))
        except json.decoder.JSONDecodeError:
            logger.exception("Could not parse luksDump output as JSON")
            return False
        keyslots = luks_json["keyslots"]
        for keyslot in keyslots:
            luks_json["keyslots"][keyslot]["kdf"]["salt"] = "redacted"
        logger.debug(f"LUKS keyslots JSON dump: {keyslots}")

        # The parameters we want for the LUKS header are:
        # - LUKS version 2
        # - Argon2id PBKDF
        # - PBKDF memory cost of at least 1 GiB (1048576 KiB) or half of
        #   the total RAM (because cryptsetup refuses to use more than
        #   half of the total RAM for the memory cost), whichever is lower.
        #   Note: that we take great care to calculate the amount of RAM
        #   exactly as cryptsetup does, so we will only upgrade in the
        #   exact cases where cryptsetup can do better with the current
        #   amount of RAM. For details, see:
        #   • cryptsetup-2.3.7/lib/utils.c:45:uint64_t crypt_getphysmemory_kb(void)
        #   • cryptsetup-2.3.7/lib/utils_pbkdf.c:64:static uint32_t adjusted_phys_memory(void)
        cryptsetup_adjusted_memory_kib = (
            os.sysconf("SC_PAGESIZE") // 1024 * os.sysconf("SC_PHYS_PAGES") // 2
        )
        required_memory_cost_kib = min(
            cryptsetup_adjusted_memory_kib, DESIRED_PBKDF_MEMORY_KIB
        )
        logger.debug(
            f"cryptsetup_adjusted_memory_kib = {cryptsetup_adjusted_memory_kib}"
        )

        def keyslot_is_upgraded(keyslot):
            try:
                return (
                    keyslot["type"] == "luks2"
                    and keyslot["kdf"]["type"] == "argon2id"
                    and keyslot["kdf"]["memory"] >= required_memory_cost_kib
                )
            except KeyError:
                return False

        upgraded_keyslots = [
            slot for slot in keyslots if keyslot_is_upgraded(keyslots[slot])
        ]
        logger.debug(f"upgraded_keyslots = {upgraded_keyslots}")

        # We only require a single key to be upgraded since we have
        # seen users ending up with multiple keys, some which refuse
        # to upgrade (probably due to the storage being corrupt) so
        # is_upgraded() would always return false leading to the LUKS
        # upgrade procedure for each boot (tails/tails#19728).
        upgraded = len(upgraded_keyslots) > 0
        logger.debug(f"is_upgraded() = {upgraded}")
        return upgraded

    @classmethod
    def exists(cls) -> bool:
        """Return true if the Persistent Storage partition exists and
        false otherwise."""
        try:
            cls.find()
            return True
        except (InvalidPartitionError, InvalidBootDeviceError):
            return False

    @classmethod
    def find(cls) -> "TPSPartition":
        """Return the Persistent Storage encrypted partition.

        Raises:
            InvalidBootDeviceError: if the boot device is not found
            InvalidPartitionError: if the partition is not found
        """

        # This raises a InvalidBootDeviceError if no valid boot device
        # is be found
        parent_device = BootDevice.get_tails_boot_device()

        partitions = parent_device.partition_table.props.partitions
        for partition_name in sorted(partitions):
            partition = udisks().get_object(partition_name)
            if not partition:
                continue
            if partition.get_partition().props.name == TPS_PARTITION_LABEL:
                return TPSPartition(partition)
        raise InvalidPartitionError(f"Partition {TPS_PARTITION_LABEL} not found")

    @classmethod
    def pbkdf_parameters(cls, memory_cost=None):
        params = [
            "--pbkdf=argon2id",
        ]
        if memory_cost:
            params += [
                f"--pbkdf-memory={memory_cost}",
                # We need to also specify the number of iterations, because
                # otherwise cryptsetup would perform a benchmark to choose
                # both the memory cost and the number of iterations, which
                # can lead to a memory cost lower than the one we specified
                # above. We choose the lowest number of iterations that
                # cryptsetup allows us to choose (4), to not make unlocking
                # the Persistent Storage too slow on low-end devices.
                "--pbkdf-force-iterations=4",
            ]
        return params

    @classmethod
    def create(
        cls,
        job: Job | None,
        passphrase: str,
        parent_device: Optional["BootDevice"] = None,
    ) -> "TPSPartition":
        """Create the Persistent Storage encrypted partition"""

        if parent_device is None:
            parent_device = BootDevice.get_tails_boot_device()
            is_backup = False
        else:
            is_backup = True

        # This should be the number of next_step() calls
        num_steps = 7
        current_step = 0

        def next_step(description: str | None = None):
            if not job:
                return
            nonlocal current_step
            progress = int((current_step / num_steps) * 100)
            job.refresh_properties(description, progress)
            current_step += 1

        offset = parent_device.get_beginning_of_free_space()

        # Calculate the memory cost for Argon2id.
        # When letting cryptsetup choose the memory cost for Argon2id,
        # it sometimes triggers the OOM killer on low-memory systems.
        # We choose a memory cost which leaves some free memory to avoid
        # triggering the OOM killer.
        available_mem_kib = int(psutil.virtual_memory().available / 1024)
        mem_cost_kib = available_mem_kib - MEMORY_LEFT_TO_SYSTEM_KIB

        # Check that the memory cost is not too low, as it would result
        # in a weak key derivation function.
        if mem_cost_kib < MINIMUM_PBKDF_MEMORY_KIB:
            required_mem_kib = MEMORY_LEFT_TO_SYSTEM_KIB + MINIMUM_PBKDF_MEMORY_KIB
            msg = _(
                "Only {available_memory} KiB of memory is available, need "
                "at least {required_memory} KiB.\n\n"
                "Try again after closing some applications or rebooting."
                ""
            ).format(
                available_memory=available_mem_kib, required_memory=required_mem_kib
            )
            raise NotEnoughMemoryError(msg)

        # Check that the memory cost is not above the desired amount
        mem_cost_kib = min(mem_cost_kib, DESIRED_PBKDF_MEMORY_KIB)

        # Create the partition
        logger.info(f"Creating partition on {parent_device.device_path}")
        next_step(_("Creating a partition for the Persistent Storage..."))
        partition_table = parent_device.partition_table
        object_path = partition_table.call_create_partition_sync(
            arg_offset=offset,
            # Size 0 means maximal size
            arg_size=0,
            arg_type=PARTITION_GUID,
            arg_name=TPS_PARTITION_LABEL,
            arg_options=GLib.Variant("a{sv}", {}),
        )
        udisks().settle()

        # Get the UDisks partition object
        partition = TPSPartition(udisks().get_object(object_path))

        # Initialize the LUKS partition via cryptsetup. We can't use
        # udisks for this because it doesn't support setting the key
        # derivation function which we want to set to argon2id.
        # See https://mjg59.dreamwidth.org/66429.html
        logger.info("Initializing LUKS header")
        next_step(
            _(
                "Initializing the LUKS encryption... The computer might stop responding for a few seconds."
            )
        )

        cmd = [
            "cryptsetup",
            "luksFormat",
            "--batch-mode",
            "--key-file=-",
            "--type=luks2",
            # Note that the PBKDF memory cost we set here might be
            # lower than what is_upgraded() requires, so an upgrade
            # might be triggered next boot. This is intentional as
            # the upgrade will fixup the memory cost to the desired
            # amount. This probably shouldn't happen even on the
            # lowest-end devices we support (3 GiB RAM), but it is
            # relevant for the lowest-end devices we used to support
            # prior to migrating to Debian Trixie (2 GiB RAM).
            *cls.pbkdf_parameters(memory_cost=mem_cost_kib),
            partition.device_path,
        ]
        executil.check_call(cmd, input=passphrase)

        # Wait for the encrypted partition to become available to udisks
        next_step()
        wait_for_udisks_object(
            partition.device_path, partition.udisks_object.get_encrypted
        )

        # Unlock the partition
        logger.info("Unlocking partition")
        next_step(_("Unlocking the encryption..."))
        partition.unlock(passphrase, rename_dm_device=not is_backup)

        # Get the cleartext device
        cleartext_device = partition.get_cleartext_device()

        # Format the cleartext device
        logger.info("Formatting filesystem")
        next_step(_("Formatting the file system..."))
        cleartext_device.block.call_format_sync(
            arg_type="ext4",
            arg_options=GLib.Variant(
                "a{sv}",
                {
                    "label": GLib.Variant("s", TPS_PARTITION_LABEL),
                },
            ),
        )
        udisks().settle()

        if is_backup:
            # We let the caller mount the backup partition
            return partition

        # Mount the cleartext device
        logger.info("Mounting filesystem")
        next_step(_("Activating the Persistent Storage..."))
        # Mount the cleartext device as the currently active
        # Persistent Storage
        cleartext_device.mount()

        next_step(_("Finishing setting up the Persistent Storage..."))

        return partition

    def delete(self):
        """Delete the Persistent Storage encrypted partition"""
        # Ensure that the partition is unmounted
        self._ensure_unmounted()

        # Delete the partition. By setting tear-down to true, udisks
        # automatically locks the encrypted device if it is currently
        # unlocked.
        self.partition.call_delete_sync(
            arg_options=GLib.Variant(
                "a{sv}",
                {
                    "tear-down": GLib.Variant("b", True),
                },
            )
        )

    def test_passphrase(self, passphrase: str, header_file: Path | None = None):
        """Try to unlock the encrypted partition with the given passphrase."""
        cmd = [
            "cryptsetup",
            "luksOpen",
            "--batch-mode",
            "--key-file=-",
            self.device_path,
            "TailsData",
        ]
        if header_file:
            cmd += ["--header", str(header_file)]
        try:
            executil.check_call(cmd, text=True, input=passphrase)
            # It is conceivable that a corrupt LUKS header could
            # successfully decrypt, but the cleartext would be junk,
            # e.g. if the master key is corrupted. But if we see the
            # expected filesystem type and label we can be pretty sure
            # it was not corrupt.
            output = executil.check_output(
                [
                    "blkid",
                    "--match-tag=LABEL",
                    "--match-tag=TYPE",
                    "/dev/mapper/TailsData",
                ]
            ).strip()
            if 'LABEL="TailsData"' not in output and 'TYPE="ext4"' not in output:
                raise InvalidCleartextDeviceError(
                    f"Cleartext device is not what we expect: {output}"
                )
        except subprocess.CalledProcessError as err:
            if err.returncode == 2:
                raise IncorrectPassphraseError(err) from err
            raise
        finally:
            # Close the device if it is open
            try:
                executil.check_call(["cryptsetup", "status", "TailsData"])
                is_open = True
            except subprocess.CalledProcessError:
                is_open = False
            if is_open:
                executil.check_call(["cryptsetup", "close", "TailsData"])

    def backup_luks_header(self):
        luks_header_backup = Path(LUKS_HEADER_BACKUP_PATH)
        executil.check_call(
            [
                "cryptsetup",
                "luksHeaderBackup",
                "--batch-mode",
                "--header-backup-file",
                luks_header_backup,
                self.device_path,
            ],
        )

    def restore_luks_header_backup(self):
        luks_header_backup = Path(LUKS_HEADER_BACKUP_PATH)
        executil.check_call(
            [
                "cryptsetup",
                "luksHeaderRestore",
                "--batch-mode",
                "--header-backup-file",
                str(luks_header_backup),
                self.device_path,
            ],
        )

    def upgrade_luks2(self):
        """Upgrade a LUKS1 header to LUKS2"""
        try:
            executil.check_call(
                [
                    "cryptsetup",
                    "convert",
                    "--debug",
                    "--type",
                    "luks2",
                    "--batch-mode",
                    self.device_path,
                ],
            )
        except subprocess.CalledProcessError as err:
            # Ignore the error if the device is already LUKS2
            if (
                err.returncode == 1
                and err.stderr.strip() == "Device is already LUKS2 type."
            ):
                return
            raise

    def convert_pbkdf_argon2id(self, passphrase: str):
        """Convert the PBKDF to argon2id with fixed iterations and
        memory cost"""
        executil.check_call(
            [
                "cryptsetup",
                "luksConvertKey",
                "--debug",
                # This conversion occurs only while at Tails' Welcome
                # Screen, where even the lowest-end devices we support (2
                # GiB RAM) will have enough RAM for the desired PBKDF
                # memory cost. So here we are either converting a LUKS1
                # key created in an older Tails, or we are fixing up the
                # memory cost of a newly created (via create()) volume
                # where enough memory wasn't available since a fully
                # logged in Tails system was running.
                *self.pbkdf_parameters(memory_cost=DESIRED_PBKDF_MEMORY_KIB),
                "--key-file=-",
                "--batch-mode",
                self.device_path,
            ],
            input=passphrase,
        )

    def unlock(self, passphrase: str, rename_dm_device: bool = True):
        """Unlock the Persistent Storage encrypted partition"""
        try:
            encrypted = self._get_encrypted()
            encrypted.call_unlock_sync(
                arg_passphrase=passphrase,
                arg_options=GLib.Variant("a{sv}", {}),
                cancellable=None,
            )
        except InvalidPartitionError as err:
            logger.error(f"Failed to get encrypted device: {err}")
            # Try to restore the LUKS header backup if there is one
            unlocked = self._try_restore_luks_header_backup(passphrase)
            if not unlocked:
                raise err
        except GLib.Error as err:
            logger.error(f"Failed to unlock {self.device_path}: {err.message}")

            # Try to restore the LUKS header backup if there is one
            unlocked = False
            if err.matches(UDisks.error_quark(), UDisks.Error.FAILED):
                unlocked = self._try_restore_luks_header_backup(passphrase)

            if not unlocked:
                if err.matches(UDisks.error_quark(), UDisks.Error.FAILED) and re.search(
                    "Failed to activate device: (Operation not "
                    "permitted|Incorrect passphrase)",
                    err.message,
                ):
                    raise IncorrectPassphraseError(err) from err
                raise

        udisks().settle()

        if rename_dm_device:
            # Wait for the cleartext device to become available to udisks
            try:
                cleartext_device = wait_for_udisks_object(
                    self.device_path,
                    self.try_get_cleartext_device,
                )
                assert isinstance(cleartext_device, CleartextDevice)
            except TimeoutError:
                # Log the output of `udisksctl dump` to help debug spurious
                # failures to get the cleartext device after unlocking
                output = executil.check_output(["udisksctl", "dump"])
                logger.error(
                    "Failed to get cleartext device after unlocking"
                    " partition. udisksctl dump output:\n%s",
                    output,
                )
                raise

            # Rename the cleartext device to "TailsData_unlocked", which
            # is the expected dm name for historical reasons
            cleartext_device.rename_dm_device("TailsData_unlocked")

    def _try_restore_luks_header_backup(self, passphrase: str) -> bool:
        """Try to restore a LUKS header backup and unlock the Persistent
        Storage with that header.
        :returns: True if the LUKS header backup was restored and the
                  Persistent Storage was unlocked, False otherwise.
        """
        luks_header_backup = Path(LUKS_HEADER_BACKUP_PATH)
        if not luks_header_backup.exists():
            logger.info("No LUKS header backup found")
            return False

        logger.info(f"Trying to unlock LUKS header backup: {luks_header_backup}")
        # Test the passphrase against the LUKS header backup
        try:
            self.test_passphrase(passphrase, luks_header_backup)
        except IncorrectPassphraseError as err:
            logger.info(
                "Failed to unlock LUKS header backup with the "
                f"provided passphrase: {err}"
            )
            return False

        # Restore the LUKS header backup
        logger.info(
            "Unlocking LUKS header backup succeeded, restoring the backup header."
        )
        self.restore_luks_header_backup()

        # Try to get the encrypted device. We use wait_for_udisks_object()
        # because udisks might need some time to detect the new device.
        encrypted = wait_for_udisks_object(
            self.device_path, self.udisks_object.get_encrypted
        )
        assert isinstance(encrypted, UDisks.Encrypted)

        # Unlock the partition
        logger.info(f"Unlocking {self.device_path} with the restored header.")
        encrypted.call_unlock_sync(
            arg_passphrase=passphrase,
            arg_options=GLib.Variant("a{sv}", {}),
            cancellable=None,
        )
        return True

    def _ensure_unmounted(self):
        try:
            cleartext_device = self.get_cleartext_device()
        except (InvalidPartitionError, PartitionNotUnlockedError):
            # There is no cleartext device for this partition, so there
            # is nothing to unmount
            return

        try:
            cleartext_device.force_unmount()
        except GLib.Error as err:
            if err.matches(UDisks.error_quark(), UDisks.Error.DEVICE_BUSY):
                msg = _(
                    "Can't unmount Persistent Storage, some process is still"
                    " using it. Please close all applications that could"
                    " be accessing it and try again. If that doesn't work,"
                    " restart Tails and try deleting the Persistent Storage"
                    " without unlocking it."
                )
                raise TargetIsBusyError(msg) from err
            # Ignore errors caused by the device not being mounted.
            if not err.matches(UDisks.error_quark(), UDisks.Error.NOT_MOUNTED):
                raise

    def change_passphrase(self, passphrase: str, new_passphrase: str):
        """Change the passphrase of the Persistent Storage encrypted
        partition"""
        encrypted = self._get_encrypted()
        try:
            encrypted.call_change_passphrase_sync(
                arg_passphrase=passphrase,
                arg_new_passphrase=new_passphrase,
                arg_options=GLib.Variant("a{sv}", {}),
            )
        except GLib.Error as err:
            if (
                err.matches(UDisks.error_quark(), UDisks.Error.FAILED)
                and "No keyslot with given passphrase found" in err.message
            ):
                raise IncorrectPassphraseError(err) from err
            if (
                err.matches(Gio.DBusError.quark(), Gio.DBusError.NO_REPLY)
                and udisks_oom_killed()
            ):
                raise NotEnoughMemoryError(
                    _(
                        "Not enough memory to change the passphrase of the"
                        " Persistent Storage. Try again after closing some"
                        " applications or rebooting."
                    )
                ) from err

            raise


class CleartextDevice:
    def __init__(self, udisks_object: UDisks.Object):
        self.udisks_object = udisks_object
        self.block = self.udisks_object.get_block()
        if not self.block:
            raise InvalidCleartextDeviceError("Device is not a block device")
        self.device_path = self.block.props.device
        self.mount_point = Path(TPS_MOUNT_POINT)
        self.fsck_process = None

    def is_mounted(self):
        p = executil.run(
            [
                "findmnt",
                f"--source={self.device_path}",
                f"--mountpoint={self.mount_point!s}",
            ]
        )
        if p.returncode == 0:
            return True
        if p.returncode == 1:
            return False
        # If the return code is not 0 and not 1, something unexpected
        # happened, so we raise a CalledProcessException
        p.check_returncode()

    def fsck(self, forceful: bool = False):
        assert self.fsck_process is None
        if forceful:
            # Assume an answer of `yes' to all questions, i.e.
            # tell e2fsck to try to fix all errors which it asks
            # confirmation for.
            mode = "-y"
        else:
            # Only fix problems that can be safely fixed.
            mode = "-p"

        try:
            cmd = [
                "e2fsck",
                # Force checking even if the file system seems clean:
                # some filesystems are corrupted in a way that fsck
                # won't spot it without this option, and then mount
                # will fail.
                "-f",
                mode,
                self.device_path,
            ]
            logger.info(f"Executing command {' '.join(cmd)}", stacklevel=3)
            p = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True)
            self.fsck_process = p
            p.communicate()
            logger.debug(f"Done executing command {' '.join(cmd)}", stacklevel=3)
            if p.returncode == 0:
                return
            elif p.returncode == 1:
                # Exit code 1 means "File system errors corrected".
                logger.info("e2fsck corrected file system errors")
            elif p.returncode == -15:
                # -15 = SIGTERM
                raise FilesystemRepairAborted("e2fsck was aborted by the user")
            # e2fsck returns a sum, so we need to use bitwise AND to
            # check the exit code.
            elif p.returncode & 4:
                # Exit code 4 means "File system errors left uncorrected".
                # We can try to fix them by running e2fsck again with `-y`
                # instead of `-p`, but that is a potentially destructive
                # action, so we raise an exception and let the caller
                # ask the user for confirmation first.
                # Note that it's also possible that the filesystem can
                # be mounted successfully if we don't fix the errors. We
                # decided on #15451 that we still want to try to fix the
                # errors before trying to mount, because mounting a
                # corrupted filesystem might cause further data loss.
                raise FilesystemErrorsLeftUncorrectedError(
                    f"e2fsck could not correct all errors, returned {p.returncode}"
                )
            else:
                raise FilesystemRepairFailure(f"e2fsck returned {p.returncode}")
        finally:
            self.fsck_process = None

    def abort_fsck(self):
        if self.fsck_process is None:
            return
        try:
            self.fsck_process.send_signal(signal.SIGTERM)
        finally:
            self.fsck_process = None

    def mount(self):
        # Ensure that the mount point exists
        self.mount_point.mkdir(mode=0o770, parents=True, exist_ok=True)

        # Mount the Persistent Storage partition
        mount_cmd = ["mount", "-o", "acl", self.device_path, self.mount_point]
        try:
            executil.check_call(mount_cmd)
        except subprocess.CalledProcessError as e:
            if e.returncode == 32:
                # Exit code 32 means "Mount failure". This happens when
                # the file system is corrupted. We run e2fsck to try to
                # fix the file system. Yes, in do_unlock() we already
                # ran e2fsck before calling mount(), but on #15451 we
                # decided that we want to try to fix the filesystem
                # again if mounting fails (maybe it causes the
                # filesystem to be marked as unclean and then e2fsck
                # finds errors to correct?).
                self.fsck()
                # Try to mount again
                executil.check_call(mount_cmd)
            else:
                raise

        # Ensure that the mount point has the correct owner, permissions
        # and ACL.
        # Permissions are set to 770. ACLs are set to allow the amnesia
        # user to traverse the directory, which is needed for mounts
        # using the link option (e.g. dotfiles).
        # refs: #7465
        os.chown(self.mount_point, uid=0, gid=0)
        self.mount_point.chmod(0o770)
        executil.check_call(["/bin/setfacl", "--remove-all", self.mount_point])
        executil.check_call(
            ["/bin/setfacl", "--modify", f"user:{LIVE_USERNAME}:x", self.mount_point]
        )

        # Ensure that all persistent directories have safe permissions.
        # refs: #7458
        for d in self.mount_point.iterdir():
            if not d.is_dir():
                continue
            # Note: we chmod even custom persistent directories.
            # This may break things by changing otherwise correct
            # permissions copied from the directory that was made
            # persistent, so we only do that if the persistent directory
            # is owned by amnesia:amnesia, and thus unlikely to be
            # a system directory. This e.g. avoids setting wrong
            # permissions on the APT, CUPS and NetworkManager
            # persistent directories.
            if d.stat().st_uid != LIVE_USER_UID or d.stat().st_gid != LIVE_USER_UID:
                continue
            # Remove all permissions for group and others
            current = stat.S_IMODE(d.stat().st_mode)
            d.chmod(current & ~stat.S_IRWXG & ~stat.S_IRWXO)

    def force_unmount(self):
        filesystem = self.udisks_object.get_filesystem()
        if not filesystem:
            # There is no filesystem, so there is nothing to unmount
            return
        # Unmount the filesystem until no mount points are left
        while filesystem.props.mount_points:
            filesystem.call_unmount_sync(
                arg_options=GLib.Variant(
                    "a{sv}",
                    {
                        # We do not unmount with force, because if force is
                        # necessary, locking the encrypted device will fail with
                        # "device is still in use", which would leave the
                        # device unlocked and unmounted, which is an
                        # inconsistent state. Instead, if the device is still
                        # in use, we let the unmount call fail already, which
                        # will leave the device in a "good" state (unlocked and
                        # mounted).
                        "force": GLib.Variant("b", False),
                    },
                )
            )

    def get_dm_name(self) -> str | None:
        udisks_devno = self.block.props.device_number
        out = executil.check_output(["dmsetup", "ls", "-o", "devno"])
        for line in out.strip().split("\n"):
            name, devno = line.split()
            if devno == f"({os.major(udisks_devno)}:{os.minor(udisks_devno)})":
                return name
        return None

    def rename_dm_device(self, new_name: str):
        dm_name = self.get_dm_name()
        if not dm_name:
            logger.warning("Can't rename dm device: dm name not found")
            return
        executil.check_call(["dmsetup", "rename", dm_name, new_name])


def wait_for_udisks_object(
    device_path: str, func: Callable[..., object | None], *args, timeout: int = 20
) -> object:
    """Repeatedly call `udevadm trigger` and then func() until func()
    returns a udisks object or timeout is reached."""
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            executil.check_call(
                [
                    "udevadm",
                    "trigger",
                    "--verbose",
                    "--settle",
                    device_path,
                ],
                timeout=timeout - (time.monotonic() - start),
            )
        except subprocess.TimeoutExpired as e:
            logger.warning(e)
        obj = func(*args)
        if obj:
            return obj
        time.sleep(1)
        continue
    raise TimeoutError("Timeout while waiting for udisks object")


def udisks_oom_killed() -> bool:
    """Check if udisks2.service was oom-killed.
    Returns: True if udisks2.service was oom-killed, False otherwise.
    """

    # Check the Result property of udisks2.service
    output = executil.check_output(
        ["systemctl", "show", "--property=Result", "udisks2.service"]
    ).strip()
    match output:
        case "Result=oom-kill":
            return True
        case "Result=signal":
            # Sometimes systemd doesn't detect that the service was
            # oom-killed and shows "Result=signal" instead. To also
            # handle that case, we check if the service was killed
            # via SIGKILL, in which case we assume that it was a
            # result of the OOM killer.
            output = executil.check_output(
                ["systemctl", "show", "--value", "--property=ExecMainStatus", "udisks2"]
            ).strip()
            if output == "9":  # SIGKILL
                logger.warning("udisks2.service was killed via SIGKILL")
                return True
