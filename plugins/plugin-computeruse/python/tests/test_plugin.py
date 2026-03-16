from __future__ import annotations

import pytest

from elizaos_plugin_computeruse import ComputerUseConfig, ComputerUseMode, create_computeruse_plugin


class _FakeMcpToolResult:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def model_dump(self) -> dict[str, object]:
        return self._payload


class _FakeMcpClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def call_tool(self, tool_name: str, tool_args: dict[str, object]) -> _FakeMcpToolResult:
        self.calls.append((tool_name, tool_args))
        return _FakeMcpToolResult({"tool": tool_name, "args": tool_args})

    async def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_init_disabled_is_noop() -> None:
    cfg = ComputerUseConfig(enabled=False, mode=ComputerUseMode.AUTO)
    plugin = create_computeruse_plugin(cfg)
    await plugin.init()
    assert plugin.backend is None


@pytest.mark.asyncio
async def test_local_mode_errors_when_module_unavailable() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.LOCAL)
    plugin = create_computeruse_plugin(cfg)

    # All platforms support local mode now, but will error if computeruse module not installed
    with pytest.raises((RuntimeError, ModuleNotFoundError)):
        await plugin.init()


@pytest.mark.asyncio
async def test_mcp_action_argument_shapes() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    fake = _FakeMcpClient()
    plugin.backend = "mcp"
    plugin._mcp = fake

    res = await plugin.handle_action(
        "COMPUTERUSE_CLICK",
        {"process": "notepad", "selector": "role:Button|name:Save", "timeoutMs": 123},
    )
    assert res["success"] is True
    assert fake.calls[0][0] == "click_element"
    assert fake.calls[0][1]["process"] == "notepad"
    assert fake.calls[0][1]["selector"] == "role:Button|name:Save"
    assert fake.calls[0][1]["timeout_ms"] == 123
    assert fake.calls[0][1]["verify_element_exists"] == ""
    assert fake.calls[0][1]["highlight_before_action"] is False

    res2 = await plugin.handle_action(
        "COMPUTERUSE_TYPE",
        {
            "selector": "process:notepad >> role:Edit|name:Search",
            "text": "hello",
            "timeoutMs": 5000,
            "clearBeforeTyping": True,
        },
    )
    assert res2["success"] is True
    assert fake.calls[1][0] == "type_into_element"
    assert fake.calls[1][1]["process"] == "notepad"
    assert fake.calls[1][1]["selector"] == "role:Edit|name:Search"
    assert fake.calls[1][1]["text_to_type"] == "hello"

    res3 = await plugin.handle_action("COMPUTERUSE_OPEN_APPLICATION", {"name": "notepad"})
    assert res3["success"] is True
    assert fake.calls[2][0] == "open_application"
    assert fake.calls[2][1]["app_name"] == "notepad"
    assert fake.calls[2][1]["verify_element_exists"] == ""
    assert fake.calls[2][1]["include_tree_after_action"] is False

    res4 = await plugin.handle_action(
        "COMPUTERUSE_GET_WINDOW_TREE",
        {"process": "notepad", "title": "Untitled", "maxDepth": 3},
    )
    assert res4["success"] is True
    assert fake.calls[3][0] == "get_window_tree"
    assert fake.calls[3][1]["process"] == "notepad"
    assert fake.calls[3][1]["title"] == "Untitled"
    assert fake.calls[3][1]["include_tree_after_action"] is True
    assert fake.calls[3][1]["tree_max_depth"] == 3


# ---------------------------------------------------------------------------
# Action handler tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_action_disabled_returns_error() -> None:
    cfg = ComputerUseConfig(enabled=False, mode=ComputerUseMode.AUTO)
    plugin = create_computeruse_plugin(cfg)
    res = await plugin.handle_action("COMPUTERUSE_CLICK", {"selector": "role:Button"})
    assert res["success"] is False
    assert "disabled" in str(res.get("error", "")).lower()


@pytest.mark.asyncio
async def test_handle_action_unknown_action() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    plugin.backend = "mcp"
    plugin._mcp = _FakeMcpClient()
    res = await plugin.handle_action("COMPUTERUSE_FLY_TO_MOON", {})
    assert res["success"] is False
    assert "Unknown" in str(res.get("error", ""))


