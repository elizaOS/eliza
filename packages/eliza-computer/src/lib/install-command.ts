/**
 * Generates the checksum-bound, resource-limited shell installer shared by
 * the rendered site and the standalone Codex bootstrap. Keeping one generator
 * prevents public installation paths from drifting to weaker archive handling.
 */

export function createInstallCommand(
  origin: string,
  skillsRoot: string,
): string {
  return `(
  set -eu
  SKILLS_ROOT="${skillsRoot}"
  TARGET="$SKILLS_ROOT/contribute-to-eliza"
  if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    printf '%s\\n' "Refusing to overwrite existing skill: $TARGET" >&2
    exit 1
  fi
  INSTALL_TMP="$(mktemp -d)"
  TARGET_CREATED=0
  cleanup() {
    rm -rf "$INSTALL_TMP"
    if [ "$TARGET_CREATED" -eq 1 ]; then rm -rf "$TARGET"; fi
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  ARCHIVE="$INSTALL_TMP/contribute-to-eliza.skill"
  CHECKSUM="$INSTALL_TMP/contribute-to-eliza.skill.sha256"
  STAGE_ROOT="$INSTALL_TMP/stage"
  curl -fsSL --max-filesize 10485760 "${origin}/downloads/contribute-to-eliza.skill" -o "$ARCHIVE"
  curl -fsSL --max-filesize 4096 "${origin}/downloads/contribute-to-eliza.skill.sha256" -o "$CHECKSUM"
  EXPECTED="$(awk 'NF == 2 && $2 == "contribute-to-eliza.skill" { hash=$1; count++ } END { if (count != 1) exit 1; print hash }' "$CHECKSUM")"
  test "\${#EXPECTED}" -eq 64
  case "$EXPECTED" in ""|*[!0-9A-Fa-f]*) exit 1 ;; esac
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$ARCHIVE" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')"
  else
    exit 1
  fi
  test "$ACTUAL" = "$EXPECTED"
  if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\\n' "python3 is required for bounded archive extraction." >&2
    exit 1
  fi
  if ! python3 - "$ARCHIVE" "$STAGE_ROOT" <<'PY'
import binascii
import hashlib
import json
import os
import stat
import struct
import sys
import unicodedata
import zipfile
import zlib
from pathlib import PurePosixPath

archive_path, stage_root = sys.argv[1:]
max_entries = 32
max_entry_bytes = 1_048_576
max_total_bytes = 4_194_304
local_header = struct.Struct("<IHHHHHIIIHH")
local_signature = 0x04034B50
skill_prefix = "contribute-to-eliza/"

def checked_output(output, target, entry_bytes, total_bytes):
    allowed = min(
        max_entry_bytes - entry_bytes,
        max_total_bytes - total_bytes,
    )
    if len(output) > allowed:
        raise ValueError("actual extracted size exceeds limit")
    target.write(output)
    return entry_bytes + len(output), total_bytes + len(output)

with zipfile.ZipFile(archive_path, "r") as archive:
    entries = archive.infolist()
    if not 0 < len(entries) <= max_entries:
        raise ValueError("unsafe archive entry count")
    if archive.comment:
        raise ValueError("archive comments are not supported")

    seen_names = set()
    declared_total = 0
    expected_offset = 0
    data_offsets = {}
    for entry in entries:
        name = entry.orig_filename
        if entry.filename != name or not name:
            raise ValueError("ambiguous archive name")
        if any(ord(character) < 32 or ord(character) == 127 for character in name):
            raise ValueError("control character in archive name")
        if len(name.encode("utf-8")) > 1024 or "\\\\" in name:
            raise ValueError("unsafe archive name")

        is_directory = name.endswith("/")
        logical_name = name[:-1] if is_directory else name
        path = PurePosixPath(logical_name)
        if (
            not logical_name.startswith(skill_prefix)
            or path.is_absolute()
            or path.as_posix() != logical_name
            or any(part in ("", ".", "..") for part in path.parts)
            or any(len(part.encode("utf-8")) > 255 for part in path.parts)
        ):
            raise ValueError("archive path escapes the skill root")

        canonical_name = unicodedata.normalize("NFC", logical_name).casefold()
        if canonical_name in seen_names:
            raise ValueError("duplicate archive path")
        seen_names.add(canonical_name)

        if entry.flag_bits & 0x9:
            raise ValueError("encrypted or streaming archive entry")
        if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError("unsupported archive compression")
        if entry.comment or entry.extra:
            raise ValueError("per-entry comments and extra fields are not supported")

        mode = entry.external_attr >> 16
        if is_directory:
            if entry.file_size != 0 or (mode and not stat.S_ISDIR(mode)):
                raise ValueError("invalid archive directory")
        elif mode and not stat.S_ISREG(mode):
            raise ValueError("non-regular archive entry")

        if entry.file_size > max_entry_bytes:
            raise ValueError("declared entry size exceeds limit")
        declared_total += entry.file_size
        if declared_total > max_total_bytes:
            raise ValueError("declared archive size exceeds limit")

        if entry.header_offset != expected_offset:
            raise ValueError("archive local records are not contiguous")
        with open(archive_path, "rb") as raw_archive:
            raw_archive.seek(entry.header_offset)
            header = raw_archive.read(local_header.size)
            if len(header) != local_header.size:
                raise ValueError("truncated local archive header")
            (
                signature,
                _version,
                local_flags,
                local_compression,
                _modified_time,
                _modified_date,
                local_crc,
                local_compressed_size,
                local_file_size,
                name_length,
                extra_length,
            ) = local_header.unpack(header)
            encoded_name = raw_archive.read(name_length)
            local_extra = raw_archive.read(extra_length)
        if (
            signature != local_signature
            or local_flags != entry.flag_bits
            or local_compression != entry.compress_type
            or local_crc != entry.CRC
            or local_compressed_size != entry.compress_size
            or local_file_size != entry.file_size
            or local_extra
        ):
            raise ValueError("local and central archive metadata disagree")
        encoding = "utf-8" if local_flags & 0x800 else "cp437"
        if encoded_name.decode(encoding) != name:
            raise ValueError("local and central archive names disagree")
        data_offset = entry.header_offset + local_header.size + name_length
        data_end = data_offset + entry.compress_size
        if data_end > archive.start_dir:
            raise ValueError("archive payload overlaps its central directory")
        data_offsets[name] = data_offset
        expected_offset = data_end
    if expected_offset != archive.start_dir:
        raise ValueError("archive contains unaccounted bytes before its index")

    os.mkdir(stage_root, 0o700)
    extracted_total = 0
    with open(archive_path, "rb") as raw_archive:
        for entry in entries:
            name = entry.orig_filename
            destination = os.path.join(
                stage_root,
                *PurePosixPath(name.rstrip("/")).parts,
            )
            if entry.is_dir():
                os.makedirs(destination, mode=0o755, exist_ok=True)
                continue

            os.makedirs(os.path.dirname(destination), mode=0o755, exist_ok=True)
            raw_archive.seek(data_offsets[name])
            compressed_remaining = entry.compress_size
            extracted_entry = 0
            crc = 0
            decompressor = (
                zlib.decompressobj(-zlib.MAX_WBITS)
                if entry.compress_type == zipfile.ZIP_DEFLATED
                else None
            )
            with open(destination, "xb") as target:
                while compressed_remaining:
                    compressed = raw_archive.read(
                        min(65_536, compressed_remaining),
                    )
                    if not compressed:
                        raise ValueError("truncated archive payload")
                    compressed_remaining -= len(compressed)
                    if decompressor is None:
                        output = compressed
                    else:
                        allowed = min(
                            max_entry_bytes - extracted_entry,
                            max_total_bytes - extracted_total,
                        )
                        output = decompressor.decompress(compressed, allowed + 1)
                        if decompressor.unconsumed_tail:
                            raise ValueError("actual extracted size exceeds limit")
                    extracted_entry, extracted_total = checked_output(
                        output,
                        target,
                        extracted_entry,
                        extracted_total,
                    )
                    crc = binascii.crc32(output, crc)
                if decompressor is not None:
                    if (
                        not decompressor.eof
                        or decompressor.unused_data
                        or decompressor.unconsumed_tail
                    ):
                        raise ValueError("invalid deflate stream boundary")
                    output = decompressor.flush()
                    extracted_entry, extracted_total = checked_output(
                        output,
                        target,
                        extracted_entry,
                        extracted_total,
                    )
                    crc = binascii.crc32(output, crc)
            if (
                extracted_entry != entry.file_size
                or crc & 0xFFFFFFFF != entry.CRC
            ):
                raise ValueError("archive size or CRC metadata does not match payload")

provenance_path = os.path.join(
    stage_root,
    "contribute-to-eliza",
    "PROVENANCE.json",
)
skill_path = os.path.join(stage_root, "contribute-to-eliza", "SKILL.md")
with open(provenance_path, "r", encoding="utf-8") as provenance_file:
    provenance = json.load(provenance_file)
if (
    provenance.get("schemaVersion") != "1"
    or provenance.get("name") != "contribute-to-eliza"
    or provenance.get("repository") != "elizaOS/eliza"
):
    raise ValueError("invalid skill provenance identity")
revision_status = provenance.get("revisionStatus")
revision = provenance.get("revision")
if (
    revision_status == "committed"
    and (
        not isinstance(revision, str)
        or len(revision) != 40
        or any(character not in "0123456789abcdef" for character in revision)
    )
) or (revision_status == "working-tree" and revision is not None):
    raise ValueError("invalid skill provenance revision")
if revision_status not in ("committed", "working-tree"):
    raise ValueError("invalid skill provenance revision status")
source = provenance.get("source")
if (
    not isinstance(source, dict)
    or source.get("path") != "packages/skills/skills/contribute-to-eliza/SKILL.md"
):
    raise ValueError("invalid skill provenance source")
with open(skill_path, "rb") as skill_file:
    if source.get("sha256") != hashlib.sha256(skill_file.read()).hexdigest():
        raise ValueError("skill source digest does not match provenance")
manifest = provenance.get("files")
if not isinstance(manifest, list):
    raise ValueError("skill provenance file manifest is missing")
packaged_paths = sorted(
    entry.orig_filename[len(skill_prefix):]
    for entry in entries
    if not entry.is_dir()
    and entry.orig_filename != "contribute-to-eliza/PROVENANCE.json"
)
manifest_paths = []
for record in manifest:
    if (
        not isinstance(record, dict)
        or not isinstance(record.get("path"), str)
        or not isinstance(record.get("sha256"), str)
    ):
        raise ValueError("invalid skill provenance file record")
    manifest_paths.append(record["path"])
if sorted(manifest_paths) != packaged_paths or len(set(manifest_paths)) != len(
    manifest_paths
):
    raise ValueError("skill provenance file manifest is incomplete")
for record in manifest:
    source_file = os.path.join(
        stage_root,
        "contribute-to-eliza",
        *PurePosixPath(record["path"]).parts,
    )
    with open(source_file, "rb") as packaged_file:
        if hashlib.sha256(packaged_file.read()).hexdigest() != record["sha256"]:
            raise ValueError("packaged file digest does not match provenance")
PY
  then
    printf '%s\\n' "Archive failed bounded integrity and path checks." >&2
    exit 1
  fi
  STAGED="$STAGE_ROOT/contribute-to-eliza"
  test -f "$STAGED/SKILL.md"
  test -f "$STAGED/PROVENANCE.json"
  mkdir -p "$SKILLS_ROOT"
  if ! mkdir "$TARGET"; then
    printf '%s\\n' "Unable to reserve a new skill directory: $TARGET" >&2
    exit 1
  fi
  TARGET_CREATED=1
  cp -R "$STAGED/." "$TARGET/"
  test -f "$TARGET/SKILL.md"
  test -f "$TARGET/PROVENANCE.json"
  TARGET_CREATED=0
)`;
}
