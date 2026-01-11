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
from typing import Any, Callable, Awaitable

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
        self.env = {**os.environ, **(env or {})}
        self.timeout = timeout

        self.process: subprocess.Popen[bytes] | None = None
        self.manifest: dict[str, Any] | None = None
        self._request_counter = 0
        self._pending_requests: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._reader_task: asyncio.Task[None] | None = None
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

        # Wait for ready message with manifest
        await self._wait_for_ready()

    def _get_bridge_script(self) -> str:
        """Get the path to the TypeScript bridge script."""
        # Look for bridge script relative to this file
        script_dir = Path(__file__).parent
        bridge_path = script_dir / "ts_bridge_runner.mjs"

        if not bridge_path.exists():
            # Create the bridge script if it doesn't exist
            self._create_bridge_script(bridge_path)

        return str(bridge_path)

    def _create_bridge_script(self, path: Path) -> None:
        """Create the TypeScript bridge runner script."""
        script_content = '''#!/usr/bin/env node
/**
 * TypeScript Plugin Bridge Runner for Python
 *
 * This script loads a TypeScript plugin and communicates with Python
 * via JSON-RPC over stdin/stdout.
 */

import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const pluginPath = process.argv[2];
if (!pluginPath) {
  console.error('Usage: ts_bridge_runner.mjs <plugin_path>');
  process.exit(1);
}

// Dynamic import the plugin
const loadPlugin = async () => {
  try {
    // Try to load as ESM module
    const module = await import(resolve(pluginPath));
    return module.default || module.plugin || module;
  } catch (e) {
    // Fall back to require for CJS
    const require = createRequire(import.meta.url);
    const module = require(resolve(pluginPath));
    return module.default || module.plugin || module;
  }
};

// Main
(async () => {
  let plugin;

  try {
    plugin = await loadPlugin();
  } catch (e) {
    console.error(`Failed to load plugin: ${e.message}`);
    process.exit(1);
  }

  // Index actions, providers, evaluators
  const actions = {};
  const providers = {};
  const evaluators = {};

  for (const action of plugin.actions || []) {
    actions[action.name] = action;
  }
  for (const provider of plugin.providers || []) {
    providers[provider.name] = provider;
  }
  for (const evaluator of plugin.evaluators || []) {
    evaluators[evaluator.name] = evaluator;
  }

  // Build manifest
  const manifest = {
    name: plugin.name,
    description: plugin.description,
    version: plugin.version || '1.0.0',
    language: 'typescript',
    config: plugin.config,
    dependencies: plugin.dependencies,
    actions: Object.values(actions).map(a => ({
      name: a.name,
      description: a.description,
      similes: a.similes,
    })),
    providers: Object.values(providers).map(p => ({
      name: p.name,
      description: p.description,
      dynamic: p.dynamic,
      position: p.position,
      private: p.private,
    })),
    evaluators: Object.values(evaluators).map(e => ({
      name: e.name,
      description: e.description,
      alwaysRun: e.alwaysRun,
      similes: e.similes,
    })),
  };

  // Send ready message
  console.log(JSON.stringify({ type: 'ready', manifest }));

  // Process requests
  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    try {
      const request = JSON.parse(line);
      const response = await handleRequest(request, plugin, actions, providers, evaluators);
      console.log(JSON.stringify(response));
    } catch (e) {
      console.log(JSON.stringify({
        type: 'error',
        id: '',
        error: e.message,
      }));
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
})();

async function handleRequest(request, plugin, actions, providers, evaluators) {
  const { type, id } = request;

  try {
    switch (type) {
      case 'plugin.init': {
        if (plugin.init) {
          await plugin.init(request.config, null);
        }
        return { type: 'plugin.init.result', id, success: true };
      }

      case 'action.validate': {
        const action = actions[request.action];
        if (!action) {
          return { type: 'validate.result', id, valid: false };
        }
        const valid = await action.validate(null, request.memory, request.state);
        return { type: 'validate.result', id, valid };
      }

      case 'action.invoke': {
        const action = actions[request.action];
        if (!action) {
          return {
            type: 'action.result',
            id,
            result: { success: false, error: `Action not found: ${request.action}` },
          };
        }
        const result = await action.handler(
          null,
          request.memory,
          request.state,
          request.options,
          null,
          null,
        );
        return {
          type: 'action.result',
          id,
          result: {
            success: result?.success ?? true,
            text: result?.text,
            error: result?.error?.message || result?.error,
            data: result?.data,
            values: result?.values,
          },
        };
      }

      case 'provider.get': {
        const provider = providers[request.provider];
        if (!provider) {
          return {
            type: 'provider.result',
            id,
            result: { text: null, values: null, data: null },
          };
        }
        const result = await provider.get(null, request.memory, request.state);
        return { type: 'provider.result', id, result };
      }

      case 'evaluator.invoke': {
        const evaluator = evaluators[request.evaluator];
        if (!evaluator) {
          return { type: 'action.result', id, result: null };
        }
        const result = await evaluator.handler(null, request.memory, request.state);
        return {
          type: 'action.result',
          id,
          result: result ? {
            success: result.success ?? true,
            text: result.text,
            error: result.error?.message || result.error,
            data: result.data,
            values: result.values,
          } : null,
        };
      }

      default:
        return { type: 'error', id, error: `Unknown request type: ${type}` };
    }
  } catch (e) {
    return { type: 'error', id, error: e.message };
  }
}
'''
        path.write_text(script_content)
        os.chmod(path, 0o755)

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

                try:
                    message = json.loads(line_str)
                    self._handle_message(message)
                except json.JSONDecodeError:
                    pass
            except Exception:
                break

    def _handle_message(self, message: dict[str, Any]) -> None:
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

    async def send_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """Send a request and wait for the response."""
        if not self.process or not self.process.stdin:
            raise RuntimeError("Bridge not started")

        self._request_counter += 1
        request_id = f"req_{self._request_counter}"
        request["id"] = request_id

        future: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
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

        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()

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






