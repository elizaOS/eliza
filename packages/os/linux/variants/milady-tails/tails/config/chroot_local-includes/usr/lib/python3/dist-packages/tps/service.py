import contextlib
import os
import threading
from pathlib import Path

from gi.repository import Gio, GLib
from logging import getLogger
import time
from typing import TYPE_CHECKING, Optional

from tps import (
    executil,
    InvalidBootDeviceErrorType,
    SYSTEM_PARTITION_MOUNT_POINT,
    LUKS_HEADER_BACKUP_PATH,
    IO_ERRORS_FLAG_FILE_PATH,
)
from tps.configuration import features
from tps.configuration.config_file import ConfigFile, InvalidStatError
from tps.configuration.feature import Feature, ConflictingProcessesError
from tps.dbus.errors import (
    InvalidConfigFileError,
    FailedPreconditionError,
    FeatureActivationFailedError,
    ActivationFailedError,
    DeactivationFailedError,
    FilesystemErrorsLeftUncorrectedError,
    IOErrorsDetectedError,
)
from tps.dbus.object import DBusObject
from tps.device import (
    udisks,
    BootDevice,
    TPSPartition,
    InvalidBootDeviceError,
    InvalidPartitionError,
    PartitionNotUnlockedError,
)
from tps.job import ServiceUsingJobs
from tps import (
    State,
    IN_PROGRESS_STATES,
    DBUS_ROOT_OBJECT_PATH,
    DBUS_SERVICE_INTERFACE,
    TPS_MOUNT_POINT,
    TPS_BACKUP_MOUNT_POINT,
    ON_ACTIVATED_HOOKS_DIR,
    ON_DEACTIVATED_HOOKS_DIR,
    DBUS_FEATURES_PATH,
)

if TYPE_CHECKING:
    from tps.job import Job

logger = getLogger(__name__)


class AlreadyCreatedError(Exception):
    pass


class NotCreatedError(Exception):
    pass


class AlreadyUnlockedError(Exception):
    pass


class NotUnlockedError(Exception):
    pass


