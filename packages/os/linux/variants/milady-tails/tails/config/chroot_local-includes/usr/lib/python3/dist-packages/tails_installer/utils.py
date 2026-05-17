import os
import re
import subprocess
import shutil
import stat
import sys
import psutil
from tails_installer import _
from tails_installer.config import CONFIG
from tailslib.persistence import PERSISTENCE_DIR, has_unlocked_persistence


from gi.repository import GLib


class TailsError(Exception):
    """A generic Exception the allows us to manage error
    messages encoded in unicode"""

    def __init__(self, message):
        super().__init__(message)


def _to_unicode(obj, encoding="utf-8"):
    if hasattr(obj, "toUtf8"):  # PyQt4.QtCore.QString
        obj = str(obj.toUtf8())
    if isinstance(obj, str):
        if not isinstance(obj, str):
            obj = str(obj, encoding)
    return obj


def bytes_to_unicode(string):
    if isinstance(string, bytes):
        return string.decode("utf-8")
    return string


def unicode_to_filesystemencoding(string):
    if isinstance(string, bytes):
        return string.decode(sys.getfilesystemencoding(), "replace")
    return string


def extract_file_content_from_iso(iso_path, path):
    """Return the content of that file read from inside self.iso"""

    cmd = [
        "isoinfo",
        "-R",
        "-i",
        bytes_to_unicode(iso_path),
        "-x",
        bytes_to_unicode(path),
    ]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = proc.communicate()
    out = bytes_to_unicode(out)
    err = bytes_to_unicode(err)
    if proc.returncode:
        raise Exception(
            _("There was a problem executing `%(cmd)s`.%(out)s\n%(err)s")
            % {"cmd": cmd, "out": out, "err": err}
        )
    return out


def iso_is_live_system(iso_path):
    """Return true if and only if a Live system is detected inside the iso_path file"""
    version = extract_file_content_from_iso(iso_path, "/.disk/info")
    return version.startswith("Debian GNU/Linux")


def get_persistent_storage_backup_size():
    """If unlocked, return the minimum partition size (bytes) we accept as a valid target to
    back up the current Tails, else None."""
    luks2_header_size = 16
    if has_unlocked_persistence():
        return psutil.disk_usage(PERSISTENCE_DIR).used + mebibytes_to_bytes(
            luks2_header_size
        )


def _dir_size(source):
    total_size = os.path.getsize(source)
    for item in os.listdir(source):
        itempath = os.path.join(source, item)
        if os.path.isfile(itempath):
            total_size += os.path.getsize(itempath)
        elif os.path.isdir(itempath):
            total_size += _dir_size(itempath)
    return total_size


def _move_if_exists(src, dest):
    if os.path.exists(src):
        shutil.move(src, dest)


def _unlink_if_exists(path):
    if os.path.exists(path):
        os.unlink(path)


def underlying_physical_device(path):
    """Returns the physical block device UDI on which the specified file is
    stored (e.g. /org/freedesktop/UDisks2/block_devices/sdb).
    """
    rawdev = os.stat(path)[stat.ST_DEV]
    from gi.repository import UDisks

    udisksclient = UDisks.Client.new_sync()
    block = udisksclient.get_block_for_dev(rawdev)
    drive = udisksclient.get_drive_for_block(block)
    parentblock = udisksclient.get_block_for_drive(drive, get_physical=False)
    return parentblock.get_object_path()


def _format_bytes_in_gb(value):
    return "%0.1f GB" % (value / 10.0**9)


def mebibytes_to_bytes(size_in_mebibytes):
    return size_in_mebibytes * 1024**2


def _get_datadir():
    script_path = os.path.abspath(sys.argv[0])
    if not script_path.startswith("/usr/"):
        if os.path.exists("data/tails-installer.ui"):
            return "data"
    else:
        return "/usr/share/tails-installer"


def get_open_write_fd(block):
    """@returns the file descriptor for a block"""
    (fd_index, fd_list) = block.call_open_for_restore_sync(
        arg_options=GLib.Variant("a{sv}", None)
    )
    file_desc = fd_list.get(fd_index.get_handle())
    if file_desc == -1:
        raise Exception(_("Could not open device for writing."))
    return file_desc


def write_to_block_device(block, string, offset: int = 0):
    """Writes a string to a block"""
    file_desc = get_open_write_fd(block)
    if offset:
        os.lseek(file_desc, offset, os.SEEK_SET)
    os.write(file_desc, string)
    os.fsync(file_desc)
    os.close(file_desc)


def _set_liberal_perms_recursive(path):
    if os.path.isfile(path):
        os.chmod(path, 0o644)
    elif os.path.isdir(path):
        os.chmod(path, 0o755)  # nosec set_bad_file_permissions  # noqa: S103
        for f in os.listdir(path):
            _set_liberal_perms_recursive(os.path.join(path, f))
