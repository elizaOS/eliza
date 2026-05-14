#!/usr/bin/python3
"""
Standalone/module to simplify composing emails.

The purpose of this module is to make it easier to convert machine-ready
emails into actually composing emails.
"""

import os.path
import subprocess
import sys
import tempfile
import time
from argparse import ArgumentDefaultsHelpFormatter, ArgumentParser
from email import policy
from email.parser import Parser
from functools import lru_cache
from pathlib import Path

from xdg.BaseDirectory import xdg_config_home

LONG_HELP = """
## Configuration

To configure automailer, put config files in ~/.config/tails/automailer/*.toml

Supported options are:
 - mailer: must be a string. supported values are
   - "print"
   - "thunderbird"
   - "notmuch"
 - thunderbird_cmd: must be a list of strings. default value is ["thunderbird"].
"""


@lru_cache(maxsize=1)
def read_config() -> dict:
    config_files = sorted((Path(xdg_config_home) / "tails/automailer/").glob("*.toml"))
    if not config_files:
        return {}
    try:
        import toml
    except ImportError:
        print(
            "Warning: could not import `toml`. Your configuration will be ignored",
            file=sys.stderr,
        )
        return {}

    data = {}
    for fpath in config_files:
        with open(fpath) as fp:
            data.update(toml.load(fp))
    return data


def parse(body: str):
    header, body = body.split("\n\n", maxsplit=1)
    msg = Parser(policy=policy.default).parsestr(header)
    return msg, body


def get_attachments(msg) -> list[str]:
    attachments: list[str] = []

    if "x-attach" in msg:
        for attachment_list in msg.get_all("x-attach"):
            for fpath in (f.strip() for f in attachment_list.split(",")):
                if not fpath:
                    continue
                if not os.path.exists(fpath):
                    print(f"Skipping attachemt '{fpath}': not found", file=sys.stderr)
                    continue
                attachments.append(fpath)

    return attachments


def markdown_to_html(body: str) -> str:
    # Having import inside a function is a simple way of having optional dependencies
    import markdown

    return markdown.markdown(body)


def mailer_thunderbird(body: str):
    msg, body = parse(body)
    spec = []
    html = msg.get("Content-Type", "text/plain") == "text/html"
    for key in ["to", "cc", "subject"]:
        if key in msg:
            spec.append(f"{key}='{msg[key]}'")
    attachments = get_attachments(msg)
    if attachments:
        spec.append("attachment='%s'" % ",".join(attachments))

    if html:
        body = markdown_to_html(body)

    thunderbird_cmd = read_config().get("thunderbird_cmd", ["thunderbird"])
    with tempfile.TemporaryDirectory() as tmpdir:
        fpath = Path(tmpdir) / "email.eml"
        with fpath.open("w") as fp:
            fp.write(body)
        spec.append("format=%s" % ("html" if html else "text"))
        spec.append(f"message={fpath}")
        cmdline = [*thunderbird_cmd, "-compose", ",".join(spec)]
        subprocess.check_output(cmdline)  # noqa: S603

        # this is a workaround to the fact that Thunderbird will terminate *before* reading the file
        # we don't really know how long does it take, but let's assume 2s are enough
        time.sleep(2)


def mailer_notmuch(body: str):
    msg, body = parse(body)
    cmdline = ["notmuch-emacs-mua", "--client", "--create-frame"]

    for key in ["to", "cc", "subject"]:
        if key in msg:
            cmdline.append(f"--{key}={msg[key]}")
    attachments = get_attachments(msg)
    if attachments:
        body = (
            "\n".join(
                [
                    f'<#part filename="{attachment}" disposition=attachment><#/part>'
                    for attachment in attachments
                ]
            )
            + "\n\n"
            + body
        )

    with tempfile.TemporaryDirectory() as tmpdir:
        fpath = Path(tmpdir) / "email.eml"
        with fpath.open("w") as fp:
            fp.write(body)
        cmdline.append(f"--body={fpath}")

        subprocess.check_output(cmdline)  # noqa: S603


def mailer(mailer: str, body: str):
    if mailer == "thunderbird":
        return mailer_thunderbird(body)
    if mailer == "notmuch":
        return mailer_notmuch(body)
    if not mailer or mailer == "print":
        print(body)
    else:
        print(f"Unsupported mailer: '{mailer}'")


def add_parser_mailer(parser: ArgumentParser, config: dict):
    mail_options = parser.add_argument_group("mail options")
    mail_options.add_argument(
        "--mailer",
        default=config.get("mailer", "print"),
        choices=["print", "thunderbird", "notmuch"],
        help="Your favorite MUA",
    )


def get_parser():
    config = read_config()
    argparser = ArgumentParser(formatter_class=ArgumentDefaultsHelpFormatter)
    argparser.add_argument("--long-help", action="store_true", default=False)
    add_parser_mailer(argparser, config)
    return argparser


if __name__ == "__main__":
    parser = get_parser()
    args = parser.parse_args()
    if args.long_help:
        print(LONG_HELP)
        sys.exit(0)
    body = sys.stdin.read()
    mailer(args.mailer, body)
