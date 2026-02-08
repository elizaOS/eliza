"""
TypeScript Plugin Bridge for elizaOS

This module provides utilities for loading TypeScript plugins into the Python runtime
via subprocess IPC communication.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path
from typing import Callable, Awaitable

from elizaos.types.plugin import Plugin
from elizaos.types.memory import Memory
from elizaos.types.state import State
from elizaos.types.components import (
    Action,
    ActionResult,
    Provider,
    ProviderResult,
    Evaluator,
    HandlerOptions,
)


class TypeScriptPluginBridge:
    """
    IPC bridge for loading TypeScript plugins in Python.

    Spawns a Node.js subprocess that loads the TypeScript plugin and
    communicates via JSON-RPC over stdin/stdout.
    """

    def __init__(
        self,
        plugin_path: str | Path,
        *,
        node_path: str = "node",
        cwd: str | Path | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 30.0,
        inherit_env: bool = True,
        env_denylist: list[str] | None = None,
        max_pending_requests: int = 1000,
        max_message_bytes: int = 1_000_000,
        max_buffer_bytes: int = 2_000_000,
    ) -> None:
        """
        Initialize the TypeScript plugin bridge.

        Args:
            plugin_path: Path to the TypeScript plugin (directory or entry file).
            node_path: Path to Node.js executable (defaults to 'node').
            cwd: Working directory for the subprocess.
            env: Additional environment variables.
            timeout: Request timeout in seconds.
        """
        self.plugin_path = Path(plugin_path)
        self.node_path = node_path
        self.cwd = Path(cwd) if cwd else self.plugin_path.parent
        base_env: dict[str, str] = dict(os.environ) if inherit_env else {}
        if env_denylist:
            for key in env_denylist:
                base_env.pop(key, None)
        if env:
            base_env.update(env)
        # Also pass sizing limits to the runner so it can fail-closed.
        base_env.setdefault("ELIZA_INTEROP_MAX_MESSAGE_BYTES", str(max_message_bytes))
        base_env.setdefault("ELIZA_INTEROP_MAX_BUFFER_BYTES", str(max_buffer_bytes))
        self.env = base_env
        self.timeout = timeout
        self.max_pending_requests = max_pending_requests
        self.max_message_bytes = max_message_bytes
        self.max_buffer_bytes = max_buffer_bytes

        self.process: subprocess.Popen[bytes] | None = None
        self.manifest: dict[str, object] | None = None
        self._request_counter = 0
        self._pending_requests: dict[str, asyncio.Future[dict[str, object]]] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._buffer = ""

    async def start(self) -> None:
        """Start the TypeScript bridge subprocess."""
        bridge_script = self._get_bridge_script()

        self.process = subprocess.Popen(
            [self.node_path, bridge_script, str(self.plugin_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(self.cwd),
            env=self.env,
        )

        # Start the reader task
        self._reader_task = asyncio.create_task(self._read_responses())
        self._stderr_task = asyncio.create_task(self._drain_stderr())

        # Wait for ready message with manifest
        await self._wait_for_ready()

    def _get_bridge_script(self) -> str:
        """Get the path to the TypeScript bridge script."""
        script_dir = Path(__file__).parent
        bridge_path = script_dir / "ts_bridge_runner.mjs"
        if not bridge_path.exists():
            raise FileNotFoundError(f"Missing bridge runner: {bridge_path}")
        return str(bridge_path)

    async def _read_responses(self) -> None:
        """Read responses from the subprocess stdout."""
        if not self.process or not self.process.stdout:
            return

        loop = asyncio.get_event_loop()

        while True:
            try:
                line = await loop.run_in_executor(
                    None, self.process.stdout.readline
                )
                if not line:
                    break

                line_str = line.decode("utf-8").strip()
                if not line_str:
                    continue
                if len(line) > self.max_message_bytes:
                    raise RuntimeError("Subprocess output exceeded maximum message size")

                message = json.loads(line_str)
                self._handle_message(message)
            except json.JSONDecodeError as e:
                # Protocol violation: fail closed.
                await self.stop()
                raise RuntimeError("Invalid JSON received from subprocess") from e

    async def _drain_stderr(self) -> None:
        if not self.process or not self.process.stderr:
            return
        loop = asyncio.get_event_loop()
        while True:
            line = await loop.run_in_executor(None, self.process.stderr.readline)
            if not line:
                break
            # Drain to avoid deadlock; stderr content may be sensitive.
            # In production, route to a controlled logger sink if desired.
            _ = line

    def _handle_message(self, message: dict[str, object]) -> None:
        """Handle an incoming message from the subprocess."""
        msg_id = message.get("id")

        if msg_id and msg_id in self._pending_requests:
            future = self._pending_requests.pop(msg_id)
            if not future.done():
                if message.get("type") == "error":
                    future.set_exception(Exception(message.get("error", "Unknown error")))
                else:
                    future.set_result(message)

    async def _wait_for_ready(self) -> None:
        """Wait for the ready message from the subprocess."""
        if not self.process or not self.process.stdout:
            raise RuntimeError("Process not started")

        loop = asyncio.get_event_loop()

        try:
            line = await asyncio.wait_for(
                loop.run_in_executor(None, self.process.stdout.readline),
                timeout=self.timeout,
            )
            if not line:
                raise RuntimeError("Process exited before sending ready message")

            message = json.loads(line.decode("utf-8"))
            if message.get("type") != "ready":
                raise RuntimeError(f"Unexpected first message: {message.get('type')}")

            self.manifest = message.get("manifest")
        except asyncio.TimeoutError:
            raise RuntimeError(f"Plugin startup timeout after {self.timeout}s")

    async def send_request(self, request: dict[str, object]) -> dict[str, object]:
        """Send a request and wait for the response."""
        if not self.process or not self.process.stdin:
            raise RuntimeError("Bridge not started")

        if len(self._pending_requests) >= self.max_pending_requests:
            raise RuntimeError("Too many pending requests")

        self._request_counter += 1
        request_id = f"req_{self._request_counter}"
        request["id"] = request_id

        future: asyncio.Future[dict[str, object]] = asyncio.get_event_loop().create_future()
        self._pending_requests[request_id] = future

        json_line = json.dumps(request) + "\n"
        self.process.stdin.write(json_line.encode("utf-8"))
        self.process.stdin.flush()

        try:
            return await asyncio.wait_for(future, timeout=self.timeout)
        except asyncio.TimeoutError:
            self._pending_requests.pop(request_id, None)
            raise RuntimeError(f"Request timeout for {request.get('type')}")

    async def stop(self) -> None:
        """Stop the TypeScript bridge subprocess."""
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass

        if self._stderr_task:
            self._stderr_task.cancel()
            try:
                await self._stderr_task
            except asyncio.CancelledError:
                pass

        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()

        for fut in self._pending_requests.values():
            if not fut.done():
                fut.set_exception(RuntimeError("Bridge stopped"))
        self._pending_requests.clear()

    def get_manifest(self) -> dict[str, Any] | None:
        """Get the plugin manifest."""
        return self.manifest


async def load_typescript_plugin(
    plugin_path: str | Path,
    *,
    node_path: str = "node",
    cwd: str | Path | None = None,
    timeout: float = 30.0,
) -> Plugin:
    """
    Load a TypeScript plugin and return an elizaOS Plugin interface.

    Args:
        plugin_path: Path to the TypeScript plugin.
        node_path: Path to Node.js executable.
        cwd: Working directory for the subprocess.
        timeout: Request timeout in seconds.

    Returns:
        elizaOS Plugin instance.
    """
    bridge = TypeScriptPluginBridge(
        plugin_path,
        node_path=node_path,
        cwd=cwd,
        timeout=timeout,
    )
    await bridge.start()

    manifest = bridge.get_manifest()
    if not manifest:
        raise RuntimeError("Failed to get plugin manifest")

    # Create action wrappers
    actions: list[Action] = []
    for action_def in manifest.get("actions", []):
        action_name = action_def["name"]

        def make_validate(name: str, b: TypeScriptPluginBridge) -> Callable[..., Awaitable[bool]]:
            async def validate(runtime: Any, message: Memory, state: State | None) -> bool:
                response = await b.send_request({
                    "type": "action.validate",
                    "action": name,
                    "memory": message.model_dump() if hasattr(message, "model_dump") else message,
                    "state": state.model_dump() if state and hasattr(state, "model_dump") else state,
                })
                return response.get("valid", False)
            return validate

        def make_handler(
            name: str, b: TypeScriptPluginBridge
        ) -> Callable[..., Awaitable[ActionResult | None]]:
            async def handler(
                runtime: Any,
                message: Memory,
                state: State | None,
                options: HandlerOptions | None,
                callback: Any,
                responses: Any,
            ) -> ActionResult | None:
                response = await b.send_request({
                    "type": "action.invoke",
                    "action": name,
                    "memory": message.model_dump() if hasattr(message, "model_dump") else message,
                    "state": state.model_dump() if state and hasattr(state, "model_dump") else state,
                    "options": options.model_dump() if options else None,
                })
                result = response.get("result")
                if not result:
                    return None
                return ActionResult(**result)
            return handler

        validate_fn = make_validate(action_name, bridge)
        handler_fn = make_handler(action_name, bridge)

        actions.append(
            Action(
                name=action_name,
                description=action_def.get("description", ""),
                similes=action_def.get("similes"),
                validate=validate_fn,  # type: ignore
                handler=handler_fn,  # type: ignore
            )
        )

    # Create provider wrappers
    providers: list[Provider] = []
    for provider_def in manifest.get("providers", []):
        provider_name = provider_def["name"]

        def make_get(name: str, b: TypeScriptPluginBridge) -> Callable[..., Awaitable[ProviderResult]]:
            async def get(runtime: Any, message: Memory, state: State) -> ProviderResult:
                response = await b.send_request({
                    "type": "provider.get",
                    "provider": name,
                    "memory": message.model_dump() if hasattr(message, "model_dump") else message,
                    "state": state.model_dump() if hasattr(state, "model_dump") else state,
                })
                result = response.get("result", {})
                return ProviderResult(**result)
            return get

        get_fn = make_get(provider_name, bridge)

        providers.append(
            Provider(
                name=provider_name,
                description=provider_def.get("description"),
                dynamic=provider_def.get("dynamic"),
                position=provider_def.get("position"),
                private=provider_def.get("private"),
                get=get_fn,  # type: ignore
            )
        )

    # Create evaluator wrappers
    evaluators: list[Evaluator] = []
    for eval_def in manifest.get("evaluators", []):
        eval_name = eval_def["name"]

        def make_eval_validate(name: str, b: TypeScriptPluginBridge) -> Callable[..., Awaitable[bool]]:
            async def validate(runtime: Any, message: Memory, state: State | None) -> bool:
                response = await b.send_request({
                    "type": "action.validate",
                    "action": name,
                    "memory": message.model_dump() if hasattr(message, "model_dump") else message,
                    "state": state.model_dump() if state and hasattr(state, "model_dump") else state,
                })
                return response.get("valid", False)
            return validate

        def make_eval_handler(
            name: str, b: TypeScriptPluginBridge
        ) -> Callable[..., Awaitable[ActionResult | None]]:
            async def handler(
                runtime: Any,
                message: Memory,
                state: State | None,
                options: HandlerOptions | None,
                callback: Any,
                responses: Any,
            ) -> ActionResult | None:
                response = await b.send_request({
                    "type": "evaluator.invoke",
                    "evaluator": name,
                    "memory": message.model_dump() if hasattr(message, "model_dump") else message,
                    "state": state.model_dump() if state and hasattr(state, "model_dump") else state,
                })
                result = response.get("result")
                if not result:
                    return None
                return ActionResult(**result)
            return handler

        validate_fn = make_eval_validate(eval_name, bridge)
        handler_fn = make_eval_handler(eval_name, bridge)

        evaluators.append(
            Evaluator(
                name=eval_name,
                description=eval_def.get("description", ""),
                always_run=eval_def.get("alwaysRun"),
                similes=eval_def.get("similes"),
                examples=[],
                validate=validate_fn,  # type: ignore
                handler=handler_fn,  # type: ignore
            )
        )

    # Create init function
    async def init(config: dict[str, str], runtime: Any) -> None:
        await bridge.send_request({
            "type": "plugin.init",
            "config": config,
        })

    # Store bridge reference for cleanup
    plugin = Plugin(
        name=manifest["name"],
        description=manifest["description"],
        init=init,
        config=manifest.get("config"),
        dependencies=manifest.get("dependencies"),
        actions=actions if actions else None,
        providers=providers if providers else None,
        evaluators=evaluators if evaluators else None,
    )

    # Attach bridge for cleanup
    setattr(plugin, "_bridge", bridge)

    return plugin


async def stop_typescript_plugin(plugin: Plugin) -> None:
    """Stop a TypeScript plugin bridge."""
    bridge = getattr(plugin, "_bridge", None)
    if bridge:
        await bridge.stop()






