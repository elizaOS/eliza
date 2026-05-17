########################################################################
# WhisperBack - Send feedback in an encrypted mail
# Copyright (C) 2009-2018 Tails developers <foundations@tails.net>
#
# This file is part of WhisperBack
#
# WhisperBack is  free software; you can redistribute  it and/or modify
# it under the  terms of the GNU General Public  License as published by
# the Free Software Foundation; either  version 3 of the License, or (at
# your option) any later version.
#
# This program  is distributed in the  hope that it will  be useful, but
# WITHOUT   ANY  WARRANTY;   without  even   the  implied   warranty  of
# MERCHANTABILITY  or FITNESS  FOR A  PARTICULAR PURPOSE.   See  the GNU
# General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.
########################################################################

"""various WhisperBack utility functions

"""

import locale
import logging
import os
import re
import urllib.parse
from textwrap import TextWrapper

LOG = logging.getLogger(__name__)
# Ugly paths finder utilities


def guess_prefix():
    """Tries to guess the prefix

    @return The guessed prefix"""

    # XXX: hardcoded path !
    if os.path.exists("/usr/local/share/whisperback"):
        return "/usr/local"
    elif os.path.exists("/usr/share/whisperback"):
        return "/usr"
    else:
        return None


def get_sharedir():
    """Tries to guess the shared data directiry

    @return The guessed shared data directiry"""

    if guess_prefix():
        return os.path.join(guess_prefix(), "share")
    else:
        return "data"


def get_datadir():
    """Tries to guess the datadir

    @return The guessed datadir"""
    if guess_prefix():
        return os.path.join(get_sharedir(), "whisperback")
    else:
        return "data"


def get_pixmapdir():
    """Tries to guess the pixmapdir

    @return The guessed pixmapdir"""

    if guess_prefix():
        return os.path.join(get_sharedir(), "pixmaps")
    else:
        return "data"


# Input validation functions


def is_valid_link(candidate):
    """Check if candidate seems to be a internet link

    @param candidate the URL to be checked

    @returns true if candidate is an URL with:
    - an hostname of the form domain.tld
    - a scheme http(s) or ftp(S)
    """
    LOG.debug("Validating link %s", candidate)
    parseresult = urllib.parse.urlparse(candidate)
    # pylint: disable=E1101
    if re.search(r"^(ht|f)tp(s)?$", parseresult.scheme) and re.search(
        r"^(\w{1,}\.){1,}\w{1,}$", parseresult.hostname
    ):
        return True
    else:
        return False


def is_valid_pgp_block(candidate):
    """Check if candidate seems to be a PGP public key block

    @param    candidate the string to be checked

    @returns  true if candidate starts with `-----BEGIN PGP PUBLIC KEY BLOCK----`
              and ends with `-----END PGP PUBLIC KEY BLOCK-----`
    """
    LOG.debug("Validating pgp block %s", candidate)
    # pylint: disable=C0301
    if re.search(
        r"-----BEGIN PGP PUBLIC KEY BLOCK-----\n(?:.*\n)+-----END PGP PUBLIC KEY BLOCK-----",
        candidate,
    ):
        return True
    else:
        return False


def is_valid_pgp_id(candidate):
    """Check if candidate looks like a pgp key ID

    @param    candidate the string to be checked

    @returns  true if candidate is either an 8 or 16 digit hex number or a 40
              digit hex fingerprint
    """
    # pylint: disable=C0301
    LOG.debug("Validating pgp id %s", candidate)
    if re.search(
        r"(?:^(?:0x)?(?:[0-9a-fA-F]{8}){1,2}$)|(?:^(?:[0-9a-fA-F]{4} {0,2}){10}$)",
        candidate,
    ):
        return True
    else:
        return False


def is_valid_email(candidate):
    """Check if candidate looks like an email address

    @param    candidate the string to be checked

    @returns  true if candidate is in the form test@example.com
    """
    LOG.debug("Validating email %s", candidate)
    if re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,4}", candidate):
        return True
    else:
        return False


def is_valid_port(candidate):
    """Check if candidate is a valid port number (integer between 1 and 65535)

    @param candidate the port number to be checked
    """
    LOG.debug("Validating port %s", candidate)
    try:
        int(candidate)
    except ValueError:
        return False

    if candidate >= 1 and candidate < 65535:
        return True
    else:
        return False


