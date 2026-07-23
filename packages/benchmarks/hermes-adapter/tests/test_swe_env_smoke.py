import sys
import types

from hermes_adapter import swe_env_smoke
from hermes_adapter.swe_env_smoke import _extract_python


def test_openclaw_swe_factory_keeps_native_transport(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeOpenClawClient:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

        def wait_until_ready(self, timeout: float) -> None:
            captured["readiness_timeout"] = timeout

    package = types.ModuleType("openclaw_adapter")
    client_module = types.ModuleType("openclaw_adapter.client")
    client_module.OpenClawClient = FakeOpenClawClient
    monkeypatch.setitem(sys.modules, "openclaw_adapter", package)
    monkeypatch.setitem(sys.modules, "openclaw_adapter.client", client_module)

    client, server = swe_env_smoke._build_client(
        harness="openclaw",
        provider="claude-subscription",
        model="claude-opus-4-6",
    )

    assert isinstance(client, FakeOpenClawClient)
    assert server is None
    assert captured == {
        "provider": "claude-subscription",
        "model": "claude-opus-4-6",
        "readiness_timeout": 60,
    }


def test_extract_python_preserves_prompt_imports_for_fenced_function_response() -> None:
    prompt = (
        "Complete the function.\n\n"
        "from typing import List\n\n"
        "def has_close_elements(numbers: List[float], threshold: float) -> bool:\n"
    )
    response = (
        "```python\n"
        "def has_close_elements(numbers: List[float], threshold: float) -> bool:\n"
        "    return False\n"
        "```"
    )

    code = _extract_python(response, prompt=prompt)

    assert code.startswith("from typing import List\n")
    assert "def has_close_elements" in code


def test_extract_python_strips_unterminated_opening_fence() -> None:
    code = _extract_python("```python\ndef answer():\n    return 1")

    assert code == "def answer():\n    return 1\n"


def test_humanevalpack_source_and_evaluator_are_pinned() -> None:
    assert swe_env_smoke._DATASET_COUNT == 164
    assert swe_env_smoke._DATASET_REVISION == (
        "9a41762f73a8cb23bb5811b73d5aab164efcf378"
    )
    assert swe_env_smoke._DATASET_FINGERPRINT == "4af2168c2e5536b9"
    assert "@sha256:" in swe_env_smoke._EVALUATOR_IMAGE


def test_candidate_executes_in_pinned_docker_sandbox() -> None:
    ok, error = swe_env_smoke._execute_candidate(
        candidate_code="def add(a, b):\n    return a + b\n",
        item={"test": "assert add(1, 2) == 3"},
        timeout_s=30,
    )

    assert ok is True
    assert error is None
