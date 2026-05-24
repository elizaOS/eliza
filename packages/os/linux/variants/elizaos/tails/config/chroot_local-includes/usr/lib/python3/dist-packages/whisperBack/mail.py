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

"""WhisperBack mailing library

"""

import logging
import smtplib
import socket
from gettext import gettext as _

import socks
from tailslib.tor import TOR_HAS_BOOTSTRAPPED_PATH

import whisperBack.exceptions

LOG = logging.getLogger(__name__)


# pylint: disable=R0913
def send_message(
    from_address,
    to_address,
    message,
    host="localhost",
    port=25,
    socks_host="127.0.0.1",
    socks_port=9050,
):
    """Sends a mail

    Send the message via our own SMTP server, but don't include the
    envelope header. This is based on an example from doc.python.org

    @param from_address The sender's address
    @param to_address The recipient address
    @param message The content of the mail
    @param host The host of the smtp server to connect to
    @param port The port of the smtp server to connect to
    @param socks_host The host of the SOCKS proxy to connect through
    @param socks_port The port of the SOCKS proxy to connect through
    """

    if not TOR_HAS_BOOTSTRAPPED_PATH.exists():
        raise whisperBack.exceptions.TorNotBootstrappedException()

    LOG.debug("Sending mail")
    # Monkeypatching the entire connection through the SOCKS proxy
    socks.set_default_proxy(socks.SOCKS5, socks_host, socks_port)
    socket.socket = socks.socksocket

    # We set a long timeout because Tor is slow
    with smtplib.SMTP(host=host, port=port, timeout=120) as smtp:
        smtp.sendmail(from_address, [to_address], message)
        smtp.quit()
