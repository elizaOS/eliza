import json
import os
from pathlib import Path
import subprocess
import sys


SCRIPT = Path(__file__).resolve().parents[3] / "scripts/eliza-1/harness_runner.py"


def test_native_route_retains_process_receipts_and_isolates_cases(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / "auth.json").write_text("{}")
    binary = tmp_path / "fixture-codex"
    binary.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
prompt = json.load(sys.stdin)
assert sys.argv[sys.argv.index("--sandbox") + 1] == "read-only"
assert len(prompt["messages"]) == 1
print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":'{"shouldRespond":"RESPOND"}'}}))
print(json.dumps({"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4}}))
''')
    binary.chmod(0o755)
    report = tmp_path / "out/report.json"
    result = subprocess.run([sys.executable, str(SCRIPT), "--harness", "codex", "--model", "fixture", "--codex-home", str(home), "--out", str(report), "--limit", "3"], env={**os.environ, "BENCHMARK_MODEL_PROVIDER":"codex-native", "CODEX_BIN":str(binary)}, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    data = json.loads(report.read_text())
    assert len(data["cases"]) == 3
    assert data["execution"]["provider_label"] == "codex-native"
    assert data["execution"]["provider_observed"] is None
    receipts = list((report.parent / "codex/attempts").glob("*/attempt.json"))
    workspaces = list((report.parent / "codex/workspaces").iterdir())
    assert len(receipts) == len(workspaces) == 3
    for path in receipts:
        receipt = json.loads(path.read_text())
        assert receipt["status"] == "succeeded"
        assert receipt["response"]["params"]["usage"]["output_tokens"] == 4
        assert "expected_label" not in json.dumps(receipt["context"])


def test_native_route_rejects_api_provider_mislabel_before_execution(tmp_path):
    result = subprocess.run([sys.executable, str(SCRIPT), "--harness", "codex", "--out", str(tmp_path / "report.json")], env={**os.environ, "BENCHMARK_MODEL_PROVIDER":"cerebras"}, capture_output=True, text=True, timeout=30)
    assert result.returncode != 0
    assert "requires provider codex-native" in result.stderr
    assert not (tmp_path / "codex").exists()
