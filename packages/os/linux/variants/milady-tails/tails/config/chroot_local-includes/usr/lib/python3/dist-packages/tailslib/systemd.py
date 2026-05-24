import os.path
from logging import getLogger

import sh

log = getLogger(os.path.basename(__file__))


def tor_has_bootstrapped() -> bool:
    try:
        sh.systemctl("is-active", "tails-tor-has-bootstrapped.target")
        return True
    except sh.ErrorReturnCode:
        return False
