/**
 * Generates the independently authenticated, resource-limited skill installer.
 * GitHub authorizes immutable source bytes while the site checksum detects
 * transport corruption; versioned local directories make activation atomic.
 * Entry receipts preserve transition history but never replace live rollback
 * authorization for the retained revision about to become active.
 */

interface TestAuthorityOrigins {
  apiOrigin: string;
  rawOrigin: string;
}

interface InstallCommandOptions {
  testAuthority?: TestAuthorityOrigins;
}

const PRODUCTION_API_ORIGIN = "https://api.github.com";
const PRODUCTION_RAW_ORIGIN = "https://raw.githubusercontent.com";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateArtifactOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (!["https:", "http:", "file:"].includes(parsed.protocol)) {
    throw new TypeError(
      `[ElizaComputer] unsupported artifact origin: ${origin}`,
    );
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError(
      "[ElizaComputer] artifact origin cannot contain query or fragment data",
    );
  }
  return origin.replace(/\/$/u, "");
}

function resolveAuthorityOrigins(
  options: InstallCommandOptions,
): TestAuthorityOrigins {
  if (!options.testAuthority) {
    return {
      apiOrigin: PRODUCTION_API_ORIGIN,
      rawOrigin: PRODUCTION_RAW_ORIGIN,
    };
  }
  for (const [name, origin] of Object.entries(options.testAuthority)) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "file:" || parsed.search || parsed.hash) {
      throw new TypeError(
        `[ElizaComputer] test ${name} must be an unparameterized file:// origin`,
      );
    }
  }
  return {
    apiOrigin: options.testAuthority.apiOrigin.replace(/\/$/u, ""),
    rawOrigin: options.testAuthority.rawOrigin.replace(/\/$/u, ""),
  };
}

