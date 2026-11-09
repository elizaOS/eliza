#!/usr/bin/env python3
"""Optional local Chromium smoke test using only synthetic release fixtures."""

import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import release_artifact as release
from test_release_artifact import REQUEST_ID, SHA, digest, reviewed, zip_bytes


class BrowserSmokeTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("chromium") or shutil.which("chromium-browser"),
                         "Chromium is not installed")
    def test_root_and_os_load_relative_scripts(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        output = root / "release"
        profile = root / "profile"
        manifest_path = root / "manifest.json"

        pages = {
            "valhalla-os/index.html": b'<html><body>Home<script src="assets/app.js"></script></body></html>',
            "valhalla-os/valhalla98.html": b'<html><body>OS<script src="assets/app.js"></script></body></html>',
            "valhalla-os/assets/app.js": b"document.body.dataset.assetLoaded = 'yes';",
        }
        data = zip_bytes([(name, content, None) for name, content in pages.items()]
                         + [("valhalla-os/server.ts", b"private", None)])
        manifest_path.write_text(json.dumps(reviewed(data, pages)), encoding="utf-8")
        files = release.load_manifest(manifest_path, digest(data))
        release.assemble(data, digest(data), files, output, SHA, REQUEST_ID)

        requested = []
        class Handler(http.server.SimpleHTTPRequestHandler):
            def do_GET(self):
                requested.append(self.path)
                super().do_GET()

            def log_message(self, *args):
                pass

        handler = functools.partial(Handler, directory=str(output))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        profile.mkdir()
        environment = dict(os.environ, HOME=str(profile), XDG_CACHE_HOME=str(profile),
                           XDG_CONFIG_HOME=str(profile), TMPDIR=str(root))
        browser = shutil.which("chromium") or shutil.which("chromium-browser")
        try:
            for path, text in (("/", "Home"), ("/valhalla98.html", "OS"), ("/os/", "OS")):
                url = f"http://127.0.0.1:{server.server_port}{path}"
                result = subprocess.run(
                    [browser, "--headless", "--no-sandbox", "--disable-gpu",
                     "--disable-background-networking", "--disable-crash-reporter",
                     "--disable-component-update", "--disable-sync", "--proxy-server=direct://",
                     "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
                     "--no-first-run", f"--user-data-dir={profile}", "--dump-dom", url],
                    env=environment, capture_output=True, text=True, timeout=30, check=True,
                )
                self.assertIn(f">{text}<", result.stdout)
                self.assertIn('data-asset-loaded="yes"', result.stdout)
            self.assertIn("/assets/app.js", requested)
            self.assertIn("/os/assets/app.js", requested)
            with self.assertRaises(urllib.error.HTTPError) as response:
                urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/server.ts", timeout=5)
            self.assertEqual(response.exception.code, 404)
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()


if __name__ == "__main__":
    unittest.main()
