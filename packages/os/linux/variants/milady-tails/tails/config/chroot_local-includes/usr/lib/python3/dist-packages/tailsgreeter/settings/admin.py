import os
import os.path
import logging
import subprocess

import tailsgreeter.config
from tailsgreeter.settings import SettingNotFoundError
from tailsgreeter.settings.utils import read_settings, write_settings


class AdminSetting(object):
    """Setting controlling the sudo password"""

    settings_file = tailsgreeter.config.admin_password_path

    def save(self, password: str):
        proc = subprocess.run(
            # mkpasswd generates a salt if none is provided (even though the
            # man page doesn't explicitly state this).
            ["mkpasswd", "--stdin", "--method=sha512crypt"],
            input=password.encode(),
            capture_output=True,
            check=True,
        )
        hashed_and_salted_pw = proc.stdout.decode().strip()

        write_settings(
            self.settings_file,
            {
                "TAILS_USER_PASSWORD": hashed_and_salted_pw,
                "TAILS_PASSWORD_HASH_FUNCTION": "SHA512",
            },
        )
        logging.debug("password written to %s", self.settings_file)

    def delete(self):
        # Try to remove the password file
        try:
            os.unlink(self.settings_file)
            logging.debug("removed %s", self.settings_file)
        except OSError:
            # It's bad if the file exists and couldn't be removed, so we
            # we raise the exception in that case
            if os.path.exists(self.settings_file):
                raise

    def load(self):
        """Read and return the *hashed* password from the settings file"""
        try:
            settings = read_settings(self.settings_file)
        except FileNotFoundError:
            raise SettingNotFoundError(
                "No persistent admin settings file found (path: %s)"
                % self.settings_file
            )

        hashed_and_salted_pw = settings.get("TAILS_USER_PASSWORD")
        if hashed_and_salted_pw is None:
            raise SettingNotFoundError(
                "No admin password setting found in settings file (path: %s)"
                % self.settings_file
            )

        return hashed_and_salted_pw