export function createInstallCommand(
  origin: string,
  skillsRoot: string,
  options: InstallCommandOptions = {},
): string {
  const artifactOrigin = validateArtifactOrigin(origin);
  const authority = resolveAuthorityOrigins(options);

  return `(
  set -eu
  SKILLS_ROOT="${skillsRoot}"
  OPERATION="\${ELIZA_ARMY_SKILL_OPERATION:-install}"
  ROLLBACK_REVISION="\${ELIZA_ARMY_SKILL_REVISION:-}"
  if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\\n' "python3 is required for authenticated skill installation." >&2
    exit 1
  fi
  trap 'exit 1' HUP INT TERM
  python3 - ${shellQuote(artifactOrigin)} ${shellQuote(authority.apiOrigin)} ${shellQuote(authority.rawOrigin)} "$SKILLS_ROOT" "$OPERATION" "$ROLLBACK_REVISION" <<'PY'
import binascii
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import stat
import struct
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from pathlib import PurePosixPath

artifact_origin, api_origin, raw_origin, skills_root, operation, rollback_revision = sys.argv[1:]
repository = "elizaOS/eliza"
skill_name = "contribute-to-eliza"
skill_repository_path = "packages/skills/skills/contribute-to-eliza"
source_path = f"{skill_repository_path}/SKILL.md"
release_label = "eliza-army-release-candidate"
target_path = os.path.join(skills_root, skill_name)
versions_name = f".{skill_name}-versions"
versions_root = os.path.join(skills_root, versions_name)
lock_path = os.path.join(skills_root, f".{skill_name}.lock")
provenance_name = "PROVENANCE.json"
authorization_receipt_name = ".eliza-army-authorization.json"
skill_prefix = f"{skill_name}/"
max_archive_bytes = 10_485_760
max_archive_entries = 33
max_source_files = 32
max_source_directories = 32
max_entry_bytes = 1_048_576
max_total_bytes = 4_194_304
max_api_bytes = 2_097_152
max_pull_pages = 10
max_timeline_pages = 10
request_timeout_seconds = 20
sha_pattern = re.compile(r"[0-9a-f]{40}")
digest_pattern = re.compile(r"[0-9a-f]{64}")
local_header = struct.Struct("<IHHHHHIIIHH")
local_signature = 0x04034B50
api_fixture = None


def require_sha(value, context):
    if not isinstance(value, str) or not sha_pattern.fullmatch(value):
        raise ValueError(f"{context} is not a full lowercase commit SHA")
    return value


def canonical_relative_path(value, context):
    if not isinstance(value, str) or not value:
        raise ValueError(f"{context} is not a path")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError(f"{context} contains a control character")
    if len(value.encode("utf-8")) > 1024 or "\\\\" in value:
        raise ValueError(f"{context} is unsafe")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or path.as_posix() != value
        or any(part in ("", ".", "..") for part in path.parts)
        or any(len(part.encode("utf-8")) > 255 for part in path.parts)
        or unicodedata.normalize("NFC", value) != value
    ):
        raise ValueError(f"{context} is not canonical")
    return value


def origin_identity(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme == "file":
        return (parsed.scheme, os.path.realpath(urllib.request.url2pathname(parsed.path)))
    return (parsed.scheme, parsed.hostname, parsed.port)


def fetch_bytes(url, limit, expected_origin):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "eliza-army-skill-installer/1",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=request_timeout_seconds) as response:
            final_url = response.geturl()
            expected = urllib.parse.urlsplit(expected_origin)
            final = urllib.parse.urlsplit(final_url)
            if expected.scheme == "file":
                expected_root = os.path.realpath(urllib.request.url2pathname(expected.path))
                final_path = os.path.realpath(urllib.request.url2pathname(final.path))
                if os.path.commonpath((expected_root, final_path)) != expected_root:
                    raise ValueError("file authority escaped its injected fixture root")
            elif origin_identity(final_url) != origin_identity(expected_origin):
                raise ValueError("authenticated request redirected to another authority")
            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                try:
                    declared_length = int(content_length)
                except ValueError as error:
                    raise ValueError("remote response has an invalid Content-Length") from error
                if declared_length < 0 or declared_length > limit:
                    raise ValueError("remote response exceeds its declared size limit")
            contents = response.read(limit + 1)
    except (OSError, urllib.error.URLError) as error:
        raise ValueError(f"authenticated download failed: {url}") from error
    if len(contents) > limit:
        raise ValueError("remote response exceeds its actual size limit")
    return contents


def decode_json(contents, context):
    try:
        return json.loads(contents.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{context} is not valid UTF-8 JSON") from error


def api_json(path, query=()):
    global api_fixture
    query_string = urllib.parse.urlencode(query)
    key = path if not query_string else f"{path}?{query_string}"
    parsed_origin = urllib.parse.urlsplit(api_origin)
    if parsed_origin.scheme == "file":
        if api_fixture is None:
            fixture_url = f"{api_origin}/responses.json"
            api_fixture = decode_json(
                fetch_bytes(fixture_url, max_api_bytes, api_origin),
                "injected GitHub API fixture",
            )
            if not isinstance(api_fixture, dict):
                raise ValueError("injected GitHub API fixture must be an object")
        if key not in api_fixture:
            raise ValueError(f"injected GitHub API fixture omitted {key}")
        return api_fixture[key]
    url = f"{api_origin}{path}"
    if query_string:
        url = f"{url}?{query_string}"
    return decode_json(fetch_bytes(url, max_api_bytes, api_origin), f"GitHub API response for {path}")


def pull_records(revision):
    records = []
    for page in range(1, max_pull_pages + 1):
        response = api_json(
            f"/repos/{repository}/commits/{revision}/pulls",
            (("page", str(page)), ("per_page", "100")),
        )
        if not isinstance(response, list):
            raise ValueError("GitHub associated-pulls response must be an array")
        if len(response) > 100:
            raise ValueError("GitHub associated-pulls page exceeds its bound")
        records.extend(response)
        if len(response) < 100:
            return records
    raise ValueError("GitHub associated-pulls pagination exceeded its bound")


def pull_timeline(number):
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        raise ValueError("candidate pull request number is invalid")
    records = []
    for page in range(1, max_timeline_pages + 1):
        response = api_json(
            f"/repos/{repository}/issues/{number}/timeline",
            (("page", str(page)), ("per_page", "100")),
        )
        if not isinstance(response, list) or len(response) > 100:
            raise ValueError("GitHub pull-request timeline page is invalid or unbounded")
        records.extend(response)
        if len(response) < 100:
            return records
    raise ValueError("GitHub pull-request timeline pagination exceeded its bound")


def candidate_approval_is_fresh(number, revision):
    revision_event = None
    last_head_change = None
    last_release_label = None
    for index, event in enumerate(pull_timeline(number)):
        if not isinstance(event, dict):
            raise ValueError("GitHub pull-request timeline entry must be an object")
        kind = event.get("event")
        if kind == "committed":
            event_revision = event.get("sha")
            if not isinstance(event_revision, str) or not sha_pattern.fullmatch(event_revision):
                raise ValueError("GitHub committed timeline event omitted its revision")
            last_head_change = index
            if event_revision == revision:
                revision_event = index
        elif kind in ("head_ref_force_pushed", "head_ref_restored"):
            last_head_change = index
        elif kind in ("labeled", "unlabeled"):
            label = event.get("label")
            if isinstance(label, dict) and label.get("name") == release_label:
                last_release_label = (kind, index)
    return (
        revision_event is not None
        and last_head_change is not None
        and last_release_label is not None
        and last_release_label[0] == "labeled"
        and last_release_label[1] > last_head_change
        and last_release_label[1] > revision_event
    )


def pull_matches_repository_contract(pull, revision, *, require_open, require_label=True):
    if not isinstance(pull, dict):
        return False
    head = pull.get("head")
    base = pull.get("base")
    labels = pull.get("labels")
    if not isinstance(head, dict) or not isinstance(base, dict) or not isinstance(labels, list):
        return False
    head_repository = head.get("repo")
    base_repository = base.get("repo")
    if not isinstance(head_repository, dict) or not isinstance(base_repository, dict):
        return False
    label_names = {
        label.get("name")
        for label in labels
        if isinstance(label, dict) and isinstance(label.get("name"), str)
    }
    expected_state = pull.get("state") == "open" if require_open else pull.get("state") == "closed"
    return (
        expected_state
        and pull.get("draft") is False
        and head.get("sha") == revision
        and head_repository.get("full_name") == repository
        and base.get("ref") == "develop"
        and base_repository.get("full_name") == repository
        and (not require_label or release_label in label_names)
    )


def develop_head():
    response = api_json(f"/repos/{repository}/git/ref/heads/develop")
    if not isinstance(response, dict) or response.get("ref") != "refs/heads/develop":
        raise ValueError("GitHub develop ref response has the wrong identity")
    target = response.get("object")
    if not isinstance(target, dict) or target.get("type") != "commit":
        raise ValueError("GitHub develop ref does not resolve to a commit")
    return require_sha(target.get("sha"), "GitHub develop head")


def authorize_revision(revision, canonical_files):
    current_develop = develop_head()
    if revision == current_develop:
        return {"kind": "develop", "develop": current_develop}
    matching = [
        pull
        for pull in pull_records(revision)
        if pull_matches_repository_contract(pull, revision, require_open=True)
    ]
    if matching:
        numbers = sorted(
            pull.get("number")
            for pull in matching
            if isinstance(pull.get("number"), int) and pull.get("number") > 0
        )
        if not numbers:
            raise ValueError("authorized release candidate omitted its pull request number")
        approved = [
            number
            for number in numbers
            if candidate_approval_is_fresh(number, revision)
        ]
        if not approved:
            raise ValueError("release-candidate approval is not bound to the current pull-request head")
        if not compare_is_ancestor(current_develop, revision):
            raise ValueError("release candidate is behind or divergent from current develop")
        return {"kind": "candidate", "develop": current_develop, "pull": approved[0]}
    if compare_is_ancestor(revision, current_develop):
        current_files = remote_skill_bytes(current_develop)
        if current_files != canonical_files:
            raise ValueError(
                "deployed skill revision is stale because canonical skill bytes changed on develop"
            )
        return {"kind": "develop", "develop": current_develop}
    raise ValueError(
        "archive revision is neither the current canonical develop skill nor an open labeled same-repository release candidate"
    )


def git_blob_digest(contents):
    header = f"blob {len(contents)}\\0".encode("ascii")
    return hashlib.sha1(header + contents).hexdigest()


def list_remote_skill_files(revision):
    require_sha(revision, "source revision")
    files = {}
    seen_logical_paths = set()
    pending = [skill_repository_path]
    seen_directories = {skill_repository_path}
    while pending:
        directory = pending.pop()
        response = api_json(
            f"/repos/{repository}/contents/{urllib.parse.quote(directory, safe='/')}",
            (("ref", revision),),
        )
        if not isinstance(response, list) or len(response) > 1000:
            raise ValueError("GitHub Contents directory response is invalid or unbounded")
        for entry in response:
            if not isinstance(entry, dict):
                raise ValueError("GitHub Contents entry must be an object")
            name = canonical_relative_path(entry.get("name"), "GitHub Contents entry name")
            if "/" in name:
                raise ValueError("GitHub Contents entry name contains a path separator")
            expected_path = f"{directory}/{name}"
            if entry.get("path") != expected_path:
                raise ValueError("GitHub Contents entry escaped its requested directory")
            logical_path = expected_path[len(skill_repository_path) + 1 :]
            canonical_relative_path(logical_path, "canonical skill path")
            collision_key = unicodedata.normalize("NFC", logical_path).casefold()
            if collision_key in seen_logical_paths:
                raise ValueError("GitHub Contents returned duplicate or colliding paths")
            seen_logical_paths.add(collision_key)
            entry_type = entry.get("type")
            if entry_type == "dir":
                if len(seen_directories) >= max_source_directories:
                    raise ValueError("canonical skill directory count exceeds its bound")
                seen_directories.add(expected_path)
                pending.append(expected_path)
                continue
            if (
                entry_type != "file"
                or entry.get("submodule_git_url") is not None
                or not isinstance(entry.get("size"), int)
                or isinstance(entry.get("size"), bool)
                or entry.get("size") < 0
                or entry.get("size") > max_entry_bytes
            ):
                raise ValueError("canonical skill contains a non-regular or oversized entry")
            if len(files) >= max_source_files:
                raise ValueError("canonical skill file count exceeds its bound")
            files[logical_path] = entry
    if not files or "SKILL.md" not in files or provenance_name in files:
        raise ValueError("canonical skill file list has an invalid identity")
    return dict(sorted(files.items()))


def remote_skill_bytes(revision):
    entries = list_remote_skill_files(revision)
    result = {}
    total = 0
    for path, entry in entries.items():
        raw_url = (
            f"{raw_origin}/{repository}/{revision}/"
            f"{urllib.parse.quote(f'{skill_repository_path}/{path}', safe='/')}"
        )
        contents = fetch_bytes(raw_url, max_entry_bytes, raw_origin)
        if len(contents) != entry["size"]:
            raise ValueError("raw GitHub file size disagrees with the Contents API")
        blob_sha = entry.get("sha")
        if not isinstance(blob_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", blob_sha):
            raise ValueError("GitHub Contents file omitted its blob identity")
        if git_blob_digest(contents) != blob_sha:
            raise ValueError("raw GitHub bytes disagree with the Contents API blob identity")
        total += len(contents)
        if total > max_total_bytes:
            raise ValueError("canonical skill bytes exceed their aggregate bound")
        result[path] = contents
    return result


def validate_provenance(provenance, revision, canonical_files):
    if not isinstance(provenance, dict) or set(provenance) != {
        "schemaVersion", "name", "repository", "revision", "revisionStatus", "source", "files"
    }:
        raise ValueError("skill provenance has an invalid schema")
    if (
        provenance.get("schemaVersion") != "1"
        or provenance.get("name") != skill_name
        or provenance.get("repository") != repository
        or provenance.get("revisionStatus") != "committed"
        or provenance.get("revision") != revision
    ):
        raise ValueError("skill provenance is not an exact committed repository revision")
    source = provenance.get("source")
    if not isinstance(source, dict) or set(source) != {"path", "sha256"}:
        raise ValueError("skill provenance source has an invalid schema")
    if source.get("path") != source_path:
        raise ValueError("skill provenance source path has the wrong identity")
    records = provenance.get("files")
    if not isinstance(records, list) or not 0 < len(records) <= max_source_files:
        raise ValueError("skill provenance file manifest is missing or unbounded")
    manifest = {}
    for record in records:
        if not isinstance(record, dict) or set(record) != {"path", "sha256"}:
            raise ValueError("skill provenance file record has an invalid schema")
        path = canonical_relative_path(record.get("path"), "skill provenance path")
        digest = record.get("sha256")
        if not isinstance(digest, str) or not digest_pattern.fullmatch(digest):
            raise ValueError("skill provenance file digest is invalid")
        if path in manifest:
            raise ValueError("skill provenance contains a duplicate path")
        manifest[path] = digest
    if sorted(manifest) != sorted(canonical_files):
        raise ValueError("skill provenance file manifest is incomplete")
    for path, contents in canonical_files.items():
        if hashlib.sha256(contents).hexdigest() != manifest[path]:
            raise ValueError("skill provenance digest disagrees with GitHub source bytes")
    if source.get("sha256") != hashlib.sha256(canonical_files["SKILL.md"]).hexdigest():
        raise ValueError("skill source digest disagrees with GitHub source bytes")


def canonical_provenance_bytes(revision, canonical_files):
    provenance = {
        "schemaVersion": "1",
        "name": skill_name,
        "repository": repository,
        "revision": revision,
        "revisionStatus": "committed",
        "source": {
            "path": source_path,
            "sha256": hashlib.sha256(canonical_files["SKILL.md"]).hexdigest(),
        },
        "files": [
            {"path": path, "sha256": hashlib.sha256(contents).hexdigest()}
            for path, contents in sorted(canonical_files.items())
        ],
    }
    return (json.dumps(provenance, indent=2) + "\\n").encode("utf-8")


def canonical_authorization_receipt_bytes(revision, authorization):
    kind = authorization.get("kind") if isinstance(authorization, dict) else None
    develop = authorization.get("develop") if isinstance(authorization, dict) else None
    require_sha(develop, "authorization receipt develop revision")
    if kind == "develop":
        if set(authorization) != {"kind", "develop"}:
            raise ValueError("develop authorization receipt has an invalid schema")
        recorded_authorization = {"kind": kind, "develop": develop}
    elif kind == "candidate":
        pull = authorization.get("pull")
        if (
            set(authorization) != {"kind", "develop", "pull"}
            or not isinstance(pull, int)
            or isinstance(pull, bool)
            or pull <= 0
        ):
            raise ValueError("candidate authorization receipt has an invalid schema")
        recorded_authorization = {"kind": kind, "develop": develop, "pull": pull}
    else:
        raise ValueError("authorization receipt has an invalid kind")
    receipt = {
        "schemaVersion": "1",
        "repository": repository,
        "revision": revision,
        "authorization": recorded_authorization,
    }
    return (json.dumps(receipt, indent=2) + "\\n").encode("utf-8")


def checked_output(output, target, entry_bytes, total_bytes):
    allowed = min(max_entry_bytes - entry_bytes, max_total_bytes - total_bytes)
    if len(output) > allowed:
        raise ValueError("actual extracted size exceeds limit")
    target.write(output)
    return entry_bytes + len(output), total_bytes + len(output)


def extract_archive(archive_contents, extraction_root):
    raw_archive = io.BytesIO(archive_contents)
    with zipfile.ZipFile(raw_archive, "r") as archive:
        entries = archive.infolist()
        if not 0 < len(entries) <= max_archive_entries:
            raise ValueError("unsafe archive entry count")
        if archive.comment:
            raise ValueError("archive comments are not supported")
        seen_names = set()
        declared_total = 0
        expected_offset = 0
        data_offsets = {}
        for entry in entries:
            name = entry.orig_filename
            if entry.filename != name or not name or name.endswith("/"):
                raise ValueError("archive entries must be named regular files")
            if not name.startswith(skill_prefix):
                raise ValueError("archive path escapes the skill root")
            logical_name = canonical_relative_path(name, "archive path")
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
            if mode and not stat.S_ISREG(mode):
                raise ValueError("non-regular archive entry")
            if entry.file_size > max_entry_bytes:
                raise ValueError("declared entry size exceeds limit")
            declared_total += entry.file_size
            if declared_total > max_total_bytes:
                raise ValueError("declared archive size exceeds limit")
            if entry.header_offset != expected_offset:
                raise ValueError("archive local records are not contiguous")
            raw_archive.seek(entry.header_offset)
            header = raw_archive.read(local_header.size)
            if len(header) != local_header.size:
                raise ValueError("truncated local archive header")
            (
                signature, _version, local_flags, local_compression,
                _modified_time, _modified_date, local_crc,
                local_compressed_size, local_file_size, name_length, extra_length,
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

        os.mkdir(extraction_root, 0o700)
        extracted_total = 0
        for entry in entries:
            name = entry.orig_filename
            destination = os.path.join(extraction_root, *PurePosixPath(name).parts)
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
                    compressed = raw_archive.read(min(65_536, compressed_remaining))
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
                        output, target, extracted_entry, extracted_total
                    )
                    crc = binascii.crc32(output, crc)
                if decompressor is not None:
                    if not decompressor.eof or decompressor.unused_data or decompressor.unconsumed_tail:
                        raise ValueError("invalid deflate stream boundary")
                    output = decompressor.flush()
                    extracted_entry, extracted_total = checked_output(
                        output, target, extracted_entry, extracted_total
                    )
                    crc = binascii.crc32(output, crc)
            if extracted_entry != entry.file_size or crc & 0xFFFFFFFF != entry.CRC:
                raise ValueError("archive size or CRC metadata does not match payload")

    staged_skill = os.path.join(extraction_root, skill_name)
    provenance_path = os.path.join(staged_skill, provenance_name)
    try:
        with open(provenance_path, "r", encoding="utf-8") as provenance_file:
            provenance = json.load(provenance_file)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("archive provenance is missing or invalid") from error
    revision = require_sha(provenance.get("revision") if isinstance(provenance, dict) else None, "archive revision")
    if not isinstance(provenance, dict) or provenance.get("revisionStatus") != "committed":
        raise ValueError("working-tree provenance cannot be installed")
    packaged_paths = sorted(
        entry.orig_filename[len(skill_prefix):]
        for entry in entries
        if entry.orig_filename != f"{skill_prefix}{provenance_name}"
    )
    if f"{skill_prefix}{provenance_name}" not in {entry.orig_filename for entry in entries}:
        raise ValueError("archive provenance is missing")
    canonical_files = remote_skill_bytes(revision)
    authorization = authorize_revision(revision, canonical_files)
    if packaged_paths != sorted(canonical_files):
        raise ValueError("archive files do not exactly match GitHub's canonical skill file list")
    validate_provenance(provenance, revision, canonical_files)
    with open(provenance_path, "rb") as provenance_file:
        if provenance_file.read() != canonical_provenance_bytes(revision, canonical_files):
            raise ValueError("archive provenance bytes are not canonical")
    for path, contents in canonical_files.items():
        with open(os.path.join(staged_skill, *PurePosixPath(path).parts), "rb") as packaged_file:
            if packaged_file.read() != contents:
                raise ValueError("archive file bytes disagree with GitHub's immutable source")
    return staged_skill, revision, canonical_files, authorization


def compare_is_ancestor(old_revision, new_revision):
    comparison = api_json(f"/repos/{repository}/compare/{old_revision}...{new_revision}")
    if not isinstance(comparison, dict):
        raise ValueError("GitHub compare response must be an object")
    base_commit = comparison.get("base_commit")
    merge_base = comparison.get("merge_base_commit")
    return (
        comparison.get("status") == "ahead"
        and isinstance(comparison.get("ahead_by"), int)
        and comparison.get("ahead_by") > 0
        and comparison.get("behind_by") == 0
        and isinstance(base_commit, dict)
        and base_commit.get("sha") == old_revision
        and isinstance(merge_base, dict)
        and merge_base.get("sha") == old_revision
    )


def is_candidate_to_merged_transition(
    old_revision, old_authorization, new_revision, new_authorization
):
    if (
        old_authorization.get("kind") != "candidate"
        or new_authorization.get("kind") != "develop"
    ):
        return False
    candidate_pull = old_authorization.get("pull")
    for pull in pull_records(old_revision):
        if (
            not isinstance(pull, dict)
            or
            pull.get("number") != candidate_pull
            or not pull_matches_repository_contract(
                pull,
                old_revision,
                require_open=False,
                require_label=False,
            )
        ):
            continue
        if not isinstance(pull.get("merged_at"), str):
            continue
        merge_revision = pull.get("merge_commit_sha")
        if not isinstance(merge_revision, str) or not sha_pattern.fullmatch(merge_revision):
            continue
        if merge_revision == new_revision or compare_is_ancestor(merge_revision, new_revision):
            return True
    return False


def read_provenance(path):
    try:
        with open(os.path.join(path, provenance_name), "rb") as source:
            contents = source.read(max_entry_bytes + 1)
        if len(contents) > max_entry_bytes:
            raise ValueError("installed skill provenance exceeds its size bound")
        return contents, json.loads(contents.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("installed skill provenance is missing or invalid") from error


def read_authorization_receipt(path, revision):
    receipt_path = os.path.join(path, authorization_receipt_name)
    try:
        with open(receipt_path, "rb") as source:
            contents = source.read(4097)
        if len(contents) > 4096:
            raise ValueError("installed authorization receipt exceeds its size bound")
        receipt = json.loads(contents.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("installed authorization receipt is missing or invalid") from error
    if (
        not isinstance(receipt, dict)
        or set(receipt) != {"schemaVersion", "repository", "revision", "authorization"}
        or receipt.get("schemaVersion") != "1"
        or receipt.get("repository") != repository
        or receipt.get("revision") != revision
        or not isinstance(receipt.get("authorization"), dict)
    ):
        raise ValueError("installed authorization receipt has an invalid identity")
    authorization = receipt["authorization"]
    if contents != canonical_authorization_receipt_bytes(revision, authorization):
        raise ValueError("installed authorization receipt bytes are not canonical")
    return authorization


def list_local_tree(root):
    files = []
    directories = []
    for directory, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        for name in directory_names:
            path = os.path.join(directory, name)
            if os.path.islink(path):
                raise ValueError("installed skill contains a directory symlink")
            directories.append(os.path.relpath(path, root).replace(os.sep, "/"))
        for name in file_names:
            path = os.path.join(directory, name)
            metadata = os.lstat(path)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise ValueError("installed skill contains a non-regular or hard-linked file")
            files.append(os.path.relpath(path, root).replace(os.sep, "/"))
    return sorted(files), sorted(directories)


def verify_local_version(path, revision, canonical_files=None):
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise ValueError("retained skill version is not a real directory")
    files = canonical_files if canonical_files is not None else remote_skill_bytes(revision)
    provenance_contents, provenance = read_provenance(path)
    authorization = read_authorization_receipt(path, revision)
    validate_provenance(provenance, revision, files)
    expected_paths = sorted([*files, provenance_name, authorization_receipt_name])
    expected_directories = sorted({
        parent
        for relative_path in expected_paths
        for parent in [
            "/".join(relative_path.split("/")[:depth])
            for depth in range(1, len(relative_path.split("/")))
        ]
        if parent
    })
    local_files, local_directories = list_local_tree(path)
    if local_files != expected_paths or local_directories != expected_directories:
        raise ValueError("installed skill has modified, missing, or extra files")
    if provenance_contents != canonical_provenance_bytes(revision, files):
        raise ValueError("installed skill provenance bytes are not canonical")
    for relative_path, expected in files.items():
        with open(os.path.join(path, *PurePosixPath(relative_path).parts), "rb") as source:
            if source.read() != expected:
                raise ValueError("installed skill differs from GitHub's immutable source")
    return files, authorization


def current_install():
    if not os.path.lexists(target_path):
        return None
    if not os.path.islink(target_path):
        raise ValueError("existing skill target is not an installer-managed symlink")
    link = os.readlink(target_path)
    parts = PurePosixPath(link).parts
    if len(parts) != 2 or parts[0] != versions_name:
        raise ValueError("existing skill target points outside the managed version store")
    revision = require_sha(parts[1], "installed skill link revision")
    version_path = os.path.join(versions_root, revision)
    if not os.path.exists(target_path):
        raise ValueError("existing skill target is a broken symlink")
    if os.path.realpath(target_path) != os.path.realpath(version_path):
        raise ValueError("existing skill target resolves outside its named version")
    return revision, version_path


def activate(revision):
    relative_target = f"{versions_name}/{revision}"
    temporary_link = os.path.join(
        skills_root,
        f".{skill_name}-link-{secrets.token_hex(8)}",
    )
    os.symlink(relative_target, temporary_link)
    try:
        os.replace(temporary_link, target_path)
    finally:
        if os.path.lexists(temporary_link):
            os.unlink(temporary_link)


def install_or_update():
    archive_url = f"{artifact_origin}/downloads/{skill_name}.skill"
    checksum_url = f"{archive_url}.sha256"
    archive_contents = fetch_bytes(archive_url, max_archive_bytes, artifact_origin)
    checksum_contents = fetch_bytes(checksum_url, 4096, artifact_origin)
    try:
        checksum_text = checksum_contents.decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("archive checksum is not ASCII") from error
    match = re.fullmatch(rf"([0-9A-Fa-f]{{64}})  {re.escape(skill_name)}\\.skill\\n?", checksum_text)
    if not match:
        raise ValueError("archive checksum record is missing or ambiguous")
    if hashlib.sha256(archive_contents).hexdigest() != match.group(1).lower():
        raise ValueError("archive checksum does not match its bytes")

    work_root = tempfile.mkdtemp(prefix=f".{skill_name}-stage-", dir=skills_root)
    try:
        staged_skill, revision, canonical_files, authorization = extract_archive(
            archive_contents,
            os.path.join(work_root, "extracted"),
        )
        installed = current_install()
        if installed is not None:
            old_revision, old_path = installed
            old_files = canonical_files if old_revision == revision else None
            old_files, old_authorization = verify_local_version(
                old_path, old_revision, old_files
            )
            if old_revision == revision:
                authorize_revision(revision, canonical_files)
                print(f"{skill_name} is already verified at {revision}; no changes made.")
                return
            if old_files == canonical_files:
                authorize_revision(revision, canonical_files)
                print(
                    f"{skill_name} already has the current verified canonical bytes at {old_revision}; no changes made."
                )
                return
            if not compare_is_ancestor(
                old_revision, revision
            ) and not is_candidate_to_merged_transition(
                old_revision,
                old_authorization,
                revision,
                authorization,
            ):
                raise ValueError("refusing downgrade or divergent skill update")

        # Recheck mutable GitHub authority after every download and comparison,
        # immediately before a new immutable version can become activatable.
        authorization = authorize_revision(revision, canonical_files)
        with open(
            os.path.join(staged_skill, authorization_receipt_name),
            "xb",
        ) as receipt_file:
            receipt_file.write(
                canonical_authorization_receipt_bytes(revision, authorization)
            )
        version_path = os.path.join(versions_root, revision)
        if os.path.lexists(version_path):
            verify_local_version(version_path, revision, canonical_files)
        else:
            os.replace(staged_skill, version_path)
        activate(revision)
        action = "Installed" if installed is None else "Updated"
        print(f"{action} {skill_name} at verified revision {revision}.")
    finally:
        shutil.rmtree(work_root)


def rollback():
    revision = require_sha(rollback_revision, "requested rollback revision")
    installed = current_install()
    if installed is None:
        raise ValueError("cannot roll back a skill that is not installed")
    current_revision, current_path = installed
    verify_local_version(current_path, current_revision)
    retained_path = os.path.join(versions_root, revision)
    if not os.path.lexists(retained_path):
        raise ValueError("requested rollback revision is not retained locally")
    retained_files, _ = verify_local_version(retained_path, revision)
    # Receipts preserve entry-time authority for forward transitions; every
    # explicit rollback target must still pass mutable GitHub policy now.
    authorize_revision(revision, retained_files)
    if revision == current_revision:
        print(f"{skill_name} is already verified at {revision}; no changes made.")
        return
    activate(revision)
    print(f"Rolled back {skill_name} to currently authorized retained revision {revision}.")


def acquire_lock():
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as error:
        raise ValueError("installer concurrency lock path is unsafe") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ValueError("installer concurrency lock is not a regular file")
        lock_file = os.fdopen(descriptor, "r+b", buffering=0)
        descriptor = None
        try:
            if os.name == "posix":
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            elif os.name == "nt":
                import msvcrt

                if os.fstat(lock_file.fileno()).st_size == 0:
                    lock_file.write(b"\\0")
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                raise ValueError("installer concurrency locking is unsupported on this platform")
        except (OSError, ImportError) as error:
            lock_file.close()
            raise ValueError(
                "another skill install, update, or rollback holds the concurrency lock"
            ) from error
        return lock_file
    finally:
        if descriptor is not None:
            os.close(descriptor)


def main():
    if operation not in ("install", "rollback"):
        raise ValueError("ELIZA_ARMY_SKILL_OPERATION must be install or rollback")
    if operation == "install" and rollback_revision:
        raise ValueError("ELIZA_ARMY_SKILL_REVISION is valid only for an explicit rollback")
    os.makedirs(skills_root, mode=0o755, exist_ok=True)
    if os.path.lexists(versions_root):
        metadata = os.lstat(versions_root)
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise ValueError("managed skill version store is not a real directory")
    else:
        os.mkdir(versions_root, 0o755)
    lock_file = acquire_lock()
    try:
        if operation == "rollback":
            rollback()
        else:
            install_or_update()
    finally:
        # Kernel locks are released even after an uncatchable process exit; the
        # inert file stays in place to avoid unlink/recreate split-lock races.
        lock_file.close()


try:
    main()
except Exception as error:  # error-policy:J1 installer process boundary
    print(f"Refusing skill operation: {error}", file=sys.stderr)
    sys.exit(1)
PY
)`;
}
