"""
This module provides functions to aid sending logs to syslog or stderr sensibly
"""

import sys
import logging
import logging.handlers
from logging import Handler


def get_syslog_handler(ident=None) -> Handler:
    handler = logging.handlers.SysLogHandler(address="/run/systemd/journal/dev-log")
    if ident is None:
        try:
            import prctl
        except ImportError:
            pass
        else:
            handler.ident = "%s: " % prctl.get_name()
    else:
        handler.ident = "%s: " % ident
    return handler


def get_stderr_handler() -> Handler:
    return logging.StreamHandler()


def get_best_handler_hint() -> str:
    if sys.stderr is None:  # close
        return "syslog"
    elif not sys.stderr.isatty():
        return "syslog"
    return "stderr"


def get_handler_by_hint(hint: str, ident=None) -> Handler:
    if hint == "auto":
        hint = get_best_handler_hint()
    if hint == "syslog":
        return get_syslog_handler(ident)
    elif hint == "stderr":
        return get_stderr_handler()
    else:
        raise ValueError("unsupported hint %s" % (hint))


def configure_logging(hint="auto", ident=None, **kwargs):
    handler = get_handler_by_hint(hint, ident=None)
    logging.basicConfig(handlers=[handler], **kwargs)


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--hint", default="auto", choices=["auto", "stderr", "syslog"])
    p.add_argument("message")
    args = p.parse_args()
    print(get_best_handler_hint())
    configure_logging(hint=args.hint)
    logging.warning(args.message)
