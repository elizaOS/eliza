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

"""WhisperBack main backend

"""

import email.mime.text
import json
import logging
import os
import re
import threading
from gettext import gettext as _

from gi.repository import GLib

import whisperBack.encryption
import whisperBack.exceptions
import whisperBack.mail
import whisperBack.utils

LOG = logging.getLogger(__name__)


# pylint: disable=R0902
class WhisperBackBackend:
    """
    This class contains the backend which actually sends the feedback
    """

    def set_contact_email(self, email):
        """Sets an optional email address to be used for further communication"""

        LOG.debug("Setting contact email")
        if whisperBack.utils.is_valid_email(email):
            self._contact_email = email
        else:
            # XXX use a better exception
            raise ValueError(_("Invalid contact email: %s") % email)

    # pylint: disable=W0212
    contact_email = property(lambda self: self._contact_email, set_contact_email)

    def set_contact_gpgkey(self, gpgkey):
        """Sets an optional PGP key to be used for further communication"""

        LOG.debug("Setting PGP key")
        if (
            whisperBack.utils.is_valid_pgp_block(gpgkey)
            or whisperBack.utils.is_valid_pgp_id(gpgkey)
            or whisperBack.utils.is_valid_link(gpgkey)
            or gpgkey == ""
        ):
            self._contact_gpgkey = gpgkey
        else:
            # XXX use a better exception
            if len(gpgkey.splitlines()) <= 1:
                message = _("Invalid contact OpenPGP key: %s") % gpgkey
            else:
                message = _("Invalid contact OpenPGP public key block")
            raise ValueError(message)

    # pylint: disable=W0212
    contact_gpgkey = property(lambda self: self._contact_gpgkey, set_contact_gpgkey)

    def __init__(
        self,
        debugging_info: str,
        bug_specific_text: str | None,
        subject="",
        message="",
    ):
        """Initialize a feedback object with the given contents

        @param subject The topic of the feedback
        @param message The content of the feedback
        """
        self.__thread = None
        self.__error_output = None

        # Initialize config variables
        self.gnupg_keyring = None
        self.to_address = None
        self.to_fingerprint = None
        self.from_address = None
        self.mail_prepended_info = lambda: ""
        self.mail_subject = None
        self.smtp_host = None
        self.smtp_port = None
        self.socks_host = None
        self.socks_port = None

        # Load the python configuration file "config.py"
        # XXX: this is an absolute path, bad !
        self.__load_conf(os.path.join("/", "etc", "whisperback", "config.py"))
        self.__check_conf()

        # Get additional info through the callbacks and sanitize it
        self.prepended_data = whisperBack.utils.sanitize_hardware_info(
            self.mail_prepended_info(),
        )
        self.bug_specific_text = bug_specific_text
        self.appended_data = self.__get_debug_info(debugging_info)

        # Initialize other variables
        self.subject = subject
        self.message = message
        self._contact_email = None
        self._contact_gpgkey = None

    def __load_conf(self, config_file_path):
        """Loads a configuration file from config_file_path and executes it
        inside the current class.

        @param config_file_path The path on the configuration file to load
        """

        LOG.debug("Loading conf from %s", config_file_path)
        f = None
        try:
            f = open(config_file_path)
            code = f.read()
        except OSError:
            # There's no problem if one of the configuration files is not
            # present
            LOG.warning("Failed to load conf %s", config_file_path)
            return
        finally:
            if f:
                f.close()
        # pylint: disable=W0122
        exec(code, self.__dict__)  # noqa: S102

    def __get_debug_info(self, raw_debug, prefix=""):
        """Deserializes the dicts from raw_debug and creates a string
        with the header from the dict key and it's content

        @param raw_debug The serialized json containing the debug info
        It is a list of dicts to keep the order of the different debug infos
        """
        all_info = json.loads(raw_debug)
        result = ""
        for debug_info in all_info:
            if prefix:
                result += "\n{} === content of {} ===\n".format(
                    prefix,
                    debug_info["key"],
                )
            else:
                result += "\n======= content of {} =======\n".format(debug_info["key"])
            if isinstance(debug_info["content"], list):
                for line in debug_info["content"]:
                    if isinstance(line, dict):
                        result += self.__get_debug_info(
                            json.dumps([line]),
                            prefix + "> ",
                        )
                    else:
                        sanitized = "{}{}\n".format(
                            prefix,
                            whisperBack.utils.sanitize_hardware_info(line),
                        )
                        result += re.sub(r"^--\s*", "", sanitized)
            else:
                result += "{}{}\n".format(
                    prefix,
                    whisperBack.utils.sanitize_hardware_info(debug_info["content"]),
                )
        return result

    def __check_conf(self):
        """Check that all the required configuration variables are filled
        and raise MisconfigurationException if not.
        """
        LOG.debug("Checking conf")
        # XXX: Add sanity checks

        if not self.to_address:
            raise whisperBack.exceptions.MisconfigurationException("to_address")
        if not self.to_fingerprint:
            raise whisperBack.exceptions.MisconfigurationException("to_fingerprint")
        if not self.from_address:
            raise whisperBack.exceptions.MisconfigurationException("from_address")
        if not self.mail_subject:
            raise whisperBack.exceptions.MisconfigurationException("mail_subject")
        if not self.smtp_host:
            raise whisperBack.exceptions.MisconfigurationException("smtp_host")
        if not self.smtp_port:
            raise whisperBack.exceptions.MisconfigurationException("smtp_port")
        if not self.socks_host:
            raise whisperBack.exceptions.MisconfigurationException("socks_host")
        if not self.socks_port:
            raise whisperBack.exceptions.MisconfigurationException("socks_port")

        if not whisperBack.utils.is_valid_hostname_or_ipv4(self.smtp_host):
            raise ValueError("Invalid value for 'smtp_host'.")
        if not whisperBack.utils.is_valid_port(self.smtp_port):
            raise ValueError("Invalid value for 'smtp_port'.")
        if not whisperBack.utils.is_valid_hostname_or_ipv4(self.socks_host):
            raise ValueError("Invalid value for 'socks_host'.")
        if not whisperBack.utils.is_valid_port(self.socks_port):
            raise ValueError("Invalid value for 'socks_port'.")

    def execute_threaded(
        self,
        func,
        args,
        progress_callback=None,
        finished_callback=None,
        polling_freq=100,
    ):
        """Execute a function in another thread and handle it.

        Execute the function `func` with arguments `args` in another thread,
        and poll whether the thread is alive, executing the callback
        `progress_callback` every `polling_frequency`. When the function
        thread terminates, saves the exception it eventually raised and pass
        it to `finished_callback`.

        @param func               the function to execute.
        @param args               the tuple to pass as arguments to `func`.
        @param progress_callback  (optional) a callback function to call
                                  every time the execution thread is polled.
                                  It doesn't take any argument.
        @param finished_callback  (optional) a callback function to call when
                                  the execution thread terminated. It receives
                                  the exception raised by `func`, if any, or
                                  None.
        @param polling_freq       (optional) the interval between polling
                                  iterations (in ms).
        """

        # pylint: disable=C0111
        def save_exception(func, args):
            try:
                # pylint: disable=W0142
                func(*args)
            except Exception as e:
                self.__error_output = e
                raise

        def poll_thread(self):
            if progress_callback is not None:
                progress_callback()
            if self.__thread.is_alive():
                return True
            else:
                if finished_callback is not None:
                    finished_callback(self.__error_output)
                return False

        self.__error_output = None
        assert self.__thread is None or not self.__thread.is_alive()
        self.__thread = threading.Thread(target=save_exception, args=(func, args))
        self.__thread.start()
        # XXX: there could be no main loop
        GLib.timeout_add(polling_freq, poll_thread, self)

    def get_message_body(self):
        """Returns the content of the message body

        Aggregate all information to prepare the message body.
        """
        LOG.debug("Creating message body")
        body = "Subject: %s\n" % self.subject
        if self.contact_email:
            body += "From: %s\n" % self.contact_email
        if self.contact_gpgkey:
            # Test whether we have a key block or a key id/url
            if len(self.contact_gpgkey.splitlines()) <= 1:
                body += "OpenPGP-Key: %s\n" % self.contact_gpgkey
            else:
                body += "OpenPGP-Key: included below\n"
        prefill_extra = "" if self.bug_specific_text is None else self.bug_specific_text
        body += (
            f"{self.prepended_data.rstrip()}\n"
            f"{prefill_extra}"
            f"\n{self.message}\n\n"
        )
        if self.contact_gpgkey and len(self.contact_gpgkey.splitlines()) > 1:
            body += "%s\n\n" % self.contact_gpgkey
        body += "%s\n" % self.appended_data
        return body

    def get_mime_message(self):
        """Returns the PGP/MIME message to be sent"""
        LOG.debug("Building mime message")
        mime_message = email.mime.text.MIMEText(self.get_message_body())

        encrypter = whisperBack.encryption.Encryption(keyring=self.gnupg_keyring)

        encrypted_mime_message = encrypter.pgp_mime_encrypt(
            mime_message,
            [self.to_fingerprint],
        )

        encrypted_mime_message["Subject"] = self.mail_subject
        encrypted_mime_message["From"] = self.from_address
        encrypted_mime_message["To"] = self.to_address

        return encrypted_mime_message

    def save(self, path):
        """Save the message into a file

        @param path path of the file to save
        """
        f = open(path, "w")
        try:
            f.write(str(self.get_mime_message()))
        finally:
            f.close()

    def send(self, progress_callback=None, finished_callback=None):
        """Actually sends the message

        @param progress_callback
        @param finished_callback
        """
        LOG.debug("Sending message")
        # XXX: It's really strange that some exceptions from this method are
        #      raised and some other transmitted to finished_callback…

        mime_message = self.get_mime_message().as_string()

        self.execute_threaded(
            func=whisperBack.mail.send_message,
            args=(
                self.from_address,
                self.to_address,
                mime_message,
                self.smtp_host,
                self.smtp_port,
                self.socks_host,
                self.socks_port,
            ),
            progress_callback=progress_callback,
            finished_callback=finished_callback,
        )
