#!/usr/bin/env python3
import gzip
import hashlib
import io
import json
from contextlib import nullcontext
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock
import urllib.request
import zipfile

import release_artifact as release

SHA = "a" * 40
REQUEST_ID = "request-123"
OS_PAGE = b"os page"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def zip_bytes(entries):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        if not any(name in ("valhalla98.html", "valhalla-os/valhalla98.html") for name, _, _ in entries):
            entries = list(entries) + [("valhalla98.html", OS_PAGE, None)]
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name)
            if mode is not None:
                info.create_system = 3
                info.external_attr = mode << 16
            archive.writestr(info, data)
    return out.getvalue()


def tar_bytes(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as archive:
        if not any(name in ("valhalla98.html", "valhalla-os/valhalla98.html") for name, _, _ in entries):
            entries = list(entries) + [("valhalla98.html", OS_PAGE, tarfile.REGTYPE)]
        for name, data, entry_type in entries:
            info = tarfile.TarInfo(name)
            info.type = entry_type
            if entry_type == tarfile.REGTYPE:
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            else:
                info.linkname = "target"
                archive.addfile(info)
    return out.getvalue()


def reviewed(data, contents):
    contents = dict(contents)
    if not any(name in contents for name in ("valhalla98.html", "valhalla-os/valhalla98.html")):
        contents["valhalla98.html"] = OS_PAGE
    return {
        "reviewed": True,
        "archive_sha256": digest(data),
        "files": [
            {"path": name, "size": len(value), "sha256": digest(value)}
            for name, value in contents.items()
        ],
    }


class FixtureTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.output = root / "output"
        self.manifest = root / "manifest.json"

    def load(self, manifest, expected):
        self.manifest.write_text(json.dumps(manifest), encoding="utf-8")
        return release.load_manifest(self.manifest, expected)

    def test_zip_assembly_preserves_relative_paths_and_excludes_unreviewed(self):
        # A quote in a filename verifies JSON serialization without unsafe interpolation.
        contents = {"index.html": b"<h1>Hi</h1>", 'assets/quote".js': b"ok"}
        data = zip_bytes([(name, value, None) for name, value in contents.items()]
                         + [("private.txt", b"do not publish", None)])
        files = self.load(reviewed(data, contents), digest(data))
        release.assemble(data, digest(data), files, self.output, SHA, REQUEST_ID)
        for prefix in (self.output, self.output / "os"):
            for name, value in contents.items():
                if prefix != self.output and name == "index.html":
                    continue
                self.assertEqual((prefix / name).read_bytes(), value)
            self.assertFalse((prefix / "private.txt").exists())
        self.assertEqual((self.output / "os/index.html").read_bytes(), OS_PAGE)
        metadata = json.loads((self.output / "release.json").read_text())
        self.assertEqual(metadata, {"sha": SHA, "request_id": REQUEST_ID,
                                    "package_sha256": digest(data)})
        with self.assertRaises(FileExistsError):
            release.assemble(data, digest(data), files, self.output, SHA, REQUEST_ID)
        self.assertTrue((self.output / "index.html").exists())

    def test_tar_and_gzip_assembly(self):
        contents = {"index.html": b"page", "assets/app.js": b"script"}
        raw = tar_bytes([(name, value, tarfile.REGTYPE) for name, value in contents.items()])
        for data in (raw, gzip.compress(raw)):
            with self.subTest(gzip=data != raw):
                files = self.load(reviewed(data, contents), digest(data))
                release.assemble(data, digest(data), files, self.output, SHA, REQUEST_ID)
                self.assertEqual((self.output / "os/assets/app.js").read_bytes(), b"script")
                shutil.rmtree(self.output)

    def test_prefixed_archive_layout_and_alias(self):
        contents = {"valhalla-os/index.html": b"home",
                    "valhalla-os/valhalla98.html": b"os",
                    "valhalla-os/assets/app.js": b"js"}
        data = zip_bytes([(name, value, None) for name, value in contents.items()])
        files = self.load(reviewed(data, contents), digest(data))
        release.assemble(data, digest(data), files, self.output, SHA, REQUEST_ID)
        self.assertEqual((self.output / "index.html").read_bytes(), b"home")
        self.assertEqual((self.output / "valhalla98.html").read_bytes(), b"os")
        self.assertEqual((self.output / "os/index.html").read_bytes(), b"os")
        self.assertEqual((self.output / "assets/app.js").read_bytes(), b"js")
        self.assertEqual((self.output / "os/assets/app.js").read_bytes(), b"js")

    def test_manifest_review_digest_schema_and_paths(self):
        data = zip_bytes([("index.html", b"ok", None)])
        base = reviewed(data, {"index.html": b"ok"})
        for update in ({"reviewed": False}, {"reviewed": 1}, {"archive_sha256": "0" * 64},
                       {"files": []}, {"extra": 1}):
            with self.subTest(update=update):
                with self.assertRaises(release.ReleaseError):
                    self.load(dict(base, **update), digest(data))
        for name in ("../escape", "/absolute", "a/../b", "a//b", "a\\b", "C:/bad",
                     "os/x", "release.json/x", "x\nbad", ".env", "assets/.hidden.js",
                     "server.ts", "server.js", "api/index.js", "backend/app.js",
                     "assets/password.json", "key.pem", "node_modules/thing.js"):
            with self.subTest(name=name):
                manifest = reviewed(data, {name: b"ok"})
                with self.assertRaises(release.ReleaseError):
                    self.load(manifest, digest(data))
        self.manifest.write_text('{"reviewed":true,"reviewed":false}', encoding="utf-8")
        with self.assertRaises(release.ReleaseError):
            release.load_manifest(self.manifest, digest(data))
        with self.assertRaises(release.ReleaseError):
            release.load_manifest(self.manifest, "not-a-digest")
        for contents in ({"index.html": b"ok"}, {"index.html": b"ok",
                         "valhalla98.html": OS_PAGE, "valhalla-os/index.html": b"ok"}):
            manifest = reviewed(data, contents)
            if len(contents) == 1:
                manifest["files"] = manifest["files"][:1]
            with self.assertRaises(release.ReleaseError):
                self.load(manifest, digest(data))

    def test_checksum_missing_and_content_mismatch_fail_without_output(self):
        data = zip_bytes([("index.html", b"ok", None)])
        files = self.load(reviewed(data, {"index.html": b"ok"}), digest(data))
        for bad_data, expected, bad_files in (
            (data, "0" * 64, files),
            (data, digest(data), {"missing": files["index.html"]}),
            (data, digest(data), {"index.html": dict(files["index.html"], sha256="0" * 64)}),
            (data, digest(data), {"index.html": dict(files["index.html"], size=1)}),
        ):
            with self.subTest(expected=expected, bad_files=bad_files):
                with self.assertRaises(release.ReleaseError):
                    release.assemble(bad_data, expected, bad_files, self.output, SHA, REQUEST_ID)
                self.assertFalse(self.output.exists())

    def test_bad_zip_entries_rejected_even_when_unlisted(self):
        bad_entries = [
            [("../escape", b"x", None)],
            [("/absolute", b"x", None)],
            [("a\\b", b"x", None)],
            [("dup", b"x", None), ("dup", b"y", None)],
            [("a", b"x", None), ("a/b", b"y", None)],
            [("link", b"target", stat.S_IFLNK | 0o777)],
            [("device", b"", stat.S_IFCHR | 0o600)],
        ]
        for entries in bad_entries:
            with self.subTest(entries=entries):
                with self.assertWarns(Warning) if len(entries) == 2 and entries[0][0] == "dup" else nullcontext():
                    data = zip_bytes([("index.html", b"ok", None)] + entries)
                files = self.load(reviewed(data, {"index.html": b"ok"}), digest(data))
                with self.assertRaises(release.ReleaseError):
                    release.assemble(data, digest(data), files, self.output, SHA, REQUEST_ID)
                self.assertFalse(self.output.exists())

    def test_bad_tar_entries_rejected(self):
        for name, kind in (("../x", tarfile.REGTYPE), ("link", tarfile.SYMTYPE),
                           ("hard", tarfile.LNKTYPE), ("device", tarfile.CHRTYPE),
                           ("fifo", tarfile.FIFOTYPE)):
            with self.subTest(name=name):
                data = tar_bytes([("index.html", b"ok", tarfile.REGTYPE), (name, b"x", kind)])
                files = self.load(reviewed(data, {"index.html": b"ok"}), digest(data))
                with self.assertRaises(release.ReleaseError):
                    release.assemble(data, digest(data), files, self.output, SHA, REQUEST_ID)

    def test_limits_and_corrupt_archive(self):
        data = zip_bytes([("index.html", b"ok", None), ("asset", b"more", None)])
        files = self.load(reviewed(data, {"index.html": b"ok"}), digest(data))
        for limit, value in (("MAX_ENTRIES", 1), ("MAX_FILE", 1), ("MAX_TOTAL", 3),
                             ("MAX_DOWNLOAD", len(data) - 1)):
            with self.subTest(limit=limit), mock.patch.object(release, limit, value):
                with self.assertRaises(release.ReleaseError):
                    release.assemble(data, digest(data), files, self.output, SHA, REQUEST_ID)
        with mock.patch.object(release, "MAX_ARCHIVE", 10):
            with self.assertRaises(release.ReleaseError):
                release.bounded_gzip(gzip.compress(b"x" * 11))
        broken = data[:-10]
        with self.assertRaises((release.ReleaseError, tarfile.TarError, zipfile.BadZipFile)):
            release.assemble(broken, digest(broken), files, self.output, SHA, REQUEST_ID)
        corrupt = bytearray(data)
        content_offset = data.index(b"more")
        corrupt[content_offset] ^= 1
        corrupt = bytes(corrupt)
        with self.assertRaises(zipfile.BadZipFile):
            release.assemble(corrupt, digest(corrupt), files, self.output, SHA, REQUEST_ID)
        self.assertFalse(self.output.exists())

    def test_forged_zip_entry_count_rejected_before_zipfile_parses(self):
        data = bytearray(zip_bytes([("index.html", b"ok", None), ("extra.txt", b"x", None)]))
        end = data.rfind(b"PK\x05\x06")
        struct.pack_into("<HH", data, end + 8, 1, 1)
        data = bytes(data)
        with mock.patch.object(release.zipfile, "ZipFile") as zip_file:
            with self.assertRaises(release.ReleaseError):
                release.validate_archive(data, digest(data), {})
            zip_file.assert_not_called()

    def test_partial_output_is_removed_on_write_failure(self):
        data = zip_bytes([("index.html", b"ok", None)])
        files = self.load(reviewed(data, {"index.html": b"ok"}), digest(data))
        with mock.patch.object(release.json, "dump", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                release.assemble(data, digest(data), files, self.output, SHA, REQUEST_ID)
        self.assertFalse(self.output.exists())

    def test_cli_fails_closed_before_network_without_review(self):
        self.manifest.write_text('{"reviewed":false}', encoding="utf-8")
        result = subprocess.run(
            [sys.executable, "scripts/release_artifact.py", "--manifest", str(self.manifest),
             "--output", str(self.output), "--url", "https://invalid.invalid/",
             "--sha", SHA, "--request-id", REQUEST_ID],
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("manifest", result.stderr)
        self.assertFalse(self.output.exists())


class MetadataTest(unittest.TestCase):
    def test_release_metadata_is_bounded_and_contains_only_marker_fields(self):
        metadata = release.release_metadata(SHA, "a" * 128, "b" * 64)
        encoded = json.dumps(metadata, ensure_ascii=True, sort_keys=True, indent=2)
        self.assertEqual(json.loads(encoded), {
            "sha": SHA, "request_id": "a" * 128, "package_sha256": "b" * 64,
        })
        self.assertLess(len(encoded.encode("utf-8")) + 1, 65536)

    def test_assembly_writes_only_bounded_marker_fields(self):
        data = zip_bytes([("index.html", b"home", None)])
        entries = reviewed(data, {"index.html": b"home"})["files"]
        files = {entry["path"]: entry for entry in entries}

        class Marker(io.StringIO):
            def __exit__(self, *args):
                return False

        marker = Marker()

        def fake_open(path, mode, **kwargs):
            return marker if path.name == "release.json" else io.BytesIO()

        with mock.patch.object(release.Path, "mkdir"), \
                mock.patch.object(release.Path, "open", autospec=True, side_effect=fake_open):
            release.assemble(data, digest(data), files, "unused-output", SHA, REQUEST_ID)
        self.assertEqual(json.loads(marker.getvalue()), {
            "sha": SHA, "request_id": REQUEST_ID, "package_sha256": digest(data),
        })
        self.assertLess(len(marker.getvalue().encode("utf-8")), 65536)


class Response(io.BytesIO):
    def __init__(self, data, headers=None, url="https://example.test/a"):
        super().__init__(data)
        self.headers = headers or {}
        self.url = url

    def geturl(self):
        return self.url


class DownloadTest(unittest.TestCase):
    def download_response(self, response):
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(release.urllib.request, "build_opener", return_value=opener):
            return release.download_direct("https://example.test/a")

    def test_download_accepts_bounded_response(self):
        self.assertEqual(self.download_response(Response(b"archive", {"Content-Length": "7"})),
                         b"archive")

    def test_html_length_and_size_rejected(self):
        responses = [
            Response(b"archive", {"Content-Type": "text/html; charset=utf-8"}),
            Response(b"  <!DOCTYPE html><html>confirmation"),
            Response(b"x", {"Content-Length": "2"}),
            Response(b"x", {"Content-Length": str(release.MAX_DOWNLOAD + 1)}),
            Response(b"x", url="http://example.test/a"),
        ]
        for response in responses:
            with self.subTest(headers=response.headers, url=response.url):
                with self.assertRaises(release.ReleaseError):
                    self.download_response(response)
        with mock.patch.object(release, "MAX_DOWNLOAD", 3):
            with self.assertRaises(release.ReleaseError):
                self.download_response(Response(b"four"))

    def test_rejects_http_credentials_and_insecure_redirect(self):
        for url in ("http://example.test", "https://user@example.test"):
            with self.subTest(url=url), self.assertRaises(release.ReleaseError):
                release.download(url)
        request = urllib.request.Request("https://example.test")
        with self.assertRaises(release.ReleaseError):
            release.HTTPSRedirect().redirect_request(request, None, 302, "", {}, "http://example.test")

    def test_total_deadline_is_enforced_by_parent_process(self):
        with mock.patch.object(release.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired("worker", 120)) as run:
            with self.assertRaises(release.ReleaseError):
                release.download("https://example.test/a")
            self.assertEqual(run.call_args.kwargs["timeout"], release.DOWNLOAD_DEADLINE)

    def test_deadline_terminates_stalled_worker(self):
        run = subprocess.run
        def stalled_worker(_command, **kwargs):
            return run([sys.executable, "-c", "import time; time.sleep(5)"], **kwargs)
        started = time.monotonic()
        with mock.patch.object(release.subprocess, "run", side_effect=stalled_worker), \
                mock.patch.object(release, "DOWNLOAD_DEADLINE", 0.1):
            with self.assertRaises(release.ReleaseError):
                release.download("https://example.test/a")
        self.assertLess(time.monotonic() - started, 3)


if __name__ == "__main__":
    unittest.main()
