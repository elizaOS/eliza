"""Verifies that PyPI release archives carry the repository's exact MIT license.

The check reads wheel and sdist containers directly so CI proves the published
bytes, not merely the source-tree configuration that was intended to add them.
"""

from __future__ import annotations

import sys
import tarfile
import zipfile
from collections.abc import Sequence
from pathlib import Path


def _only(paths: list[Path] | list[str], label: str) -> Path | str:
    if len(paths) != 1:
        raise ValueError(f"expected exactly one {label}, found {len(paths)}")
    return paths[0]


def _assert_metadata(metadata: bytes, artifact: str) -> None:
    fields = metadata.decode("utf-8").splitlines()
    if "License-Expression: MIT" not in fields:
        raise ValueError(f"{artifact} does not declare License-Expression: MIT")
    if "License-File: LICENSE" not in fields:
        raise ValueError(f"{artifact} does not declare License-File: LICENSE")


def verify_artifacts(directory: Path) -> None:
    package_root = Path(__file__).resolve().parent
    repository_license = package_root.parents[3] / "LICENSE"
    expected_license = repository_license.read_bytes()
    if (package_root / "LICENSE").read_bytes() != expected_license:
        raise ValueError("PyPI LICENSE differs from the repository LICENSE")

    wheel = _only(sorted(directory.glob("*.whl")), "wheel")
    if not isinstance(wheel, Path):
        raise TypeError("wheel path was not resolved")
    with zipfile.ZipFile(wheel) as archive:
        license_name = _only(
            [
                name
                for name in archive.namelist()
                if name.endswith(".dist-info/licenses/LICENSE")
            ],
            "wheel license",
        )
        metadata_name = _only(
            [
                name
                for name in archive.namelist()
                if name.endswith(".dist-info/METADATA")
            ],
            "wheel metadata",
        )
        if not isinstance(license_name, str) or not isinstance(metadata_name, str):
            raise TypeError("wheel member names were not resolved")
        if archive.read(license_name) != expected_license:
            raise ValueError("wheel license differs from the repository LICENSE")
        _assert_metadata(archive.read(metadata_name), wheel.name)

    sdist = _only(sorted(directory.glob("*.tar.gz")), "source distribution")
    if not isinstance(sdist, Path):
        raise TypeError("source distribution path was not resolved")
    with tarfile.open(sdist, mode="r:gz") as archive:
        members = archive.getmembers()
        license_member = _only(
            [
                member.name
                for member in members
                if member.isfile()
                and len(Path(member.name).parts) == 2
                and Path(member.name).name == "LICENSE"
            ],
            "source-distribution license",
        )
        metadata_member = _only(
            [
                member.name
                for member in members
                if member.isfile()
                and len(Path(member.name).parts) == 2
                and Path(member.name).name == "PKG-INFO"
            ],
            "source-distribution metadata",
        )
        if not isinstance(license_member, str) or not isinstance(metadata_member, str):
            raise TypeError("source-distribution member names were not resolved")
        license_file = archive.extractfile(license_member)
        metadata_file = archive.extractfile(metadata_member)
        if license_file is None or license_file.read() != expected_license:
            raise ValueError(
                "source-distribution license differs from repository LICENSE"
            )
        if metadata_file is None:
            raise ValueError("source-distribution metadata is unreadable")
        _assert_metadata(metadata_file.read(), sdist.name)


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        raise ValueError("usage: python verify_artifacts.py <artifact-directory>")
    directory = Path(args[0]).resolve()
    if not directory.is_dir():
        raise ValueError(f"artifact directory does not exist: {directory}")
    verify_artifacts(directory)
    print(f"Verified wheel and sdist licensing in {directory}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
