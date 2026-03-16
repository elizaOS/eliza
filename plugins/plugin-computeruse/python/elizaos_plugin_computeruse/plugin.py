from __future__ import annotations

import os
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from elizaos_plugin_mcp.client import McpClient
from elizaos_plugin_mcp.transports.stdio import StdioTransport
from elizaos_plugin_mcp.types import McpToolResult

from elizaos_plugin_computeruse.types import ComputerUseConfig, ComputerUseMode


class LocatorLike(Protocol):
    def wait(self, timeout_ms: int | None = None) -> Awaitable[ElementLike]: ...


class ElementLike(Protocol):
    def click(self) -> object: ...
    def type_text(self, text: str, use_clipboard: bool | None = None) -> object: ...
    def set_value(self, value: str) -> object: ...
    def name(self) -> str: ...
    def process_id(self) -> int: ...


class DesktopLike(Protocol):
    def open_application(self, name: str) -> object: ...
    def application(self, name: str) -> ElementLike: ...
    def locator(self, selector: str) -> LocatorLike: ...
    def applications(self) -> list[ElementLike]: ...
    def get_window_tree(
        self, pid: int, title: str | None = None, config: object | None = None
    ) -> object: ...


def _split_process_selector(selector: str, process_hint: str | None) -> tuple[str | None, str]:
    # Accept either:
    # - explicit process param + selector ("role:Button|name:Save")
    # - embedded process prefix ("process:notepad >> role:Button|name:Save")
    m = re.match(r"^\s*process:(?P<process>[^\s>]+)\s*(?:>>\s*(?P<sel>.*))?$", selector)
    if m:
        proc = m.group("process")
        sel = (m.group("sel") or "").strip()
        return proc, sel
    return process_hint, selector.strip()


