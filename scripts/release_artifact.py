#!/usr/bin/env python3
"""Download and assemble a release only from an explicitly reviewed manifest."""

import argparse
import gzip
import hashlib
import io
import json
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


DRIVE_ID = "1_rFRoaRKhbqHB0CXOVygtYUtfVYH18jO"
DEFAULT_URL = f"https://drive.google.com/uc?export=download&id={DRIVE_ID}"
# This production value is unverified; it is not a substitute for review.
DEFAULT_SHA256 = "63b9b02d491efd4f10ee195ba2452e8ad3eeaf242006bb859f8d96ee2c257a05"
MAX_DOWNLOAD = 128 * 1024 * 1024
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
MAX_ENTRIES = 10000
MAX_MANIFEST = 1024 * 1024
CHUNK = 65536
DOWNLOAD_DEADLINE = 120
HEX = re.compile(r"[0-9a-f]{64}\Z")
SOURCE_SHA = re.compile(r"[0-9a-f]{40}\Z")
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
PUBLIC_SUFFIXES = {".html", ".htm", ".css", ".js", ".mjs", ".json", ".webmanifest",
                   ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico",
                   ".woff", ".woff2", ".ttf", ".otf", ".wasm", ".mp3", ".ogg", ".wav",
                   ".mp4", ".webm", ".txt"}
DENIED_PARTS = {"api", "backend", "server", "node_modules", "vendor", "credentials",
                "credential", "secrets", "secret", "private", "config", "env"}


class ReleaseError(ValueError):
    pass


