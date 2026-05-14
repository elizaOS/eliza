import os
import os.path
import logging
from pathlib import Path

import tailsgreeter.config
from tailsgreeter.settings import SettingNotFoundError
from tailsgreeter.settings.utils import read_settings, write_settings


class PersistentStorageCreateSetting(object):
    """Setting controlling whether the user should be proposed to create a persistent storage after login"""

    settings_file = tailsgreeter.config.persistence_create_file

    def save(self, create: bool):
        p = Path(self.__class__.settings_file)
        p.touch()
        write_settings(
            self.settings_file,
            {
                "CREATE_PERSISTENT_STORAGE": create,
            },
        )
        logging.debug("setting written to %s", self.settings_file)

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
        """Read and return the value from the settings file"""
        try:
            settings = read_settings(self.settings_file)
        except FileNotFoundError:
            # this is ok: we don't expect this value to be persisted
            return False

        create = settings.get("CREATE_PERSISTENT_STORAGE")
        if create is None:
            return False

        return False if create == "false" else True

    def toggle(self):
        """Convenience method to move logic out of UI"""
        create = self.load()
        new_value = not create
        self.save(new_value)
        return new_value
