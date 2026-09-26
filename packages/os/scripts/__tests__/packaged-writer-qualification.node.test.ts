import { execFileSync } from "node:child_process";
import test from "node:test";

test("descriptor sampling tolerates closed descriptors but preserves permission failures", () => {
  const harness = fileURLToPath(
    new URL(
      "../../usb-installer/native/qualify-raw-writer.py",
      import.meta.url,
    ),
  );
  execFileSync(
    "python3",
    [
      "-c",
      `
import importlib.util
from pathlib import Path
import sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("raw", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with patch.object(Path, "iterdir", return_value=iter([Path("/fake/3"), Path("/fake/4")])), patch.object(module.os, "readlink", side_effect=[FileNotFoundError(), "/dev/fixture"]):
    assert module.has_open_target(Path("/fake"), Path("/dev/fixture"))
with patch.object(Path, "iterdir", side_effect=FileNotFoundError()):
    assert not module.has_open_target(Path("/fake"), Path("/dev/fixture"))
with patch.object(Path, "iterdir", return_value=iter([Path("/fake/3")])), patch.object(module.os, "readlink", side_effect=PermissionError()):
    try:
        module.has_open_target(Path("/fake"), Path("/dev/fixture"))
    except PermissionError:
        pass
    else:
        raise AssertionError("permission failure hidden")
`,
      harness,
    ],
    { stdio: "pipe" },
  );
});

import { fileURLToPath } from "node:url";

test("packaged-writer qualification uses supplied bytes and rejects guest identity drift", () => {
  const harness = fileURLToPath(
    new URL(
      "../../usb-installer/native/qualify-raw-writer-vm.py",
      import.meta.url,
    ),
  );
  execFileSync(
    "python3",
    [
      "-c",
      String.raw`
import importlib.util
import hashlib
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("qualification", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    helper = root / "packaged-helper"
    helper.write_bytes(b"packaged writer fixture")
    expected = hashlib.sha256(helper.read_bytes()).hexdigest()
    arguments = ["qualify", "--base-image", str(root / "base"), "--node", str(root / "node"),
                 "--output-dir", str(root / "output"), "--pipeline-bundle", str(root / "pipeline"),
                 "--packaged-helper", str(helper)]
    def guest(args, sources, script, evidence, serial, inputs):
        assert inputs["packaged-raw-writer"] == helper
        assert "install -Dm755 /inputs/packaged-raw-writer" in script
        assert "bash /root/usb-installer/native/build-raw-writer.sh" not in script
        directory = args.output_dir / "evidence"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "writer-sha256.txt").write_text(observed + "  /usr/libexec/elizaos-linux-raw-writer\n")
    with patch.object(sys, "argv", arguments), patch.object(module.disk_vm, "run", guest):
        observed = expected
        module.main()
        observed = "0" * 64
        try:
            module.main()
        except RuntimeError as error:
            assert "differs" in str(error)
        else:
            raise AssertionError("guest hash mismatch was accepted")
`,
      harness,
    ],
    { stdio: "pipe" },
  );
});
