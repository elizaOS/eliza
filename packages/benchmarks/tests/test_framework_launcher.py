"""Exercise the shell boundary without running or paying for a model."""

import json
import os
from pathlib import Path
import subprocess

import pytest


@pytest.mark.parametrize("exit_code", [0, 17])
def test_framework_launcher_preserves_arguments_and_fails_before_comparison(tmp_path: Path, exit_code: int):
    executable = tmp_path / "bin" / "bun"
    executable.parent.mkdir()
    calls = tmp_path / "calls.jsonl"
    executable.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "with open(os.environ['FRAMEWORK_TEST_CALLS'], 'a') as stream: stream.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        "raise SystemExit(int(os.environ['FRAMEWORK_TEST_EXIT']) if sys.argv[2].endswith('bench.ts') else 0)\n"
    )
    executable.chmod(0o755)
    output = tmp_path / "output with spaces" / "current.json"
    output.parent.mkdir()
    (output.parent / "typescript-old.json").write_text('{}')
    script = Path(__file__).resolve().parents[1] / "framework" / "run.sh"
    result = subprocess.run(
        ["bash", str(script), "--iterations=1", "--warmup=0", "--scenarios=with space", f"--output={output}"],
        cwd=tmp_path, env={**os.environ, "PATH": f"{executable.parent}{os.pathsep}{os.environ['PATH']}",
                           "FRAMEWORK_TEST_CALLS": str(calls), "FRAMEWORK_TEST_EXIT": str(exit_code)},
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == exit_code
    invocations = [json.loads(line) for line in calls.read_text().splitlines()]
    assert invocations[0] == ["run", "src/bench.ts", "--iterations=1", "--warmup=0", "--scenarios=with space", f"--output={output}"]
    assert len(invocations) == (1 if exit_code else 2)
    if not exit_code:
        assert invocations[1][-1] == f"--file={output}"