@pytest.mark.asyncio
async def test_click_missing_selector() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    plugin.backend = "mcp"
    plugin._mcp = _FakeMcpClient()
    res = await plugin.handle_action("COMPUTERUSE_CLICK", {})
    assert res["success"] is False
    assert "selector" in str(res.get("error", "")).lower()


@pytest.mark.asyncio
async def test_click_missing_process_in_mcp_mode() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    plugin.backend = "mcp"
    plugin._mcp = _FakeMcpClient()
    res = await plugin.handle_action(
        "COMPUTERUSE_CLICK",
        {"selector": "role:Button|name:Save"},  # no process, no process: prefix
    )
    assert res["success"] is False
    assert "process" in str(res.get("error", "")).lower()


@pytest.mark.asyncio
async def test_type_missing_text() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    plugin.backend = "mcp"
    plugin._mcp = _FakeMcpClient()
    res = await plugin.handle_action(
        "COMPUTERUSE_TYPE",
        {"selector": "process:notepad >> role:Edit"},
    )
    assert res["success"] is False
    assert "text" in str(res.get("error", "")).lower()


@pytest.mark.asyncio
async def test_open_application_missing_name() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    plugin.backend = "mcp"
    plugin._mcp = _FakeMcpClient()
    res = await plugin.handle_action("COMPUTERUSE_OPEN_APPLICATION", {})
    assert res["success"] is False
    assert "name" in str(res.get("error", "")).lower()


@pytest.mark.asyncio
async def test_open_application_empty_name() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    plugin.backend = "mcp"
    plugin._mcp = _FakeMcpClient()
    res = await plugin.handle_action("COMPUTERUSE_OPEN_APPLICATION", {"name": "  "})
    assert res["success"] is False


@pytest.mark.asyncio
async def test_get_window_tree_missing_process() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    plugin.backend = "mcp"
    plugin._mcp = _FakeMcpClient()
    res = await plugin.handle_action("COMPUTERUSE_GET_WINDOW_TREE", {})
    assert res["success"] is False
    assert "process" in str(res.get("error", "")).lower()


@pytest.mark.asyncio
async def test_get_applications_via_mcp() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    fake = _FakeMcpClient()
    plugin.backend = "mcp"
    plugin._mcp = fake

    res = await plugin.handle_action("COMPUTERUSE_GET_APPLICATIONS", {})
    assert res["success"] is True
    assert fake.calls[0][0] == "get_applications_and_windows_list"


@pytest.mark.asyncio
async def test_click_with_process_prefix_selector() -> None:
    """Test that a selector with 'process:app >> ...' extracts process properly."""
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    fake = _FakeMcpClient()
    plugin.backend = "mcp"
    plugin._mcp = fake

    res = await plugin.handle_action(
        "COMPUTERUSE_CLICK",
        {"selector": "process:chrome >> role:Button|name:Submit", "timeoutMs": 3000},
    )
    assert res["success"] is True
    assert fake.calls[0][1]["process"] == "chrome"
    assert fake.calls[0][1]["selector"] == "role:Button|name:Submit"
    assert fake.calls[0][1]["timeout_ms"] == 3000


@pytest.mark.asyncio
async def test_type_clears_before_typing_by_default() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    fake = _FakeMcpClient()
    plugin.backend = "mcp"
    plugin._mcp = fake

    await plugin.handle_action(
        "COMPUTERUSE_TYPE",
        {"selector": "process:notepad >> role:Edit", "text": "hello"},
    )
    assert fake.calls[0][1]["clear_before_typing"] is True


@pytest.mark.asyncio
async def test_click_invalid_timeout_uses_default() -> None:
    cfg = ComputerUseConfig(enabled=True, mode=ComputerUseMode.MCP)
    plugin = create_computeruse_plugin(cfg)
    fake = _FakeMcpClient()
    plugin.backend = "mcp"
    plugin._mcp = fake

    await plugin.handle_action(
        "COMPUTERUSE_CLICK",
        {"process": "notepad", "selector": "role:Button", "timeoutMs": -1},
    )
    assert fake.calls[0][1]["timeout_ms"] == 5000