def https_url(url):
    parts = urllib.parse.urlsplit(url)
    if (parts.scheme.lower() != "https" or not parts.hostname
            or parts.username is not None or parts.password is not None):
        raise ReleaseError("download URL and redirects must be credential-free HTTPS")
    try:
        parts.port
    except ValueError as exc:
        raise ReleaseError("invalid URL port") from exc
    return url


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        https_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_direct(url):
    request = urllib.request.Request(https_url(url), headers={
        "User-Agent": "release-artifact-validator/1", "Accept-Encoding": "identity"
    })
    opener = urllib.request.build_opener(HTTPSRedirect())
    with opener.open(request, timeout=30) as response:
        https_url(response.geturl())
        content_type = response.headers.get("Content-Type", "").lower()
        if "text/html" in content_type or "application/xhtml" in content_type:
            raise ReleaseError("HTML response is not a release archive")
        length = response.headers.get("Content-Length")
        if length is not None:
            if not length.isascii() or not length.isdecimal() or int(length) > MAX_DOWNLOAD:
                raise ReleaseError("invalid or excessive download length")
        data = bytearray()
        while True:
            chunk = response.read(min(CHUNK, MAX_DOWNLOAD + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_DOWNLOAD:
                raise ReleaseError("download exceeds size limit")
        if length is not None and len(data) != int(length):
            raise ReleaseError("download length mismatch")
    prefix = bytes(data[:1024]).lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if prefix.startswith((b"<!doctype html", b"<html", b"<head", b"<body")):
        raise ReleaseError("HTML response is not a release archive")
    return bytes(data)


def download(url):
    https_url(url)
    try:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--_download-worker", url],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=DOWNLOAD_DEADLINE,
            check=True,
        )
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
        raise ReleaseError("download failed or exceeded wall-clock deadline") from exc
    if len(result.stdout) > MAX_DOWNLOAD:
        raise ReleaseError("download exceeds size limit")
    return result.stdout


def safe_path(name, directory=False):
    if not isinstance(name, str) or not name or "\x00" in name or "\\" in name:
        raise ReleaseError("invalid archive path")
    if directory and name.endswith("/"):
        name = name[:-1]
    parts = name.split("/")
    if (any(part in ("", ".", "..") for part in parts)
            or name.startswith("/") or re.match(r"^[A-Za-z]:", name)
            or any(any(ord(c) < 32 or ord(c) == 127 for c in part) for part in parts)):
        raise ReleaseError(f"unsafe path: {name!r}")
    return name


def public_path(name):
    parts = name.split("/")
    if parts[0] == "valhalla-os":
        parts = parts[1:]
    if not parts:
        raise ReleaseError("manifest path is not a public file")
    for part in parts:
        lower = part.lower()
        stem = lower.split(".", 1)[0]
        if (lower.startswith(".") or stem in DENIED_PARTS
                or any(word in lower for word in ("secret", "credential", "password", "private", "token"))):
            raise ReleaseError(f"excluded non-public path: {name}")
    path = "/".join(parts)
    if parts[0].lower() in ("os", "release.json") or Path(parts[-1]).suffix.lower() not in PUBLIC_SUFFIXES:
        raise ReleaseError(f"excluded non-public path: {name}")
    return path


def load_manifest(path, expected):
    if not isinstance(expected, str) or not HEX.fullmatch(expected):
        raise ReleaseError("expected SHA-256 must be 64 lowercase hex characters")
    with open(path, "rb") as f:
        raw = f.read(MAX_MANIFEST + 1)
    if len(raw) > MAX_MANIFEST:
        raise ReleaseError("manifest exceeds size limit")
    def no_duplicates(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ReleaseError(f"duplicate manifest key: {key}")
            result[key] = value
        return result
    try:
        manifest = json.loads(raw, object_pairs_hook=no_duplicates)
    except (ValueError, UnicodeError) as exc:
        raise ReleaseError("invalid manifest JSON") from exc
    if (not isinstance(manifest, dict)
            or set(manifest) != {"reviewed", "archive_sha256", "files"}
            or manifest["reviewed"] is not True
            or manifest["archive_sha256"] != expected
            or not isinstance(manifest["files"], list)
            or not 1 <= len(manifest["files"]) <= MAX_ENTRIES):
        raise ReleaseError("manifest must explicitly attest review and match expected digest")
    files = {}
    output_paths = {}
    for entry in manifest["files"]:
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise ReleaseError("invalid manifest file entry")
        name = safe_path(entry["path"])
        output_name = public_path(name)
        if (name in files or type(entry["size"]) is not int
                or not 0 <= entry["size"] <= MAX_FILE
                or not isinstance(entry["sha256"], str)
                or not HEX.fullmatch(entry["sha256"])):
            raise ReleaseError("invalid or duplicate manifest file")
        files[name] = entry
        if output_name in output_paths:
            raise ReleaseError("manifest paths collide after prefix removal")
        output_paths[output_name] = name
    check_tree({name: False for name in output_paths})
    if not {"index.html", "valhalla98.html"} <= set(output_paths):
        raise ReleaseError("manifest must review index.html and valhalla98.html")
    return files


def check_tree(paths):
    for name in paths:
        parts = name.split("/")
        for i in range(1, len(parts)):
            parent = "/".join(parts[:i])
            if parent in paths and not paths[parent]:
                raise ReleaseError(f"file is a parent of another path: {parent}")


def bounded_gzip(data):
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
        result = stream.read(MAX_ARCHIVE + 1)
    if len(result) > MAX_ARCHIVE:
        raise ReleaseError("expanded archive exceeds size limit")
    return result


def check_zip_directory(data):
    # Refuse multi-disk and ZIP64 archives before ZipFile allocates entry objects.
    start = max(0, len(data) - 65557)
    position = data.rfind(b"PK\x05\x06", start)
    if position < 0 or position + 22 > len(data):
        raise ReleaseError("invalid ZIP directory")
    _, disk, directory_disk, disk_count, count, size, offset, comment = struct.unpack_from(
        "<4s4H2LH", data, position
    )
    if (disk or directory_disk or disk_count != count or count > MAX_ENTRIES
            or count == 0xffff or size == 0xffffffff or offset == 0xffffffff
            or offset + size != position or position + 22 + comment != len(data)):
        raise ReleaseError("unsupported or excessive ZIP directory")
    cursor = offset
    actual_count = 0
    while cursor < position:
        if cursor + 46 > position or data[cursor:cursor + 4] != b"PK\x01\x02":
            raise ReleaseError("invalid ZIP central directory record")
        name_size, extra_size, comment_size = struct.unpack_from("<3H", data, cursor + 28)
        cursor += 46 + name_size + extra_size + comment_size
        if cursor > position:
            raise ReleaseError("truncated ZIP central directory record")
        actual_count += 1
        if actual_count > MAX_ENTRIES or actual_count > count:
            raise ReleaseError("ZIP central directory entry count mismatch")
    if cursor != position or actual_count != count:
        raise ReleaseError("ZIP central directory entry count mismatch")


def validate_archive(data, expected, files):
    if len(data) > MAX_DOWNLOAD:
        raise ReleaseError("archive exceeds download limit")
    if hashlib.sha256(data).hexdigest() != expected:
        raise ReleaseError("archive SHA-256 mismatch")
    source = io.BytesIO(data)
    if zipfile.is_zipfile(source):
        check_zip_directory(data)
        archive = zipfile.ZipFile(source)
        kind = "zip"
        entries = archive.infolist()
    else:
        if data.startswith(b"\x1f\x8b"):
            data = bounded_gzip(data)
        if len(data) > MAX_ARCHIVE:
            raise ReleaseError("archive exceeds size limit")
        archive = tarfile.open(fileobj=io.BytesIO(data), mode="r:")
        kind = "tar"
        entries = archive
    try:
        paths = {}
        total = 0
        selected = {}
        for count, entry in enumerate(entries, 1):
            if count > MAX_ENTRIES:
                raise ReleaseError("too many archive entries")
            if kind == "zip":
                directory = entry.is_dir()
                if entry.orig_filename != entry.filename:
                    raise ReleaseError("invalid ZIP entry name")
                name = safe_path(entry.filename, directory)
                mode = entry.external_attr >> 16
                file_type = stat.S_IFMT(mode) if entry.create_system == 3 else 0
                if file_type not in (0, stat.S_IFDIR if directory else stat.S_IFREG):
                    raise ReleaseError(f"link or special entry: {name}")
                if entry.flag_bits & 1:
                    raise ReleaseError("encrypted archive entry")
                size = entry.file_size
                get_stream = lambda e=entry: archive.open(e)
            else:
                directory = entry.isdir()
                name = safe_path(entry.name, directory)
                if not (directory or entry.isreg()) or entry.sparse is not None:
                    raise ReleaseError(f"link or special entry: {name}")
                size = entry.size
                get_stream = lambda e=entry: archive.extractfile(e)
            if name in paths:
                raise ReleaseError(f"duplicate archive path: {name}")
            paths[name] = directory
            if size < 0 or size > MAX_FILE or (directory and size != 0):
                raise ReleaseError(f"invalid entry size: {name}")
            total += size
            if total > MAX_TOTAL:
                raise ReleaseError("archive exceeds expanded size limit")
            if directory:
                continue
            digest = hashlib.sha256()
            actual = 0
            with get_stream() as stream:
                while True:
                    chunk = stream.read(CHUNK)
                    if not chunk:
                        break
                    actual += len(chunk)
                    if actual > size:
                        raise ReleaseError(f"entry exceeds declared size: {name}")
                    digest.update(chunk)
            if actual != size:
                raise ReleaseError(f"entry size mismatch: {name}")
            if name in files:
                if size != files[name]["size"] or digest.hexdigest() != files[name]["sha256"]:
                    raise ReleaseError(f"reviewed file mismatch: {name}")
                selected[name] = entry
        check_tree(paths)
        if set(selected) != set(files):
            raise ReleaseError("reviewed files missing from archive")
        return archive, kind, selected
    except Exception:
        archive.close()
        raise


def release_metadata(sha, request_id, package_sha256):
    return {"sha": sha, "request_id": request_id, "package_sha256": package_sha256}


def assemble(data, expected, files, destination, sha, request_id):
    if not SOURCE_SHA.fullmatch(sha) or not REQUEST_ID.fullmatch(request_id):
        raise ReleaseError("invalid source SHA or request ID")
    archive, kind, selected = validate_archive(data, expected, files)
    destination = Path(destination)
    created = False
    try:
        destination.mkdir()
        created = True
        for name, entry in selected.items():
            output_name = public_path(name)
            get_stream = archive.open(entry) if kind == "zip" else archive.extractfile(entry)
            with get_stream as source:
                content = source.read(MAX_FILE + 1)
            if (len(content) != files[name]["size"]
                    or hashlib.sha256(content).hexdigest() != files[name]["sha256"]):
                raise ReleaseError(f"file changed during assembly: {name}")
            for prefix in (destination, destination / "os"):
                if prefix != destination and output_name == "index.html":
                    continue
                target = prefix.joinpath(*output_name.split("/"))
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as output:
                    output.write(content)
                if prefix != destination and output_name == "valhalla98.html":
                    with (prefix / "index.html").open("xb") as output:
                        output.write(content)
        metadata = release_metadata(sha, request_id, expected)
        with (destination / "release.json").open("x", encoding="utf-8") as output:
            json.dump(metadata, output, ensure_ascii=True, sort_keys=True, indent=2)
            output.write("\n")
    except Exception:
        if created:
            shutil.rmtree(destination)
        raise
    finally:
        archive.close()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--_download-worker":
        try:
            sys.stdout.buffer.write(download_direct(sys.argv[2]))
        except Exception:
            sys.exit(1)
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, help="explicitly reviewed JSON manifest")
    parser.add_argument("--output", required=True, help="new output directory (must not exist)")
    parser.add_argument("--url", default=DEFAULT_URL, help="HTTPS archive URL")
    parser.add_argument("--expected-sha256", default=DEFAULT_SHA256)
    parser.add_argument("--sha", required=True, help="exact source commit SHA")
    parser.add_argument("--request-id", required=True, help="deployment request ID")
    args = parser.parse_args()
    try:
        files = load_manifest(args.manifest, args.expected_sha256)
        if not SOURCE_SHA.fullmatch(args.sha) or not REQUEST_ID.fullmatch(args.request_id):
            raise ReleaseError("invalid source SHA or request ID")
        assemble(download(args.url), args.expected_sha256, files, args.output,
                 args.sha, args.request_id)
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile, EOFError) as exc:
        parser.exit(1, f"release assembly failed: {exc}\n")


if __name__ == "__main__":
    main()