def is_valid_hostname_or_ipv4(candidate):
    """Check if candidate is a valid hostname or IPv4 address

    pySocks is not compatible with IPv6
    hostname specs follow RFC 1123

    @param candidate the hostname or IPv4 address to validate
    """
    LOG.debug("Validating host or IP %s", candidate)
    # XXX: must be updated once IPv6 is enabled

    if not isinstance(candidate, str):
        return False
    if len(candidate) > 255:
        return False

    # regex from https://stackoverflow.com/a/17871737
    ip_address_regex = re.compile(
        r"^((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])[.]){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])$"
    )
    hostname_regex = re.compile(
        r"^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])[.])*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$"
    )

    if ip_address_regex.match(candidate) or hostname_regex.match(candidate):
        return True
    else:
        return False


def sanitize_hardware_info(log_string):
    """Sanitize hardware-identifying info from a string

    Removes strings:

    - labeled as serial numbers and UUID;
    - looking like IPs or MAC addresses.
    - looking like web URLs (starting with http(s)://)
    - looking like ESSID

    @param  log_string  the string to be sanitized

    @returns a sanitized version of log_string
    """
    # XXX: must be updated once IPv6 is enabled

    # DMI
    log_string = re.sub(r"(DMI:)[\s].*", r"\1[DMI REMOVED]", log_string)

    # Serial Numbers
    log_string = re.sub(
        r"(Serial Number:?[\s]+|"
        r"SerialNo=|"
        r"iSerial[\s]+[\d]+\s+|"
        r"SerialNumber:[\s]+|"
        r"SerialNumber=|"
        r"Serial#:[\s+]|"
        r"serial#[\s+]|"
        r"Serial No:[\s]+"
        r")[^\s].*",
        r"\1[SN REMOVED]",
        log_string,
    )
    # UUIDs
    log_string = re.sub(r"(UUID:[\s]+)[^\s].+", r"\1[UUID REMOVED]", log_string)

    # IPv4s
    # regex from https://stackoverflow.com/a/17871737
    log_string = re.sub(
        r"((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])",
        r"[IPV4 REMOVED]",
        log_string,
    )
    # IPv6s
    # regex from https://stackoverflow.com/a/17871737
    log_string = re.sub(
        r"("
        r"([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|"  # 1:2:3:4:5:6:7:8
        r"([0-9a-fA-F]{1,4}:){1,7}:|"  # 1::                              1:2:3:4:5:6:7::
        r"([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|"  # 1::8             1:2:3:4:5:6::8  1:2:3:4:5:6::8
        r"([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|"  # 1::7:8           1:2:3:4:5::7:8  1:2:3:4:5::8
        r"([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|"  # 1::6:7:8         1:2:3:4::6:7:8  1:2:3:4::8
        r"([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|"  # 1::5:6:7:8       1:2:3::5:6:7:8  1:2:3::8
        r"([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|"  # 1::4:5:6:7:8     1:2::4:5:6:7:8  1:2::8
        r"[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|"  # 1::3:4:5:6:7:8   1::3:4:5:6:7:8  1::8
        r":((:[0-9a-fA-F]{1,4}){1,7}|:)|"  # ::2:3:4:5:6:7:8  ::2:3:4:5:6:7:8 ::8       ::
        r"fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|"  # fe80::7:8%eth0   fe80::7:8%1     (link-local IPv6 addresses with zone index)
        r"::(ffff(:0{1,4}){0,1}:){0,1}"
        r"((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}"
        r"(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|"  # ::255.255.255.255   ::ffff:255.255.255.255  ::ffff:0:255.255.255.255  (IPv4-mapped IPv6 addresses and IPv4-translated addresses)
        r"([0-9a-fA-F]{1,4}:){1,4}:"
        r"((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}"
        r"(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])"  # 2001:db8:3:4::192.0.2.33  64:ff9b::192.0.2.33 (IPv4-Embedded IPv6 Address)
        r")",
        r"[IPV6 REMOVED]",
        log_string,
    )
    # MAC addresses
    log_string = re.sub(
        r"(?i)([0-9A-F]{2}:){5,}[0-9A-F]{2}", r"[MAC REMOVED]", log_string
    )
    # HTTP(s) URLs
    log_string = re.sub(r"(http(s?)://)[^\s]+", r"\1[URL REMOVED]", log_string)

    # ESSID
    log_string = re.sub(
        r"(SSID=|"
        "connection |"
        "access point |"
        "'ssid' value |"
        "NetworkManager.*set |"
        "network |"
        "ssid=|"
        "NetworkManager.*name="
        ")(['\"])[^'\"]+(['\"])",
        r"\1\2[ESSID REMOVED]\3",
        log_string,
    )

    return log_string


def wrap_text(text):
    """Wraps long lines of text to a width of 70 chars
    @param text the string to be wrapped

    @return The wrapped text"""
    LOG.debug("Wrapping text")

    wrapper = TextWrapper()
    wrapped = [wrapper.fill(line) for line in text.split("\n")]
    return "\n".join(wrapped)
