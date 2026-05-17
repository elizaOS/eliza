import logging
import os
import shlex
from typing import Dict, Union


def write_settings(filename: str, settings: Dict[str, Union[str, bool]]):
    with open(filename, "w") as f:
        os.chmod(filename, 0o600)
        for key, value in settings.items():
            if type(value) is bool:
                value = str(value).lower()
            # shell-escape the value, but only if it's non-empty, because
            # for an empty string the result will be "''", which is non-empty
            value = shlex.quote(value) if value else ""
            f.write("%s=%s\n" % (key, value))


def read_settings(filename: str) -> Dict[str, str]:
    with open(filename) as f:
        lines = f.readlines()

    settings = dict()
    for line in lines:
        try:
            key, value = line.split("=", 1)
        except ValueError as e:
            logging.warning(
                'Error parsing settings file "%s", line "%s": %s', filename, line, e
            )
            continue
        settings[key] = value.rstrip()
    return settings
