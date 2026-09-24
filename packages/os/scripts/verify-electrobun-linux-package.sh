#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <electrobun-linux-installer.tar.gz>" >&2
  exit 2
fi

payload="$1"
if [ ! -f "$payload" ] || [ -L "$payload" ] || [ ! -s "$payload" ]; then
  echo "Electrobun Linux package must be a nonempty regular file: $payload" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
temporary_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
stage="$(mktemp -d "${temporary_root%/}/elizaos-electrobun-package.XXXXXX")"
cleanup() {
  node "$repo_root/scripts/rm-path-recursive.ts" "$stage"
}
trap cleanup EXIT

python3 - "$payload" "$stage" <<'PY'
import pathlib
import sys
import tarfile

payload = pathlib.Path(sys.argv[1])
stage = pathlib.Path(sys.argv[2])
expected = {"installer", "README.txt"}

with tarfile.open(payload, mode="r:gz") as archive:
    files = set()
    validated = {}
    for member in archive.getmembers():
        normalized = member.name
        while normalized.startswith("./"):
            normalized = normalized[2:]
        if normalized in {"", "."} and member.isdir():
            continue
        candidate = pathlib.PurePosixPath(normalized)
        if candidate.is_absolute() or ".." in candidate.parts:
            raise SystemExit(f"unsafe archive member: {member.name}")
        if normalized not in expected:
            raise SystemExit(f"unexpected archive member: {member.name}")
        if not member.isfile():
            raise SystemExit(f"archive member is not a regular file: {member.name}")
        if normalized in files:
            raise SystemExit(f"duplicate archive member: {member.name}")
        files.add(normalized)
        validated[normalized] = member
        if normalized == "installer" and member.mode & 0o111 == 0:
            raise SystemExit("installer is not executable")
    if files != expected:
        missing = ", ".join(sorted(expected - files))
        raise SystemExit(f"archive is missing required members: {missing}")
    for name, member in validated.items():
        source = archive.extractfile(member)
        if source is None:
            raise SystemExit(f"could not read archive member: {member.name}")
        destination = stage / name
        with source, destination.open("wb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
        destination.chmod(member.mode & 0o777)
PY

test -f "$stage/installer" && test ! -L "$stage/installer" && test -x "$stage/installer"
test -f "$stage/README.txt" && test ! -L "$stage/README.txt" && test -s "$stage/README.txt"
grep --binary-files=text --fixed-strings --quiet ELECTROBUN_METADATA_V1 "$stage/installer"
grep --binary-files=text --fixed-strings --quiet ELECTROBUN_ARCHIVE_V1 "$stage/installer"

echo "Verified Electrobun Linux package: $payload"
