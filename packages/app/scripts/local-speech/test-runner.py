"""Consumer staging is separate from source and serialized across invocations."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class RunnerTest(unittest.TestCase):
    def test_staging_and_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'tooling'
            source.mkdir()
            shutil.copyfile(Path(__file__).with_name('run.py'), source / 'run.py')
            (source / 'verify-source.py').write_text(
                "from pathlib import Path\nimport time\n"
                "p=Path(__file__).with_name('counter');n=int(p.read_text()) if p.exists() else 0\n"
                "time.sleep(.1);p.write_text(str(n+1))\n")
            workspace = root / 'output'
            command = [sys.executable, str(source / 'run.py'), '--workspace', str(workspace), 'verify-source']
            processes = [subprocess.Popen(command) for _ in range(2)]
            for process in processes:
                self.assertEqual(process.wait(timeout=10), 0)
            self.assertEqual((workspace / 'counter').read_text(), '2')
            self.assertFalse((source / 'counter').exists())
            for forbidden in (source, source / 'nested', root):
                result = subprocess.run([sys.executable, str(source / 'run.py'), '--workspace', str(forbidden), 'verify-source'], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'separate from the pinned tooling source', result.stderr)


if __name__ == '__main__':
    unittest.main()
