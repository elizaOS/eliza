from __future__ import annotations

import pytest

from .. import rust_ffi
from elizaos.types.components import ActionResult, ProviderResult


class _FakeRustPluginFFI:
    def __init__(self, lib_path: str) -> None:
        self._lib_path = lib_path

    def get_manifest(self) -> dict[str, object]:
        return {
            "name": "fake-rust",
            "description": "fake",
            "actions": [{"name": "DO", "description": "do it"}],
            "providers": [{"name": "PROV", "description": "p"}],
            "evaluators": [{"name": "EVAL", "description": "e"}],
        }

    def init(self, config: dict[str, str]) -> None:
        return None

    def validate_action(self, name: str, memory: object, state: object) -> bool:
        return name == "DO"

    def invoke_action(self, name: str, memory: object, state: object, options: object) -> object:
        return ActionResult(success=True, text=f"ok:{name}")

    def get_provider(self, name: str, memory: object, state: object) -> object:
        return ProviderResult(text=f"prov:{name}")

    def validate_evaluator(self, name: str, memory: object, state: object) -> bool:
        return name == "EVAL"

    def invoke_evaluator(self, name: str, memory: object, state: object) -> object:
        return ActionResult(success=True, text=f"eval:{name}")


@pytest.mark.asyncio
async def test_load_rust_plugin_produces_awaitable_handlers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rust_ffi, "RustPluginFFI", _FakeRustPluginFFI)

    plugin = rust_ffi.load_rust_plugin("fake.so")
    assert plugin.actions is not None
    assert plugin.providers is not None
    assert plugin.evaluators is not None

    action = plugin.actions[0]
    provider = plugin.providers[0]
    evaluator = plugin.evaluators[0]

    valid = await action.validate_fn(None, {"content": {}}, None)  # type: ignore[arg-type]
    assert valid is True

    result = await action.handler(None, {"content": {}}, None, None, None, None)  # type: ignore[arg-type]
    assert result is not None
    assert result.success is True
    assert result.text == "ok:DO"

    prov_result = await provider.get(None, {"content": {}}, {"values": {}, "data": {}, "text": ""})  # type: ignore[arg-type]
    assert prov_result.text == "prov:PROV"

    eval_valid = await evaluator.validate_fn(None, {"content": {}}, None)  # type: ignore[arg-type]
    assert eval_valid is True

    eval_result = await evaluator.handler(None, {"content": {}}, None, None, None, None)  # type: ignore[arg-type]
    assert eval_result is not None
    assert eval_result.text == "eval:EVAL"

