#!/usr/bin/env python3

"""
Recover translations that were lost between two commits.

This script is meant to be used in situations where translations were
mistakenly invalidated, for example because of unintended changes in source
strings.
"""

import git
import polib

import argparse
import logging
import subprocess
import sys
import pathlib


def should_be_recovered(e_old, e_new):
    """
    Decide whether a translation should be recovered or not.

    Return True if the translation is valid in the old entry and invalid (and
    not obsolete) in the new entry.
    """
    if not e_old.translated():
        return False

    if e_new.translated() or e_new.obsolete:
        return False

    return True


def copy(e_old, e_new):
    """
    Copies the content from an old entry to a new entry.
    """
    e_new.msgid = e_old.msgid
    e_new.msgstr = e_old.msgstr
    e_new.occurrences = e_old.occurrences
    e_new.comment = e_old.comment
    e_new.flags = e_old.flags[:]  # clone flags
    e_new.msgid_plural = e_old.msgid_plural
    e_new.obsolete = e_old.obsolete
    if e_old.msgstr_plural:
        for pos in e_old.msgstr_plural:
            try:
                # keep existing translation at pos if any
                e_new.msgstr_plural[pos]
            except KeyError:
                e_new.msgstr_plural[pos] = ""


def parse_args():
    """
    Parse command line arguments.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--width", "-w", type=int, default=80, help="Width to wrap lines"
    )
    parser.add_argument("old_ref", help="commit before the problematic commit")
    parser.add_argument(
        "new_ref",
        default="HEAD",
        help="commit onto you recover. normally you want  to use HEAD here.",
        nargs="?",
    )
    return parser.parse_args()


def recover_lost_translations(args, logger):
    """
    Recover translations that were valid in an old commit and are invalid in a
    new commit.
    """
    repo = git.Repo("")
    old = repo.commit(args.old_ref)
    diff = old.diff(args.new_ref)

    git_base = pathlib.Path(repo.git_dir).parent

    for f in diff:
        if not f.b_path.endswith(".po"):
            continue
        if f.change_type not in ("R", "M"):
            continue

        try:
            pofile_old = polib.pofile(
                f.a_blob.data_stream.read().decode("utf-8"),
                encoding="utf-8",
                wrapwidth=args.width,
            )
        except OSError as e:
            logger.warning(f"{f.a_path}@{args.old_ref}: {e}")
            continue

        try:
            pofile_new = polib.pofile(
                f.b_blob.data_stream.read().decode("utf-8"),
                encoding="utf-8",
                wrapwidth=args.width,
            )
        except OSError as e:
            logger.warning(f"{f.b_path}@{args.new_ref}: {e}")
            continue

        changed_file = False

        for e_new in pofile_new:
            e_old = pofile_old.find(e_new.msgid, by="msgid")
            if not e_old:
                continue

            if should_be_recovered(e_old, e_new):
                changed_file = True
                copy(e_old, e_new)

        if changed_file:
            newpath = f.b_path
            subprocess.run(
                [
                    "msgcat",
                    "--width",
                    str(args.width),
                    "-t",
                    "utf-8",
                    "-o",
                    str(git_base / newpath),
                    "-",
                ],
                input=pofile_new.__unicode__().encode("utf-8"),
                check=True,
            )


if __name__ == "__main__":
    logging.basicConfig()
    logger = logging.getLogger(__name__)
    args = parse_args()
    recover_lost_translations(args, logger)
