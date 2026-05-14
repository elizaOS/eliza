########################################################################
# WhisperBack - Send feedback in an encrypted mail
# Copyright (C) 2009-2018 Tails developers <foundations@tails.net>
# This file includes code Copyright (C) 2009 W. Trevor King <wking@drexel.edu>
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

"""Some tools for encryption

"""
import email.encoders
import email.mime.application
import email.mime.base
import email.mime.multipart
import email.mime.text
import logging
import os.path

import gnupg

import whisperBack.exceptions

LOG = logging.getLogger(__name__)


class Encryption:
    """Some tools for encryption"""

    def __init__(self, keyring=None):
        """Initialize the encryption mechanism"""

        if not (keyring and os.path.exists(keyring)):
            keyring = None

        self._gpg = gnupg.GPG(keyring=keyring, gpgbinary="/usr/bin/gpg")

    def pgp_mime_encrypt(self, message, to_fingerprints):
        """Encrypts  for a list of recipients

        This code is based on send_pgp_mime by W. Trevor King <wking@drexel.edu>
        available at:
        http://www.physics.drexel.edu/~wking/code/python/send_pgp_mime

        @param to_fingerprints A list of recepient's key fingerprints
        @param message MIME message to be encrypted.
        @return The encrypted data
        """
        LOG.debug("Encrypting MIME message")
        assert isinstance(message, email.mime.base.MIMEBase)

        crypt = self._gpg.encrypt(
            message.as_string(), to_fingerprints, always_trust=True
        )
        if not crypt.ok:
            raise whisperBack.exceptions.EncryptionException(crypt.status)

        enc = email.mime.application.MIMEApplication(
            _data=str(crypt),
            _subtype='octet-stream; name="encrypted.asc"',
            _encoder=email.encoders.encode_7or8bit,
        )
        enc["Content-Description"] = "OpenPGP encrypted message"
        enc.set_charset("us-ascii")

        control = email.mime.application.MIMEApplication(
            _data="Version: 1\n",
            _subtype="pgp-encrypted",
            _encoder=email.encoders.encode_7or8bit,
        )
        control.set_charset("us-ascii")

        encmsg = email.mime.multipart.MIMEMultipart(
            "encrypted", protocol="application/pgp-encrypted"
        )
        encmsg.attach(control)
        encmsg.attach(enc)
        encmsg["Content-Disposition"] = "inline"

        return encmsg
