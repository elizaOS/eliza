#!/usr/bin/python3 -I

import subprocess
from pathlib import Path

import tailslib.shell

basedir = Path("/var/lib/live/config/")
variable_to_file = {
    "TAILS_NETWORK": "tails.network",
    "TAILS_MACSPOOF_ENABLED": "tails.macspoof",
    "TAILS_UNSAFE_BROWSER_ENABLED": "tails.unsafe-browser",
}


def _greeter_sh_wrapper(fname: str, variable: str) -> str:
    fpath = basedir / fname
    if not fpath.exists():
        raise ValueError("fname is not a valid filename")
    shcmd = f". '{fpath}' && echo ${variable}"
    output = subprocess.check_output(["/bin/sh", "-c", shcmd], env={})
    return output.decode("ascii")


def get_greeter_variable(variable: str) -> str:
    fname = variable_to_file[variable]
    return _greeter_sh_wrapper(fname, variable)


def get_greeter_variable_bool(variable: str) -> bool:
    v = get_greeter_variable(variable)
    return tailslib.shell.shell_value_to_bool(v)
