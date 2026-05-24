from gi.repository import Gio
from typing import Optional

import psutil

import tps.logging

logger = tps.logging.get_logger(__name__)

# A list of all applications currently registered on the system
# noinspection PyArgumentList
all_apps = Gio.AppInfo.get_all()  # type: List[Gio.AppInfo]


class ConflictingApp:
    """An app that must not be running while the feature this app
    belongs to is activated or deactivated.

    Args:
        name (str): The name of the app. This will be used if no
          translated app name can be found via a desktop ID.

        desktop_id (str): Optional; A desktop file ID belonging to the app.

        process_names (List[str]): Optional; A list of process names
          belonging to the app. The default implementation of
          process_belongs_to_app considers a process to belong to the
          app if its name matches any of these names. For more complex
          checks, a subclass should be used which overrides
          process_belongs_to_app.
    """

    def __init__(
        self,
        name: str,
        desktop_id: Optional[str] = None,
        process_names: Optional[list[str]] = None,
    ):
        self.name = name
        self.desktop_id = desktop_id
        self.process_names = process_names if process_names else []

    def process_belongs_to_app(self, process: psutil.Process) -> bool:
        try:
            return process.name() in self.process_names
        except psutil.NoSuchProcess:
            return False

    def get_processes(self) -> list[psutil.Process]:
        return [p for p in psutil.process_iter() if self.process_belongs_to_app(p)]

    def try_get_translated_name(self):
        """Returns a translated name for the app if one can be found
        for the app's desktop ID (if any), else returns the
        untranslated name."""
        if not self.desktop_id:
            return self.name

        # Try to get the translated app name for the desktop ID
        names = [app.get_name() for app in all_apps if app.get_id() == self.desktop_id]
        if not names:
            return self.name

        translated_name = names[0]
        if not translated_name:
            logger.warning(f"Couldn't find app for id {self.desktop_id}")
            return self.name

        return translated_name
