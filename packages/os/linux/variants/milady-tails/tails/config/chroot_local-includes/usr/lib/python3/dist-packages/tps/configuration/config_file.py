import tempfile
from contextlib import contextmanager
import grp
from io import TextIOBase
import os
from pathlib import Path
import pwd
import shlex
import subprocess
import sys
from typing import TYPE_CHECKING, List, Optional
from threading import Lock

import tps.logging
from tps.configuration.binding import Binding

if TYPE_CHECKING:
    from tps.configuration.feature import Feature

CONFIG_FILE_NAME = "persistence.conf"
if "unittest" in sys.modules:
    TPS_UID = os.getuid()
    TPS_GID = os.getgid()
else:
    TPS_UID = pwd.getpwnam("tails-persistent-storage").pw_uid
    TPS_GID = grp.getgrnam("tails-persistent-storage").gr_gid

logger = tps.logging.get_logger(__name__)


class InvalidStatError(Exception):
    pass


class ConfigFile(object):
    """The Persistent Storage's config file, which lists the
    directories which should be mounted or symlinked on startup.

    The format is compatible with the persistence.conf file of
    live-boot(5), except that:
    * Each line must contain a "source" option
    * The only other option that is supported is the "link" option.
      Specifying the default "bind" option explicitly is not
      supported and the "union" option is also unsupported.

    We only support writing the full config file with all currently
    enabled features.
    We can not easily support adding / deleting the lines of a
    a specific feature or list of features, because that would
    cause the config file to be broken if any two features have the
    same binding. In that case, we would not be able to tell which
    feature a specific line in the config file belongs to, so
    it's not clear which lines should be removed on feature
    deactivation.
    """

    def __init__(self, mount_point: str):
        self.path = Path(mount_point, CONFIG_FILE_NAME)
        # A lock for ensuring that the config file is not read or
        # written while another method writes to it.
        self.lock = Lock()

    def exists(self) -> bool:
        """Returns whether the config file exists"""
        return self.path.exists()

    def check_file_stat(self):
        """Checks if the config file exists, has the expected type,
        owner, permissions, and ACLs"""
        if not self.path.exists():
            raise InvalidStatError(f"File {self.path} does not exist")

        if self.path.is_symlink():
            raise InvalidStatError(f"File {self.path} is a symbolic link")
        if not self.path.is_file():
            raise InvalidStatError(f"File {self.path} is not a regular file")

        stat = self.path.stat()

        # Check ownership
        if stat.st_uid != TPS_UID:
            msg = (
                f"File {self.path} has UID {stat.st_uid}, expected "
                f"{TPS_UID} (tails-persistent-storage)"
            )
            raise InvalidStatError(msg)
        if stat.st_gid != TPS_GID:
            msg = (
                f"File {self.path} has GID {stat.st_gid}, expected "
                f"{TPS_GID} (tails-persistent-storage)"
            )
            raise InvalidStatError(msg)

        # Check mode. Expected is:
        #  * 0o100000, which means the file is a regular file
        #  * 0o600, which means it's only readable by the owner
        if stat.st_mode != 0o100600:
            raise InvalidStatError(
                f"File {self.path} has unexpected mode "
                f"{stat.st_mode}, expected {oct(0o100600)}"
            )

        # Check ACL
        acl = subprocess.check_output(
            ["getfacl", "--omit-header", "--skip-base", self.path]
        ).strip()
        if acl:
            raise InvalidStatError(
                f"File {self.path} has unexpected ACL " f"{acl}, expected no ACLs."
            )

    def parse(self) -> List[Binding]:
        """Parse the config file into bindings"""
        self.lock.acquire()
        try:
            with self._open(self.path) as f:
                config_lines = f.readlines()
        finally:
            self.lock.release()

        res = list()
        for line in config_lines:
            binding = self._parse_line(line)
            if binding:
                res.append(binding)

        return res

    def save(self, features: List["Feature"]):
        """Create the config file for the specified list of features"""
        self.lock.acquire()
        logger.debug(f"Saving config file with features: {[f.Id for f in features]}")
        try:
            # Get the lines we have to set for the features
            lines = list()
            for feature in features:
                lines += [str(binding) + "\n" for binding in feature.Bindings]

            # Sort and remove duplicate lines
            lines = sorted(set(lines))

            # Create a temporary file in the same directory which we
            # will write to and then rename to make saving the config
            # file an atomic operation (so we can't end up with a
            # partially written config file if e.g. the user unplugs the
            # Tails device in the wrong moment).
            dir_ = os.path.dirname(self.path)
            tmpfile = tempfile.NamedTemporaryFile(dir=dir_, delete=False)

            # Write the result list of features to the temporary file
            with self._open(tmpfile.name, "w") as f:
                f.writelines(lines)

            # Rename the temporary file to the config file name
            os.rename(tmpfile.name, self.path)
        finally:
            self.lock.release()

    def contains(self, feature: "Feature") -> bool:
        """Returns True if the config file contains all binding lines
        of all the specified features, else False."""
        bindings = self.parse()
        return all(binding in bindings for binding in feature.Bindings)

    def disable_and_create_empty(self):
        """Renames the current config file to its filename + .invalid
        and creates a new, empty config file"""
        self.lock.acquire()
        try:
            self.path.rename(str(self.path) + ".invalid")
        finally:
            self.lock.release()
        self.save([])

    def _opener(self, path, flags):
        # When opening the config file or the backup file, we want
        #   * the file content to be synced to disk on close, and
        #   * the file to be created owner-readable
        fd = os.open(path, flags | os.O_SYNC, mode=0o600)

        # Ensure that the file is owned by the tails-persistent-storage
        # user
        os.fchown(fd, TPS_UID, TPS_GID)

        # Ensure changes made elsewhere are written synchronously on the disk
        # (in case something else ever needs to modify this file)
        subprocess.check_call(["chattr", "+S", path])
        return fd

    @contextmanager
    def _open(self, path, *args, **kwargs) -> TextIOBase:
        with open(path, *args, **kwargs, opener=self._opener) as f:
            yield f

    @staticmethod
    def _parse_line(line: str) -> Optional[Binding]:
        dest, src = "", ""
        is_file = False
        uses_symlinks = False

        # Get the white-space separated elements of the config line
        elements = shlex.split(line, comments=True)
        if len(elements) != 2:
            # The line has an invalid number of white-space
            # separated elements
            logger.warning("Ignoring invalid config line: %r", line)
            return

        dest = elements[0]
        options = elements[1].split(",")

        # Parse the options
        for option in options:
            if option.startswith("source="):
                src = option[7:]
            elif option == "link":
                uses_symlinks = True
            elif option == "file":
                is_file = True
            else:
                logger.warning(
                    "Ignoring config line with invalid option " "%r: %r", option, line
                )
                return

        if not src:
            logger.warning("Ignoring config line without source: %r", line)
            return

        # Create and return the Binding object
        return Binding(src, dest, is_file, uses_symlinks)