class Service(DBusObject, ServiceUsingJobs):
    dbus_info = """
        <node>
            <interface name='org.boum.tails.PersistentStorage'>
                <method name='Quit'/>
                <method name='Reload'/>
                <method name='GetFeatures'>
                    <arg name='features' direction='out' type='as'/>
                </method>
                <method name='Create'>
                    <arg name='passphrase' direction='in' type='s'/>
                </method>
                <method name='CreateBackup'>
                    <arg name='passphrase' direction='in' type='s'/>
                    <arg name='device' direction='in' type='s'/>
                </method>
                <method name='ChangePassphrase'>
                    <arg name='passphrase' direction='in' type='s'/>
                    <arg name='new_passphrase' direction='in' type='s'/>
                </method>
                <method name='Delete'/>
                <method name='Activate'/>
                <method name='Unlock'>
                    <arg name='passphrase' direction='in' type='s'/>
                </method>
                <method name='UpgradeLUKS'>
                    <arg name='passphrase' direction='in' type='s'/>
                </method>
                <method name='RepairFilesystem'/>
                <method name='AbortRepairFilesystem'/>
                <property name="State" type="s" access="read" />
                <property name="Error" type="u" access="read" />
                <property name="IsCreated" type="b" access="read"/>
                <property name="IsUnlocked" type="b" access="read"/>
                <property name="IsUpgraded" type="b" access="read"/>
                <property name="CanDelete" type="b" access="read"/>
                <property name="CanUnlock" type="b" access="read"/>
                <property name="BootDeviceIsSupported" type="b" access="read"/>
                <property name="Device" type="s" access="read"/>
                <property name="Job" type="o" access="read"/>
            </interface>
        </node>
        """

    dbus_path = DBUS_ROOT_OBJECT_PATH

    def __init__(self, connection: Gio.DBusConnection, loop: GLib.MainLoop):
        super().__init__(connection=connection)
        self.connection = connection
        self.mainloop = loop
        self.object_manager = None  # type: Optional[Gio.DBusObjectManagerServer]
        self.config_file = ConfigFile(TPS_MOUNT_POINT)
        self.bus_id = None
        self.features: list[Feature] = []
        self._tps_partition = None  # type: Optional[TPSPartition]
        self._cleartext_device = None
        self._device = ""
        self.state = State.UNKNOWN
        self._error: int = 0
        self._unlocked = False
        self._can_delete = False
        self._can_unlock = False
        self._upgraded = False
        self._created = False
        self.enable_features_lock = threading.Lock()
        self._boot_device = None  # type: Optional[BootDevice]

        # Check if the boot device is valid for creating or using a Persistent
        # Storage. We only do this once and not in refresh_state(),
        # because we don't expect the boot device to change while the
        # service is running. Unfortunately, this implies we'll keep
        # a potentially obsolete error state as-is even if the user
        # corrects the partition table (e.g. deleting a manually
        # created second partition) without restarting the service.
        try:
            self._boot_device = BootDevice.get_tails_boot_device()
        except InvalidBootDeviceError as e:
            logger.warning("Invalid boot device: %s", e)
            self.State = State.NOT_CREATED

            # This will allow the UI to give the user more specific guidance.
            self.Error = e.error_type
            return

        self.refresh_state()

    # ----- Exported methods ----- #

    def Quit_method_call_handler(
        self,
        connection: Gio.DBusConnection,
        parameters: GLib.Variant,
        invocation: Gio.DBusMethodInvocation,
    ):
        """Terminate the Persistent Storage service."""
        # Make the D-Bus method return first, else our main thread
        # might exit before we can call return, resulting in a NoReply
        # error on the client.
        invocation.return_value(None)
        connection.flush_sync()
        logger.info("Quit() was called, terminating...")
        self.settle()
        self.unregister(self.connection)
        self.wait_for_method_calls_to_finish(True)
        self.stop()

    def Reload(self):
        """Reload the state of the service and all features"""
        self.refresh_state()
        self.refresh_features()

    def GetFeatures(self) -> list[str]:
        """List the IDs of all features"""
        self.refresh_features()
        return [f.Id for f in self.features]

    def Create(self, passphrase: str):
        """Create the Persistent Storage partition and activate the
        default features"""

        logger.info("Creating Persistent Storage...")

        # Check if we can create the Persistent Storage
        if self.state != State.NOT_CREATED:
            msg = "Can't create Persistent Storage when state is '%s'" % self.state.name
            raise FailedPreconditionError(msg)

        try:
            self.do_create(passphrase)
        finally:
            self.refresh_state(overwrite_in_progress=True)
            self.refresh_features()

        logger.info("Done creating Persistent Storage")

    def do_create(self, passphrase: str):
        self.State = State.CREATING
        with self.new_job() as job:
            self._tps_partition = TPSPartition.create(job, passphrase)

        # Activate all features that should be enabled by default
        for feature in (f for f in self.features if f.enabled_by_default):
            try:
                feature.do_activate(None, non_blocking=True)
            except ConflictingProcessesError as e:
                # We can't automatically activate the feature, but
                # lets not bother the user about that, because they
                # did not explicitly enable the feature. If they try
                # to enable it explicitly, they will see a message
                # about the conflicting process.
                logger.warning(e)
            finally:
                feature.refresh_state()

        self.run_on_activated_hooks()

    def CreateBackup(self, passphrase: str, device: str):
        """Create a backup of the Persistent Storage partition"""
        logger.info(f"Creating Persistent Storage backup on device {device}...")

        if self.state != State.UNLOCKED:
            msg = (
                "Can't create backup of Persistent Storage when state is '%s'"
                % self.state.name
            )
            raise FailedPreconditionError(msg)

        dev_num = os.stat(device).st_rdev
        device = BootDevice(udisks().get_block_for_dev(dev_num).get_object())
        partition = TPSPartition.create(None, passphrase, device)

        # Mount the cleartext device
        Path(TPS_BACKUP_MOUNT_POINT).mkdir(parents=True, exist_ok=True)
        cleartext_device_path = partition.get_cleartext_device().device_path
        executil.check_call(["mount", cleartext_device_path, TPS_BACKUP_MOUNT_POINT])

        # Copy the data from the Persistent Storage to the new device
        executil.check_call(["/usr/local/lib/tails-backup-rsync"])

        # Unmount the cleartext device. We don't do that in a finally
        # block, because we want to keep the device mounted in case
        # of an error, so that the user can inspect which files (if any)
        # were copied.
        partition.get_cleartext_device().force_unmount()

        # Delete the mountpoint
        Path(TPS_BACKUP_MOUNT_POINT).rmdir()

        # Close the LUKS device
        partition._get_encrypted().call_lock_sync(  # noqa: SLF001
            arg_options=GLib.Variant("a{sv}", {}),
        )

    def Delete(self):
        """Delete the Persistent Storage partition"""
        # Check if we can delete the Persistent Storage
        if self.state not in (State.NOT_UNLOCKED, State.UNLOCKED):
            msg = "Can't delete Persistent Storage when state is '%s'" % self.state.name
            raise FailedPreconditionError(msg)

        logger.info("Deleting Persistent Storage...")

        try:
            # Disable all features first to ensure that no process is
            # accessing any of the bindings
            for feature in self.features:
                if feature.IsActive:
                    feature.Deactivate()
            self.do_delete()
        finally:
            self.refresh_state(overwrite_in_progress=True)
            self.refresh_features()

        logger.info("Done deleting Persistent Storage")

    def do_delete(self):
        # Delete the partition
        self.State = State.DELETING
        self._tps_partition.delete()

    def Activate(self):
        """Activate all Persistent Storage features which are currently
        configured in the persistence.conf config file."""

        logger.info("Activating Persistent Storage...")

        # Wait for all udev and UDisks events to finish
        executil.check_call(["udevadm", "settle"])
        udisks().settle()

        # Check if we can activate the Persistent Storage
        if self.state != State.UNLOCKED:
            msg = "Can't activate features when state is '%s'" % self.state.name
            raise FailedPreconditionError(msg)

        try:
            TPSPartition.find()
        except (InvalidBootDeviceError, InvalidPartitionError) as e:
            raise NotCreatedError("No Persistent Storage found") from e

        try:
            self.do_activate()
        finally:
            self.refresh_state()
            self.refresh_features()

        logger.info("Done activating Persistent Storage")

    def do_activate(self):
        # Ensure that the config file exists
        if not self.config_file.exists():
            self.config_file.save([])

        # Check that the config file has secure ownership and
        # permissions. If not, disable the file and create an empty
        # file.
        try:
            self.config_file.check_file_stat()
        except InvalidStatError as e:
            logger.warning(f"Disabling invalid config file: {e}")
            try:
                self.config_file.disable_and_create_empty()
                self.run_on_activated_hooks()
            finally:
                raise InvalidConfigFileError(e) from e

        self.refresh_features()
        failed_feature_names = list()
        for feature in [f for f in self.features if f.IsEnabled]:
            try:
                feature.do_activate(None, non_blocking=True)
            except Exception:
                logger.exception("Failed to activate feature")
                failed_feature_names.append(feature.translatable_name)
            finally:
                feature.refresh_state(emit_properties_changed_signal=True)

        self.run_on_activated_hooks()

        if any(failed_feature_names):
            # We want to show a translatable error message to the user
            # but because the Service.Activate method is called in the
            # Welcome Screen (and only there), only the Welcome Screen
            # knows which language the user has currently selected.
            # So we let the Welcome Screen translate the error message
            # instead and make it easy for it by just passing the list
            # of translatable feature names in the error message.
            msg = ":".join(failed_feature_names)
            raise FeatureActivationFailedError(msg)

    def Unlock(self, passphrase: str):
        """Unlock and mount the Persistent Storage"""

        logger.info("Unlocking Persistent Storage...")

        # Check if we can unlock the Persistent Storage. We also support
        # unlocking when the state is UNLOCKED to allow the caller to
        # retry unlocking after an incomplete unlock attempt (e.g. when
        # filesystem errors were left uncorrected).
        if self.state not in (State.NOT_UNLOCKED, State.UNLOCKED):
            msg = "Can't unlock when state is '%s'" % self.state.name
            raise FailedPreconditionError(msg)

        try:
            self.do_unlock(passphrase)
        finally:
            self.refresh_state(overwrite_in_progress=True)
            # We don't refresh the features here to avoid that any errors
            # caused by unexpected state of the Persistent Storage are
            # shown to the user as "Failed to Unlock", which would be
            # misleading because it was unlocked successfully.
            # We expect the caller to call Activate next after a
            # successful Unlock call and we refresh the features there,
            # so it should be fine to skip it here.

        logger.info("Done unlocking Persistent Storage")

    def do_unlock(self, passphrase: str):
        self.state = State.UNLOCKING

        # Unlock the Persistent Storage
        if not self._tps_partition.is_unlocked():
            self._tps_partition.unlock(passphrase)

        # Mount the Persistent Storage
        cleartext_device = self._tps_partition.get_cleartext_device()
        try:
            if not cleartext_device.is_mounted():
                cleartext_device.fsck()
                cleartext_device.mount()
        except FilesystemErrorsLeftUncorrectedError as e:
            # Check if there are I/O errors for the device, in which
            # case we want to raise a different error
            io_errors_flag_file = Path(IO_ERRORS_FLAG_FILE_PATH)
            # If the flag file already exists, we don't need to check
            # the journal for I/O errors
            if io_errors_flag_file.exists():
                raise IOErrorsDetectedError() from e
            # Check the journal messages for IO errors
            executil.check_call(["tails-detect-disk-ioerrors", "--oneshot"])
            if io_errors_flag_file.exists():
                raise IOErrorsDetectedError() from e
            # If there are no I/O errors, we raise the original error
            raise e

        # Remove the LUKS header backup if it exists. It's not needed
        # anymore and we don't want to keep it around to avoid that the
        # master key can be recovered from it (for example in case that
        # the user changes the passphrase of the Persistent Storage).
        #
        # Just unlinking the header allows it to be recovered until the
        # physical memory is overwritten. Secure deletion on flash storage
        # is a hard problem, simply overwriting the logical blocks once
        # is not enough to ensure that the data is gone because of wear
        # leveling. We still overwrite the header once with random data
        # because that's what cryptsetup does when deleting a LUKS header
        # on a non-rotational device (as of cryptsetup 2.6.1), see
        # https://salsa.debian.org/cryptsetup-team/cryptsetup/-/blob/e99903d881ad15abacf16ffcb23207b85c052d55/lib/utils_wipe.c#L237-237
        luks_header_backup = Path(LUKS_HEADER_BACKUP_PATH)
        if luks_header_backup.exists():
            with self.ensure_system_partition_mounted_read_write():
                self.erase_luks_header_backup()

    def UpgradeLUKS(self, passphrase: str):
        """Upgrade the LUKS header and key derivation function.

        Note that due to wear leveling, the old LUKS header can likely
        be restored via forensic analysis (until the physical memory is
        overwritten)."""

        logger.info("Upgrading Persistent Storage...")

        # Check if we can upgrade the Persistent Storage
        if self.state != State.NOT_UNLOCKED:
            msg = "Can't upgrade when state is '%s'" % self.state.name
            raise FailedPreconditionError(msg)

        try:
            # The backup header is stored on the system partition which is
            # not mounted read-write by default, so we need to mount it
            # read-write first.
            with self.ensure_system_partition_mounted_read_write():
                self.do_upgrade_luks(passphrase)
        finally:
            self.refresh_state(overwrite_in_progress=True)

        logger.info("Done upgrading Persistent Storage")

    def do_upgrade_luks(self, passphrase: str):
        # This is for debugging #19728 and #19734 during the Tails
        # 5.15 cycle. Since debug logging is enabled the output of
        # this command will be logged in full.
        executil.check_call(["free"])

        self.state = State.UPGRADING

        # Check that the passphrase is correct and the header is intact
        self._tps_partition.test_passphrase(passphrase)

        # To avoid that the backup call below fails because the file
        # already exists, we remove the backup file if it exists. We
        # don't need the backup file because we just checked that the
        # header is intact.
        luks_header_backup = Path(LUKS_HEADER_BACKUP_PATH)
        if luks_header_backup.exists():
            self.erase_luks_header_backup()

        # Create a backup of the LUKS header in case something goes
        # wrong during the upgrade. If we can't successfully unlock the
        # Persistent Storage after the upgrade, the backup header is
        # automatically restored by the Unlock method. It is removed
        # when Persistent Storage was successfully unlocked.
        self._tps_partition.backup_luks_header()

        # Check that the backup header is intact
        try:
            self._tps_partition.test_passphrase(passphrase, luks_header_backup)
        except Exception as e:
            # Remove the backup header because it is not intact, so we
            # can't restore it if something goes wrong during the upgrade.
            self.erase_luks_header_backup()
            raise e

        # Upgrade the LUKS header and key derivation function
        self._tps_partition.upgrade_luks2()
        self._tps_partition.convert_pbkdf_argon2id(passphrase)

    def ChangePassphrase(self, passphrase: str, new_passphrase: str):
        """Change the passphrase of the Persistent Storage encrypted
        partition"""

        logger.info("Changing passphrase...")

        try:
            partition = TPSPartition.find()
        except (InvalidBootDeviceError, InvalidPartitionError) as e:
            raise NotCreatedError("No Persistent Storage found") from e

        partition.change_passphrase(passphrase, new_passphrase)

        logger.info("Done changing passphrase")

    def RepairFilesystem(self):
        """Do a forceful filesystem check (e2fsck -f -y). Requires the
        Persistent Storage to be unlocked and not mounted."""
        logger.info("Repairing filesystem")

        try:
            partition = TPSPartition.find()
        except (InvalidBootDeviceError, InvalidPartitionError) as e:
            raise NotCreatedError("No Persistent Storage found") from e

        try:
            self._cleartext_device = partition.get_cleartext_device()
        except PartitionNotUnlockedError as e:
            raise NotUnlockedError("Persistent Storage is not unlocked") from e

        try:
            self._cleartext_device.fsck(forceful=True)
        finally:
            self._cleartext_device = None

        logger.info("Done repairing filesystem")

    def AbortRepairFilesystem(self):
        """Abort any ongoing filesystem check of the Persistent
        Storage"""

        if (
            self._cleartext_device is None
            or self._cleartext_device.fsck_process is None
        ):
            logger.warning(
                "Attempted to abort reparation of filesystem while none was running"
            )
            return

        logger.info("Aborting reparation of filesystem")

        self._cleartext_device.abort_fsck()

        logger.info("Done aborting reparation of filesystem")

    # ----- Exported properties ----- #

    @property
    def State(self) -> str:
        """The state of the Persistent Storage"""
        return self.state.name

    @State.setter
    def State(self, state: State):
        if self.state == state:
            # Nothing to do
            return
        self.state = state
        changed_properties = {"State": GLib.Variant("s", state.name)}
        self.emit_properties_changed_signal(
            self.connection,
            DBUS_SERVICE_INTERFACE,
            changed_properties,
        )

    @property
    def Error(self) -> int:
        """The error code, if State is ERROR"""
        return self._error

    @Error.setter
    def Error(self, code: int):
        if self._error == code:
            # Nothing to do
            return
        self._error = code
        changed_properties = {"Error": GLib.Variant("u", code)}
        self.emit_properties_changed_signal(
            self.connection,
            DBUS_SERVICE_INTERFACE,
            changed_properties,
        )

    @property
    def IsCreated(self) -> bool:
        """Whether the Persistent Storage partition is created."""
        return self._created

    @IsCreated.setter
    def IsCreated(self, value: bool):
        if self._created == value:
            # Nothing to do
            return
        self._created = value
        changed_properties = {"IsCreated": GLib.Variant("b", value)}
        self.emit_properties_changed_signal(
            self.connection,
            DBUS_SERVICE_INTERFACE,
            changed_properties,
        )

    @property
    def IsUnlocked(self) -> bool:
        """Whether the Persistent Storage partition is unlocked and
        mounted (we also require it to be mounted to avoid having to add
        a separate property IsMounted)."""
        # We could use the cached value, self._unlocked, here, but the
        # cost of refreshing seem to be low here, and the benefit is
        # that the value will be correct even if the user unlocked the
        # partition in some other way than by using this service's
        # Unlock() method (for example GNOME Disks or cryptsetup).
        self.refresh_state()
        return self._unlocked

    @IsUnlocked.setter
    def IsUnlocked(self, value: bool):
        if self._unlocked == value:
            # Nothing to do
            return
        self._unlocked = value
        changed_properties = {"IsUnlocked": GLib.Variant("b", value)}
        self.emit_properties_changed_signal(
            self.connection,
            DBUS_SERVICE_INTERFACE,
            changed_properties,
        )

    @property
    def IsUpgraded(self) -> bool:
        """Whether the LUKS header and key derivation function have
        been upgraded to LUKS2 and argon2id"""
        self.refresh_state()
        return self._upgraded

    @IsUpgraded.setter
    def IsUpgraded(self, value: bool):
        if self._upgraded == value:
            # Nothing to do
            return
        self._upgraded = value
        changed_properties = {"IsUpgraded": GLib.Variant("b", value)}
        self.emit_properties_changed_signal(
            self.connection,
            DBUS_SERVICE_INTERFACE,
            changed_properties,
        )

    @property
    def CanUnlock(self) -> bool:
        """Whether the Persistent Storage can be unlocked"""
        self.refresh_state()
        return self._can_unlock

    @CanUnlock.setter
    def CanUnlock(self, value: bool):
        if self._can_unlock == value:
            # Nothing to do
            return
        self._can_unlock = value
        changed_properties = {"CanUnlock": GLib.Variant("b", value)}
        self.emit_properties_changed_signal(
            self.connection,
            DBUS_SERVICE_INTERFACE,
            changed_properties,
        )

    @property
    def CanDelete(self) -> bool:
        """Whether the Persistent Storage can be deleted"""
        self.refresh_state()
        return self._can_delete

    @CanDelete.setter
    def CanDelete(self, value: bool):
        if self._can_delete == value:
            # Nothing to do
            return
        self._can_delete = value
        changed_properties = {"CanDelete": GLib.Variant("b", value)}
        self.emit_properties_changed_signal(
            self.connection,
            DBUS_SERVICE_INTERFACE,
            changed_properties,
        )

    @property
    def BootDeviceIsSupported(self) -> bool:
        return bool(self._boot_device)

    @property
    def Device(self) -> str:
        return self._device

    @Device.setter
    def Device(self, value: str):
        if self._device == value:
            # Nothing to do
            return
        self._device = value
        changed_properties = {"Device": GLib.Variant("s", value)}
        self.emit_properties_changed_signal(
            self.connection,
            DBUS_SERVICE_INTERFACE,
            changed_properties,
        )

    @property
    def Job(self) -> str:
        return self._job.dbus_path if self._job else "/"

    @Job.setter
    def Job(self, job: "Job"):
        self._job = job
        changed_properties = {"Job": GLib.Variant("s", self.Job)}
        self.emit_properties_changed_signal(
            self.connection,
            DBUS_SERVICE_INTERFACE,
            changed_properties,
        )

    # ----- Non-exported functions ----- #

    def start(self):
        """Start the Persistent Storage service."""
        try:
            self.register(self.connection)

            # Create the object manager
            object_manager_path = DBUS_FEATURES_PATH
            self.object_manager = Gio.DBusObjectManagerServer(
                object_path=object_manager_path,
            )

            for FeatureClass in features.get_classes():
                feature = FeatureClass(self)
                feature.register(self.connection)
                self.object_manager.export(
                    Gio.DBusObjectSkeleton.new(feature.dbus_path)
                )
                self.features.append(feature)

            # Export the object manager on the connection. We do this
            # after exporting the features above to avoid
            # InterfacesAdded signals being emitted.
            self.object_manager.set_connection(self.connection)

            self.refresh_features()

            logger.debug("Done registering objects")
        except:
            self.stop()
            raise

    def stop(self):
        self.settle()
        logger.debug("Exiting")
        self.mainloop.quit()

    def settle(self):
        # Wait until all pending events on the main loop were handled
        context = self.mainloop.get_context()  # type: GLib.MainContext
        while context.iteration(may_block=False):
            logger.debug("Waiting for mainloop events to be handled")
            time.sleep(0.1)

    def enable_feature(self, feature: Feature):
        with self.enable_features_lock:
            enabled_features = [ftr for ftr in self.features if ftr.IsEnabled]
            self.config_file.save([*enabled_features, feature])
            feature.refresh_state(["IsEnabled"])
            if not feature.IsEnabled:
                msg = f"Failed to enable feature '{feature.Id}' in config file"
                raise ActivationFailedError(msg)

    def disable_feature(self, feature: Feature):
        with self.enable_features_lock:
            enabled_features = [ftr for ftr in self.features if ftr.IsEnabled]
            enabled_features.remove(feature)
            self.config_file.save(enabled_features)
            feature.refresh_state(["IsEnabled"])
            if feature.IsEnabled:
                msg = f"Failed to disable feature '{feature.Id}' in config file"
                raise DeactivationFailedError(msg)

    def refresh_features(self):
        # Refresh custom features
        bindings = list()
        if self.config_file.exists():
            bindings = self.config_file.parse()
            known_bindings = [
                binding for feature in self.features for binding in feature.Bindings
            ]
            unknown_bindings = [
                binding for binding in bindings if binding not in known_bindings
            ]
            for i, binding in enumerate(unknown_bindings):

                class CustomFeature(Feature):
                    Id = f"CustomFeature{i}"
                    translatable_name = f"Custom Feature ({binding.dest_orig})"
                    Description = str(binding.dest_orig)
                    Bindings = [binding]  # noqa: RUF012

                custom_feature = CustomFeature(self, is_custom=True)
                custom_feature.register(self.connection)
                self.object_manager.export(
                    Gio.DBusObjectSkeleton.new(custom_feature.dbus_path)
                )
                self.features.append(custom_feature)

        # Remove the ones whose binding entry was removed from the config
        # file
        custom_features = [f for f in self.features if f.is_custom]
        for known_custom_feature in custom_features:
            if known_custom_feature.Bindings[0] not in bindings:
                known_custom_feature.unregister(self.connection)
                self.object_manager.unexport(known_custom_feature.dbus_path)
                self.features.remove(known_custom_feature)

        # Refresh state of all features
        exceptions = list()
        for feature in self.features:
            try:
                feature.refresh_state(emit_properties_changed_signal=True)
            except Exception as e:
                logger.exception("Failed to refresh state of feature")
                exceptions.append(e)
        if exceptions:
            raise exceptions[0]

    def refresh_state(self, overwrite_in_progress: bool = False):
        if not self._boot_device:
            # The boot device doesn't exist, which is already handled
            # in the __init__ method, so we don't change the state here
            return

        # Don't overwrite the state if we're in the middle of something.
        # In all methods which set any of these states, we ensure that
        # the state is set to something else when the operation is done
        # or failed.
        if not overwrite_in_progress and self.state in IN_PROGRESS_STATES:
            return

        # Check if the partition exists
        try:
            self._tps_partition = TPSPartition.find()
        except (InvalidBootDeviceError, InvalidPartitionError):
            self._tps_partition = None
            self.State = State.NOT_CREATED
            self.Device = ""
            self.IsCreated = False
            self.IsUnlocked = False
            self.IsUpgraded = False

            num_partitions = len(self._boot_device.partition_table.props.partitions)
            if num_partitions > 1:
                logger.error("Too many partitions: %i", num_partitions)
                self._boot_device = None
                self.Error = InvalidBootDeviceErrorType.TOO_MANY_PARTITIONS

            return

        self.Device = self._tps_partition.device_path
        self.IsCreated = True
        self.IsUpgraded = self._tps_partition.is_upgraded()

        # Check if the partition is unlocked and mounted
        if not self._tps_partition.is_unlocked_and_mounted():
            self.State = State.NOT_UNLOCKED
            self.IsUnlocked = False
            if self._boot_device.block.props.read_only:
                logger.error("Boot device is read-only")
                self.CanDelete = False
                self.CanUnlock = False
                self.Error = InvalidBootDeviceErrorType.READ_ONLY
            else:
                self.CanDelete = True
                self.CanUnlock = True
            return

        self.State = State.UNLOCKED
        self.IsUnlocked = True

    @staticmethod
    def run_on_activated_hooks():
        executil.execute_hooks(ON_ACTIVATED_HOOKS_DIR)

    @staticmethod
    def erase_luks_header_backup():
        luks_header_backup = Path(LUKS_HEADER_BACKUP_PATH)
        executil.check_call(
            [
                "shred",
                "--force",
                "-n",
                "1",
                "-u",
                str(luks_header_backup),
            ]
        )

    @contextlib.contextmanager
    def ensure_system_partition_mounted_read_write(self):
        """Mount the system partition read-write if it isn't already,
        and remount it read-only when the context manager exits."""
        mount_options = (
            executil.check_output(
                [
                    "findmnt",
                    "--noheadings",
                    "--output",
                    "OPTIONS",
                    "--mountpoint",
                    SYSTEM_PARTITION_MOUNT_POINT,
                ]
            )
            .strip()
            .split(",")
        )
        already_mounted_read_write = "rw" in mount_options

        if not already_mounted_read_write:
            executil.check_call(
                [
                    "mount",
                    "-o",
                    "remount,rw",
                    SYSTEM_PARTITION_MOUNT_POINT,
                ]
            )

        try:
            yield
        finally:
            if not already_mounted_read_write:
                executil.check_call(
                    [
                        "mount",
                        "-o",
                        "remount,ro",
                        SYSTEM_PARTITION_MOUNT_POINT,
                    ]
                )
