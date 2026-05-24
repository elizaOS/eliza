#
# Copyright © 2008  Red Hat, Inc. All rights reserved.
#
# This copyrighted material is made available to anyone wishing to use, modify,
# copy, or redistribute it subject to the terms and conditions of the GNU
# General Public License v.2.  This program is distributed in the hope that it
# will be useful, but WITHOUT ANY WARRANTY expressed or implied, including the
# implied warranties of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
# See the GNU General Public License for more details.  You should have
# received a copy of the GNU General Public License along with this program; if
# not, write to the Free Software Foundation, Inc., 51 Franklin Street, Fifth
# Floor, Boston, MA 02110-1301, USA. Any Red Hat trademarks that are
# incorporated in the source code or documentation are not subject to the GNU
# General Public License and may only be used or replicated with the express
# permission of Red Hat, Inc.
#
# Author(s): Luke Macken <lmacken@redhat.com>

import os
import gettext

# Add sbin to PATH to support unprivileged mode
if os.path.exists("/usr/sbin") or os.path.exists("/usr/local/sbin"):
    try:
        os.environ["PATH"] = "/usr/local/sbin:/usr/sbin:" + os.environ["PATH"]
    except KeyError:
        os.environ["PATH"] = "/usr/local/sbin:/usr/sbin"


def utf8_gettext(*args, **kwargs):
    """Translate string, converting it to a UTF-8 encoded bytestring"""
    return gettext.translation("tails", "/usr/share/locale", fallback=True).gettext(
        *args, **kwargs
    )


_ = utf8_gettext

from tails_installer.creator import TailsInstallerError  # noqa: E402
from tails_installer.creator import TargetDeviceBusy  # noqa: E402
from tails_installer.creator import TailsInstallerCreator  # noqa: E402
from tails_installer.config import CONFIG  # noqa: E402

branding = {
    "distribution": CONFIG["branding"]["distribution"],
    "header": CONFIG["branding"]["header"],
}
