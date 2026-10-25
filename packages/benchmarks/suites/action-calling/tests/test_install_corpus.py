"""Exercise complete corpus installation, corruption rejection and file preservation."""

import gzip
import hashlib
import importlib
import json
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

installer = importlib.import_module("benchmarks.suites.action-calling.install_corpus")


@pytest.fixture
def artifact(tmp_path):
    data = b"".join(
        (
            json.dumps({"text": "λ雪" * 10000, "id": i}, ensure_ascii=False) + "\n"
        ).encode()
        for i in range(3)
    )
    archive = gzip.compress(data, mtime=0)
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    spec = {
        "recordBytes": len(data),
        "recordCount": 3,
        "recordSha256": hashlib.sha256(data).hexdigest(),
        "archiveBytes": len(archive),
        "archiveSha256": hashlib.sha256(archive).hexdigest(),
    }
    (bundle / "manifest.json").write_text(json.dumps(spec))
    (bundle / "LICENSE").write_text("Fixture license")
    (bundle / "SOURCE-README.md").write_text("Fixture source")
    source = tmp_path / "corpus.gz"
    source.write_bytes(archive)
    return bundle, source, data


def test_offline_install_keeps_every_byte_and_verifies_repeat_without_download(
    tmp_path, artifact
):
    bundle, archive, data = artifact
    dest = tmp_path / "installed"
    assert installer._install(dest, archive, bundle)["status"] == "installed"
    assert (dest / installer.RECORD_NAME).read_bytes() == data
    archive.unlink()
    assert installer._install(dest, archive, bundle)["status"] == "verified"
    assert (dest / "LICENSE").read_bytes() == (bundle / "LICENSE").read_bytes()
    (dest / installer.RECORD_NAME).write_bytes(data[:-1])
    with pytest.raises(ValueError):
        installer._install(dest, archive, bundle)


@pytest.mark.parametrize("kind", ["truncated", "wrong-hash", "extra-bytes"])
def test_bad_download_never_publishes_a_usable_corpus(tmp_path, artifact, kind):
    bundle, archive, data = artifact
    raw = archive.read_bytes()
    archive.write_bytes(
        raw[:-5]
        if kind == "truncated"
        else bytes([raw[0] ^ 1]) + raw[1:]
        if kind == "wrong-hash"
        else raw + b"extra"
    )
    dest = tmp_path / "failed"
    with pytest.raises(ValueError):
        installer._install(dest, archive, bundle)
    assert not (dest / installer.RECORD_NAME).exists()


def test_existing_unrelated_destination_is_untouched(tmp_path, artifact):
    bundle, archive, _ = artifact
    dest = tmp_path / "owned"
    dest.mkdir()
    (dest / "sentinel").write_text("keep")
    with pytest.raises(FileNotFoundError):
        installer._install(dest, archive, bundle)
    assert list(dest.iterdir()) == [dest / "sentinel"]
    assert (dest / "sentinel").read_text() == "keep"


@pytest.mark.parametrize("interrupted", [False, True])
def test_real_http_download_passes_through_checksum_and_decoder(
    tmp_path, artifact, interrupted
):
    bundle, archive, data = artifact

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            raw = archive.read_bytes()
            self.send_response(200)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw[:-5] if interrupted else raw)
            self.close_connection = True

        def log_message(self, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    spec = json.loads((bundle / "manifest.json").read_text())
    spec["archiveUrl"] = f"http://127.0.0.1:{server.server_port}/corpus.gz"
    (bundle / "manifest.json").write_text(json.dumps(spec))
    try:
        dest = tmp_path / "downloaded"
        if interrupted:
            with pytest.raises((HTTPException, ValueError)):
                installer._install(dest, None, bundle)
            assert not (dest / installer.RECORD_NAME).exists()
        else:
            installer._install(dest, None, bundle)
            assert (dest / installer.RECORD_NAME).read_bytes() == data
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
