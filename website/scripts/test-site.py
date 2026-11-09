from html.parser import HTMLParser
from pathlib import Path
import functools
import http.server
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site-build"


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "img", "video", "source"):
            self.paths.extend(attrs[key] for key in ("src", "poster") if key in attrs)
        if tag == "link" and attrs.get("rel") in ("stylesheet", "icon", "preload"):
            self.paths.append(attrs.get("href", ""))


class SiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(OUT))
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def get(self, path):
        return urllib.request.urlopen(self.base + path)

    def test_routes_and_assets(self):
        for route in ("/", "/app/", "/os/", "/terms/", "/api/"):
            with self.subTest(route=route), self.get(route) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("text/html", response.headers["Content-Type"])
        for route in ("/", "/app/", "/os/"):
            with self.get(route) as response:
                html = response.read().decode()
            parser = Assets()
            parser.feed(html)
            for asset in parser.paths:
                url = urllib.parse.urljoin(route, asset)
                if urllib.parse.urlsplit(url).netloc:
                    continue
                with self.subTest(route=route, asset=url), self.get(url) as response:
                    self.assertEqual(response.status, 200)
                    response.read()
        for asset in ("/assets/mark.svg", "/assets/mech.jpg", "/assets/poster.jpg",
                      "/media/hero.mp4", "/connect-core.js", "/site-wallet.js",
                      "/desk.js?v=1.4.2", "/desk.css?v=1.4.2"):
            with self.subTest(asset=asset), self.get(asset) as response:
                self.assertEqual(response.status, 200)
                response.read()
        with self.get("/app") as response:
            self.assertTrue(response.url.endswith("/app/"))
        config = json.loads((ROOT / "vercel.json").read_text())
        self.assertIn({"source": "/app", "destination": "/app/", "permanent": True}, config["redirects"])

    def test_auth_is_not_rewritten_or_covered(self):
        self.assertEqual((OUT / "app/gate.js").read_bytes(), (ROOT / "website/app/gate.js").read_bytes())
        self.assertIn("window.turnstile.render", (OUT / "app/gate.js").read_text())
        self.assertNotIn("Valhalla read-only preview", (OUT / "errors.js").read_text())
        for name in (".env", "scripts", "src", "experimental", "experiments"):
            self.assertFalse((OUT / name).exists())
        self.assertIn('"/media/hero.mp4"', (OUT / "home-motion.js").read_text())

    def test_build_rejects_missing_entry_points_and_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            shutil.copytree(ROOT / "website", root / "website")
            (root / "website/.env").write_text("PRIVATE=fixture")
            build = root / "website/scripts/build-site.py"
            for name in ("index.html", "app/index.html", "app/gate.js",
                         "assets/mark.svg", "media/hero.mp4", "desk.js", "desk.css"):
                with self.subTest(missing=name):
                    source = root / "website" / name
                    backup = source.with_name(source.name + ".saved")
                    source.rename(backup)
                    result = subprocess.run([sys.executable, str(build)], capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    backup.rename(source)
            subprocess.run([sys.executable, str(build)], check=True)
            self.assertFalse((root / "site-build/.env").exists())


if __name__ == "__main__":
    unittest.main()
