from abc import abstractmethod

from gi.repository import Gio, GLib


class DBusError(Exception):
    """An exception that can be returned as an error by a D-Bus method"""

    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @classmethod
    def is_instance(cls, err) -> bool:
        # noinspection PyArgumentList
        if not Gio.DBusError.is_remote_error(err):
            return False
        # noinspection PyArgumentList
        return Gio.DBusError.get_remote_error(err) == cls.name

    @classmethod
    def strip_remote_error(cls, err: GLib.Error):
        # This function should not be required,
        # Gio.DBusError.strip_remote_error should be used instead, but
        # that's currently broken, see
        # https://gitlab.gnome.org/GNOME/pygobject/-/issues/342
        prefix = f"GDBus.Error:{cls.name}: "
        if err.message.startswith(prefix):
            err.message = err.message[len(prefix) :]
            return

        prefix = "GDBus.Error:"
        if err.message.startswith(prefix):
            err.message = err.message[len(prefix) :]


class ActivationFailedError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.ActivationFailed"


class DeactivationFailedError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.DeactivationFailed"


class DeletionFailedError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.DeletionFailed"


class FailedPreconditionError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.FailedPrecondition"


class JobCancelledError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.JobCancelled"


class TargetIsBusyError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.TargetIsBusyError"


class NotEnoughMemoryError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.NotEnoughMemoryError"


class IncorrectPassphraseError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.IncorrectPassphraseError"


class SymlinkSourceDirectoryError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.SymlinkSourceDirectoryError"


class InvalidConfigFileError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.InvalidConfigFileError"


class FeatureActivationFailedError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.FeatureActivationFailedError"


class FilesystemRepairFailure(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.FilesystemRepairFailure"


class FilesystemErrorsLeftUncorrectedError(FilesystemRepairFailure):
    name = "org.boum.tails.PersistentStorage.Error.FilesystemErrorsLeftUncorrectedError"


class FilesystemRepairAborted(FilesystemRepairFailure):
    name = "org.boum.tails.PersistentStorage.Error.FilesystemRepairAborted"


class IOErrorsDetectedError(DBusError):
    name = "org.boum.tails.PersistentStorage.Error.IOErrorsDetectedError"
