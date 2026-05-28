from enum import Enum, IntEnum
import gettext
import gi
import os

# We don't need udisks when running the tests
if not os.getenv("BEHAVE") and not os.getenv("NO_UDISKS"):
    gi.require_version("UDisks", "2.0")
    from gi.repository import UDisks

_ = gettext.gettext

_udisks = None  # type: UDisks.Client | None


def udisks() -> "UDisks.Client":
    global _udisks  # noqa: PLW0603
    # Connect to the udisks service if we haven't already or if the
    # connection was lost (we check for the latter by calling
    # get_manager() which returns None if the connection was lost).
    if _udisks is None or _udisks.get_manager() is None:
        _udisks = UDisks.Client.new_sync()  # type: UDisks.Client
    return _udisks


DBUS_SERVICE_NAME = "org.boum.tails.PersistentStorage"
DBUS_ROOT_OBJECT_PATH = "/org/boum/tails/PersistentStorage"
DBUS_FEATURES_PATH = "/org/boum/tails/PersistentStorage/Features"
DBUS_JOBS_PATH = "/org/boum/tails/PersistentStorage/Jobs"
DBUS_SERVICE_INTERFACE = "org.boum.tails.PersistentStorage"
DBUS_FEATURE_INTERFACE = "org.boum.tails.PersistentStorage.Feature"
DBUS_JOB_INTERFACE = "org.boum.tails.PersistentStorage.Job"

TPS_MOUNT_POINT = "/live/persistence/TailsData_unlocked"
TPS_BACKUP_MOUNT_POINT = "/media/amnesia/TailsData"

SYSTEM_PARTITION_MOUNT_POINT = "/lib/live/mount/medium"
LUKS_HEADER_BACKUP_PATH = SYSTEM_PARTITION_MOUNT_POINT + "/luks-header-backup"

ON_ACTIVATED_HOOKS_DIR = "/usr/local/lib/persistent-storage/on-activated-hooks"
ON_DEACTIVATED_HOOKS_DIR = "/usr/local/lib/persistent-storage/on-deactivated-hooks"

IO_ERRORS_FLAG_FILE_PATH = "/var/lib/live/tails.disk.ioerrors"


class State(Enum):
    UNKNOWN = 0
    ERROR = 1
    NOT_CREATED = 2
    CREATING = 3
    DELETING = 4
    NOT_UNLOCKED = 5
    UNLOCKING = 6
    UNLOCKED = 7
    UPGRADING = 8


IN_PROGRESS_STATES = (State.CREATING, State.DELETING, State.UNLOCKING)


class InvalidBootDeviceErrorType(IntEnum):
    # 0 is the value of the Error property when no error was raised yet,
    # so let's ensure we don't use it for anything else.
    UNKNOWN = 0
    UNSUPPORTED_INSTALLATION_METHOD = 1
    TOO_MANY_PARTITIONS = 2
    READ_ONLY = 3


PROFILING = False
PROFILES_DIR = "/run/tails-persistent-storage/profiles"
