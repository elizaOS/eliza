import sys
from functools import lru_cache
import os
from pathlib import Path
import pwd
from collections.abc import Mapping

from tailslib import LIVE_USER_UID

ENV_VARS_TO_DUMP = [
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "LANG",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_CURRENT_DESKTOP",
]

ALLOWED_ENV_VARS = [
    *ENV_VARS_TO_DUMP,
    "DEBUG",
    "DESKTOP_STARTUP_ID",
    "NOTIFY_SOCKET",
    "FLATPAK_FANCY_OUTPUT",
]

USER_ENV_FILE_TEMPLATE = "/run/user/{uid}/user-env"


def user_env_file(uid):
    return USER_ENV_FILE_TEMPLATE.format(uid=uid)


def allowed_env(env: Mapping) -> dict:
    """
    >>> allowed_env({"PATH": "/home/", "LANG": "en"})
    {'LANG': 'en'}
    """
    return {key: value for key, value in env.items() if key in ALLOWED_ENV_VARS}


def read_allowed_env_from_file(envfile: str, allow_root=False) -> dict:
    """Read the environment variables from the file at envfile and return
    a dictionary of the ones that are allowed to be set.

    The file is expected to contain a list of environment variables in
    the format "KEY=VALUE" separated by null bytes.

    IMPORTANT: Only use allow_root in tests.
    If allow_root is True, the function can be called as root, otherwise
    it must be called as amnesia. This is to make it harder to
    accidentally introduce a privilege escalation vulnerability which
    allows to read arbitrary files, because the envfile is writable by
    amnesia and can be symlinked to any file on the system."""

    uid = os.getuid()
    if uid != LIVE_USER_UID and not (allow_root and uid == 0):
        raise RuntimeError(
            f"This function must be called as amnesia (UID 1000) not UID {uid}"
        )

    env = dict()

    for line in Path(envfile).read_text().split("\0"):
        if not line:
            continue

        try:
            key, value = line.split("=", 1)
        except Exception as e:
            print(f"Invalid environment variable: '{line}'", file=sys.stderr)
            raise e

        env[key] = value

    return allowed_env(env)


@lru_cache(maxsize=1)
def read_user_env(user=None, allow_root=False) -> dict:
    """Read the environment variables from the user env file of the
    specified user and return a dictionary of the ones that are allowed
    to be set.

    IMPORTANT: Only use this function in tests to avoid a privilege
    escalation vulnerability. See the docstring of
    read_allowed_env_from_file for details."""

    if user is None:
        uid = os.geteuid()
    else:
        uid = pwd.getpwnam(user).pw_uid

    return read_allowed_env_from_file(user_env_file(uid), allow_root=allow_root)