@dataclass
class ComputerUsePlugin:
    name: str = "plugin-computeruse"
    description: str = "Computer automation plugin (local or MCP)"
    config: ComputerUseConfig = field(default_factory=ComputerUseConfig)
    _desktop: DesktopLike | None = None  # computeruse.Desktop when available
    _mcp: McpClient | None = None
    backend: str | None = None

    actions: dict[str, Callable[[dict[str, object]], Awaitable[dict[str, object]]]] = field(
        default_factory=dict
    )

    def __post_init__(self) -> None:
        self.actions = {
            "COMPUTERUSE_OPEN_APPLICATION": self._open_application,
            "COMPUTERUSE_CLICK": self._click,
            "COMPUTERUSE_TYPE": self._type,
            "COMPUTERUSE_GET_APPLICATIONS": self._get_applications,
            "COMPUTERUSE_GET_WINDOW_TREE": self._get_window_tree,
        }

    async def init(self) -> None:
        # Env overrides (mirrors TS behavior)
        enabled_env = os.getenv("COMPUTERUSE_ENABLED")
        if enabled_env is not None:
            self.config.enabled = enabled_env.strip().lower() == "true"

        mode_env = os.getenv("COMPUTERUSE_MODE")
        if mode_env is not None:
            self.config.mode = (
                ComputerUseMode.LOCAL
                if mode_env == "local"
                else ComputerUseMode.MCP
                if mode_env == "mcp"
                else ComputerUseMode.AUTO
            )

        cmd_env = os.getenv("COMPUTERUSE_MCP_COMMAND")
        if cmd_env:
            self.config.mcp_command = cmd_env

        args_env = os.getenv("COMPUTERUSE_MCP_ARGS")
        if args_env:
            parts = [p for p in args_env.split() if p]
            if parts:
                self.config.mcp_args = parts

        if not self.config.enabled:
            self.backend = None
            return

        if self.config.mode == ComputerUseMode.LOCAL:
            await self._ensure_local()
            self.backend = "local"
            return

        if self.config.mode == ComputerUseMode.MCP:
            await self._ensure_mcp()
            self.backend = "mcp"
            return

        # auto - try local on all platforms, fall back to MCP
        try:
            await self._ensure_local()
            self.backend = "local"
            return
        except Exception:
            await self._ensure_mcp()
            self.backend = "mcp"
            return

    async def stop(self) -> None:
        if self._mcp is not None:
            try:
                await self._mcp.close()
            finally:
                self._mcp = None
        self._desktop = None
        self.backend = None

    async def handle_action(self, action_name: str, args: dict[str, object]) -> dict[str, object]:
        if not self.config.enabled:
            return {"success": False, "error": "ComputerUse disabled"}
        if action_name not in self.actions:
            return {"success": False, "error": f"Unknown action: {action_name}"}
        return await self.actions[action_name](args)

    async def _ensure_local(self) -> None:
        if self._desktop is not None:
            return
        import computeruse  # type: ignore[import-not-found]

        self._desktop = computeruse.Desktop()

    async def _ensure_mcp(self) -> None:
        if self._mcp is not None:
            return
        transport = StdioTransport(command=self.config.mcp_command, args=self.config.mcp_args)
        client = McpClient(transport)
        await client.connect()
        self._mcp = client

    async def _open_application(self, args: dict[str, object]) -> dict[str, object]:
        name = args.get("name")
        if not isinstance(name, str) or not name.strip():
            return {"success": False, "error": "Missing name"}

        if self.backend == "local":
            await self._ensure_local()
            desktop = self._desktop
            if desktop is None:
                return {"success": False, "error": "Local desktop not initialized"}
            desktop.open_application(name)
            return {"success": True}

        await self._ensure_mcp()
        if self._mcp is None:
            return {"success": False, "error": "MCP client not initialized"}
        result: McpToolResult = await self._mcp.call_tool(
            "open_application",
            {
                "app_name": name,
                "verify_element_exists": "",
                "verify_element_not_exists": "",
                "include_tree_after_action": False,
            },
        )
        return {"success": True, "result": result.model_dump()}

    async def _click(self, args: dict[str, object]) -> dict[str, object]:
        selector = args.get("selector")
        process = args.get("process")
        timeout_ms = args.get("timeoutMs", 5000)
        if not isinstance(selector, str) or not selector.strip():
            return {"success": False, "error": "Missing selector"}
        if process is not None and not isinstance(process, str):
            process = None
        if not isinstance(timeout_ms, int) or timeout_ms < 0:
            timeout_ms = 5000

        if self.backend == "local":
            await self._ensure_local()
            desktop = self._desktop
            if desktop is None:
                return {"success": False, "error": "Local desktop not initialized"}
            locator = desktop.locator(selector)
            element = await locator.wait(timeout_ms)
            element.click()
            return {"success": True}

        await self._ensure_mcp()
        if self._mcp is None:
            return {"success": False, "error": "MCP client not initialized"}
        proc, sel = _split_process_selector(selector, process)
        if not proc:
            return {
                "success": False,
                "error": "Missing process. Provide args.process or prefix selector with 'process:<name> >> ...'",
            }
        result = await self._mcp.call_tool(
            "click_element",
            {
                "process": proc,
                "selector": sel,
                "timeout_ms": timeout_ms,
                "verify_element_exists": "",
                "verify_element_not_exists": "",
                "highlight_before_action": False,
                "ui_diff_before_after": False,
            },
        )
        return {"success": True, "result": result.model_dump()}

    async def _type(self, args: dict[str, object]) -> dict[str, object]:
        selector = args.get("selector")
        process = args.get("process")
        text = args.get("text")
        timeout_ms = args.get("timeoutMs", 5000)
        clear = args.get("clearBeforeTyping", True)

        if not isinstance(selector, str) or not selector.strip():
            return {"success": False, "error": "Missing selector"}
        if process is not None and not isinstance(process, str):
            process = None
        if not isinstance(text, str):
            return {"success": False, "error": "Missing text"}
        if not isinstance(timeout_ms, int) or timeout_ms < 0:
            timeout_ms = 5000
        if not isinstance(clear, bool):
            clear = True

        if self.backend == "local":
            await self._ensure_local()
            desktop = self._desktop
            if desktop is None:
                return {"success": False, "error": "Local desktop not initialized"}
            locator = desktop.locator(selector)
            element = await locator.wait(timeout_ms)
            if clear:
                element.set_value("")
            element.type_text(text, use_clipboard=False)
            return {"success": True}

        await self._ensure_mcp()
        if self._mcp is None:
            return {"success": False, "error": "MCP client not initialized"}
        proc, sel = _split_process_selector(selector, process)
        if not proc:
            return {
                "success": False,
                "error": "Missing process. Provide args.process or prefix selector with 'process:<name> >> ...'",
            }
        result = await self._mcp.call_tool(
            "type_into_element",
            {
                "process": proc,
                "selector": sel,
                "text_to_type": text,
                "clear_before_typing": clear,
                "timeout_ms": timeout_ms,
                "highlight_before_action": False,
                "ui_diff_before_after": False,
            },
        )
        return {"success": True, "result": result.model_dump()}

    async def _get_applications(self, _args: dict[str, object]) -> dict[str, object]:
        if self.backend == "local":
            await self._ensure_local()
            desktop = self._desktop
            if desktop is None:
                return {"success": False, "error": "Local desktop not initialized"}
            apps = desktop.applications()
            names: list[str] = []
            for app in apps:
                n = app.name()
                if isinstance(n, str) and n.strip():
                    names.append(n)
            return {"success": True, "apps": names}

        await self._ensure_mcp()
        if self._mcp is None:
            return {"success": False, "error": "MCP client not initialized"}
        result = await self._mcp.call_tool("get_applications_and_windows_list", {})
        return {"success": True, "result": result.model_dump()}

    async def _get_window_tree(self, args: dict[str, object]) -> dict[str, object]:
        process = args.get("process")
        title = args.get("title")
        max_depth = args.get("maxDepth")

        if not isinstance(process, str) or not process.strip():
            return {"success": False, "error": "Missing process"}
        if title is not None and not isinstance(title, str):
            title = None
        if max_depth is not None and not isinstance(max_depth, int):
            max_depth = None

        if self.backend == "local":
            await self._ensure_local()
            desktop = self._desktop
            if desktop is None:
                return {"success": False, "error": "Local desktop not initialized"}
            app = desktop.application(process)
            pid = app.process_id()
            tree = desktop.get_window_tree(pid, title=title, config=None)
            return {"success": True, "pid": pid, "tree": tree}

        await self._ensure_mcp()
        if self._mcp is None:
            return {"success": False, "error": "MCP client not initialized"}
        result = await self._mcp.call_tool(
            "get_window_tree",
            {
                "process": process,
                "title": title,
                "include_tree_after_action": True,
                "tree_max_depth": max_depth,
            },
        )
        return {"success": True, "result": result.model_dump()}


def create_computeruse_plugin(config: ComputerUseConfig | None = None) -> ComputerUsePlugin:
    return ComputerUsePlugin(config=config or ComputerUseConfig())
