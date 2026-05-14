# -*- coding: utf-8 -*-

import os
import shutil
import sys
import subprocess
from stat import ST_SIZE
from tails_installer import _
from tails_installer.config import CONFIG
from tails_installer.utils import (
    _to_unicode,
    _dir_size,
    iso_is_live_system,
    unicode_to_filesystemencoding,
    _set_liberal_perms_recursive,
    underlying_physical_device,
    TailsError,
)


class SourceError(TailsError):
    """A generic error message that is thrown by the Source classes"""

    pass


class Source(object):
    def clone(self, destination):
        raise NotImplementedError


class LocalIsoSource(Source):
    def __init__(self, path):
        self.path = os.path.abspath(_to_unicode(path))
        self.size = os.stat(self.path)[ST_SIZE]
        if not iso_is_live_system(self.path):
            raise SourceError(_("Unable to find Tails on ISO"))
        self.dev = None
        # This can fail for devices not supported by UDisks such as aufs mounts
        try:
            self.dev = underlying_physical_device(self.path)
        except Exception as e:
            print(
                _("Could not guess underlying block device: %s") % e.args[0],
                file=sys.stderr,
            )
            pass

    def clone(self, destination):
        cmd = ["7z", "x", self.path, "-x![BOOT]", "-y", "-o%s" % (destination)]
        cmd_decoded = " ".join(cmd)
        cmd_bytes = [unicode_to_filesystemencoding(el) for el in cmd]
        proc = subprocess.Popen(
            cmd_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        out, err = proc.communicate()
        out = out.decode("utf-8")
        err = err.decode("utf-8")
        if proc.returncode:
            raise SourceError(
                _("There was a problem executing `%(cmd)s`.\n" "%(out)s\n%(err)s")
                % {"cmd": cmd_decoded, "out": out, "err": err}
            )
        _set_liberal_perms_recursive(destination)


class RunningLiveSystemSource(Source):
    def __init__(self, path):
        if not os.path.exists(path):
            raise SourceError(_('"%s" does not exist') % path)
        if not os.path.isdir(path):
            raise SourceError(_('"%s" is not a directory') % path)
        self.path = path
        self.size = _dir_size(self.path)
        self.dev = underlying_physical_device(self.path)

    def clone(self, destination):
        for f in CONFIG["liveos_toplevel_files"]:
            src = os.path.join(self.path, f)
            dst = os.path.join(destination, f)
            if os.path.isfile(src):
                if src.lower().endswith(".iso"):
                    print(
                        _('Skipping "%(filename)s"') % {"filename": src},
                        file=sys.stderr,
                    )
                else:
                    shutil.copy(src, dst)
            elif os.path.islink(src):
                linkto = os.readlink(src)
                os.symlink(linkto, dst)
            elif os.path.isdir(src):
                shutil.copytree(src, dst)
        _set_liberal_perms_recursive(destination)
