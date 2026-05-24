import os
from pathlib import Path
from typing import Union

from tps.configuration.binding import Binding


def check_same_permissions_and_owner_recursively(
    file1: Union[str, Path], file2: Union[str, Path]
):
    file1 = Path(file1)
    file2 = Path(file2)

    if file1.is_file() != file2.is_file():
        raise AssertionError(
            f"Only one of {file1} and {file2} is a"
            f"regular file (or a symlink pointing to "
            f"a regular file)"
        )

    if file1.is_file():
        check_same_permissions_and_owner(file1, file2)
        return

    # The files are directories, so check their contents recursively
    files1 = sorted(Path(file1).iterdir())
    files2 = sorted(Path(file2).iterdir())
    for child1, child2 in zip(files1, files2):
        check_same_permissions_and_owner_recursively(child1, child2)


def check_same_permissions_and_owner(file1: Union[str, Path], file2: Union[str, Path]):
    stat1 = os.stat(file1)
    stat2 = os.stat(file2)
    if stat1.st_mode != stat2.st_mode:
        raise AssertionError(
            f"mode {oct(stat1.st_mode)} of {file1} is "
            f"different than mode {oct(stat2.st_mode)} "
            f"of {file2}"
        )
    if stat1.st_uid != stat2.st_uid:
        raise AssertionError(
            f"owner {stat1.st_uid} of {file1} is "
            f"different than owner {stat2.st_uid} of "
            f"{file2}"
        )

    if stat1.st_gid != stat2.st_gid:
        raise AssertionError(
            f"group {stat1.st_gid} of {file1} is "
            f"different than owner {stat2.st_gid} of "
            f"{file2}"
        )


def get_binding_operand(binding: Binding, operand: str) -> Path:
    if operand == "source":
        return binding.src
    elif operand == "destination":
        return binding.dest
    else:
        raise ValueError(
            "Invalid parameter for parameter 'binding_operand': " "%s" % operand
        )


def get_uid(user: str) -> int:
    """This function allows us to run scenarios which assume that an
    amnesia user exists on non-Tails systems which don't have an
    amnesia user"""
    if user == "root":
        return 0
    elif user == "amnesia":
        return 1000
    else:
        raise ValueError("Invalid value for parameter 'user': %s" % user)
