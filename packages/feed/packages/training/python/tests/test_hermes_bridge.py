from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "training"))

from hermes_bridge import HermesBridgeClient, default_bridge_script, default_hermes_root


def test_hermes_bridge_client_round_trip(tmp_path: Path):
    fake_bridge = tmp_path / "fake_bridge.py"
    fake_bridge.write_text(
        "\n".join(
            [
                "import os",
                "import json",
                "import sys",
                "for line in sys.stdin:",
                "    payload = json.loads(line)",
                "    if payload.get('type') == 'close':",
                "        print(json.dumps({'ok': True, 'closed': True}), flush=True)",
                "        break",
                "    print(json.dumps({'ok': True, 'finalResponse': payload['userMessage'][::-1], 'cwd': os.getcwd()}), flush=True)",
            ]
        ),
        encoding="utf-8",
    )

    with HermesBridgeClient(
        model="fake-model",
        base_url="http://127.0.0.1:9999/v1",
        hermes_root=tmp_path,
        python_executable=sys.executable,
        bridge_script=fake_bridge,
    ) as client:
        client._ensure_process()
        response = client._round_trip(
            {
                "type": "complete",
                "systemMessage": "Return JSON.",
                "userMessage": "abcdef",
                "conversationHistory": [],
            }
        )

    assert response["finalResponse"] == "fedcba"
    assert Path(response["cwd"]).samefile(tmp_path)


def test_hermes_bridge_client_uses_parser_defaults_for_no_tools():
    hermes_root = default_hermes_root()
    client = HermesBridgeClient(
        model="fake-model",
        base_url="http://127.0.0.1:9999/v1",
        hermes_root=hermes_root,
        python_executable=sys.executable,
        bridge_script=default_bridge_script(hermes_root),
    )

    assert "--no-tools" not in client._command
    assert "--no-skip-memory" not in client._command
