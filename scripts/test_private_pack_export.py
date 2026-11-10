import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "export-private-citadel-pack.py"


class ExportTests(unittest.TestCase):
    def test_archive_drops_secrets_and_stays_out_of_the_site(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source = root / "pack"
            nested = source / "public" / "os"
            nested.mkdir(parents=True)
            (nested / "index.html").write_text("<p>workstation</p>")
            (source / ".env").write_text("TOKEN=secret")
            (source / ".env.local").write_text("LOCAL=secret")
            (source / "wallet.pem").write_text("-----BEGIN PRIVATE KEY-----\nabc\n")
            destination = root / "private-export" / "pack.tar.gz"
            subprocess.run([sys.executable, str(SCRIPT), str(source), str(destination)], check=True)
            with tarfile.open(destination) as archive:
                names = archive.getnames()
            self.assertTrue(any(name.endswith("public/os/index.html") for name in names))
            self.assertFalse(any(name.endswith(".env") or name.endswith(".pem") for name in names))
            self.assertNotIn("website", destination.parts)
            self.assertNotIn("site-build", destination.parts)
            self.assertEqual(os.stat(destination).st_mode & 0o777, 0o600)

    def test_refuses_public_destinations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source = root / "pack"
            source.mkdir()
            (source / "index.html").write_text("ok")
            for folder in ("website", "site-build"):
                with self.subTest(folder=folder):
                    target = root / folder / "pack.tar.gz"
                    result = subprocess.run([sys.executable, str(SCRIPT), str(source), str(target)], capture_output=True)
                    self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
