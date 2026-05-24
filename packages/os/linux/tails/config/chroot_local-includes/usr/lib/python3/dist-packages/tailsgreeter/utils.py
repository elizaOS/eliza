import contextlib
import json
import subprocess

import gi
from gi.repository import GLib

from tailsgreeter.settings import SettingNotFoundError
from tailslib.persistence import is_tails_media_writable


# GLib has idle_add_once(), but it is not exposed, so here we
# implement it ourselves.
def glib_idle_add_once(function: callable, *args, **kwargs):
    def wrapper(*_args, **_kwargs):
        function(*_args, **_kwargs)
        # Ensure this is called only once when passed to
        # GLib.idle_add().
        return False

    return GLib.idle_add(wrapper, *args, **kwargs)


def get_cleartext_storage(key: str):
    if not is_tails_media_writable():
        return {}

    cmd = ["/usr/bin/sudo", "-n", "/usr/local/bin/tails-cleartext-storage", "load", key]
    print(f"Running {cmd}")
    try:
        content = subprocess.check_output(cmd, text=True)
        return json.loads(content)
    except subprocess.CalledProcessError as exc:
        raise SettingNotFoundError("No persistent setting found") from exc


def set_cleartext_storage(key: str, value):
    if not is_tails_media_writable():
        return
    cmd = ["/usr/bin/sudo", "-n", "/usr/local/bin/tails-cleartext-storage", "save", key]
    print(f"Running {cmd}")
    content = json.dumps(value).encode("utf8")
    subprocess.run(cmd, input=content, check=True)


def unset_cleartext_storage(key: str):
    if not is_tails_media_writable():
        return
    cmd = [
        "/usr/bin/sudo",
        "-n",
        "/usr/local/bin/tails-cleartext-storage",
        "delete",
        key,
    ]
    print(f"Running {cmd}")
    subprocess.run(cmd, check=True)
