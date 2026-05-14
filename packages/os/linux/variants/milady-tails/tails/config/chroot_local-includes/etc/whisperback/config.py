# Tails configuration file for WhisperBack
# ==========================================
#
# This is a Python script that will be read at startup. Any Python
# syntax is valid.

# IMPORTS

# Custom imports
import random

# ENCRYPTION
#
# This section defines encryption parameters

# The path to the OpenPGP keyring to use. If None, use OpenPGP default
# keyring.
gnupg_keyring = "/usr/share/keyrings/whisperback-keyring.gpg"

# RECIPIENT
#
# This section defines the recipient parameters

# The address of the recipient
to_address = "support@tails.net"

# The fingerprint of the recipient's GPG key
to_fingerprint = "1F56EDD30741048035DAC1C5EC57B56EF0C43132"

# SENDER
#
# This section defines the sender parameters

# The address of the sender
from_address = "devnull@tails.boum.org"

# SMTP
#
# This section defines the SMTP server parameters
#
# The SMTP server to use to send the mail
smtp_host = "whisperback.tails.net"
# The port to connect to on that SMTP server
smtp_port = 2525

# SOCKS
#
# This section defines the SOCKS proxy parameters
#
# The SOCKS proxy to use to send the mail
socks_host = "127.0.0.1"
# The port to connect to on that SOCKS proxy
socks_port = 9062

# MESSAGE
#
# This section defines the message parameters

# The subject of the email to be sent
# Please take into account that this will not be encrypted
mail_subject = "Bug report: %x" % random.randrange(16**32)  # noqa: S311


def mail_prepended_info():
    """Return the version of the running Tails system.

    A callback function to get information to prepend to the mail
    (this information will be encrypted). This is useful to add
    software version.

    It should not take any parameter, and should return a string to be
    prepended to the email

    @return The tails version, if possible, or an English string
            explaining the error
    """
    try:
        with open("/etc/os-release") as f:
            tails_version = f.read()
    except FileNotFoundError:
        tails_version = "/etc/os-release file not found"

    return "Tails-Version: %s\n" % tails_version
