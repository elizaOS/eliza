"""The removed direct-provider path must not bypass native Hermes."""

from pathlib import Path

import pytest
from hermes_adapter import HermesClient


def test_legacy_in_process_path_fails_closed(tmp_path: Path) -> None:
    client = HermesClient(
        repo_path=tmp_path,
        mode="in_process",
        base_url="http://127.0.0.1:8765/v1",
        api_key="benchmark-token",
    )
    probe = client.health()
    assert probe["status"] == "error"
    assert probe["publishable_native"] is False
    with pytest.raises(RuntimeError, match="nonpublishable legacy path"):
        client.send_message("hello")
