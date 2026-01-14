#!/usr/bin/env python3
"""
elizaOS Python Plugin Bridge Server

This server is spawned by the TypeScript runtime to load and execute
Python plugins via JSON-RPC over stdin/stdout.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import os
import sys
import traceback
from typing import Any

# Import elizaos types (required). Fail closed if unavailable.
try:
    from elizaos.types.plugin import Plugin
    from elizaos.types.memory import Memory
    from elizaos.types.state import State
    from elizaos.types.components import ActionResult, ProviderResult, HandlerOptions
except ImportError as e:
    sys.stderr.write(
        "elizaOS interop bridge_server requires the 'elizaos' python package in the environment.\n"
    )
    sys.stderr.write(f"ImportError: {e}\n")
    sys.exit(1)


def _include_error_details() -> bool:
    """
    Whether to include stack traces in error responses.

    Default is off to avoid leaking secrets/PII via tracebacks over IPC.
    """
    value = os.environ.get("ELIZA_INTEROP_DEBUG") or os.environ.get("LOG_DIAGNOSTIC") or ""
    normalized = value.strip().lower()
    return normalized in {"1", "true", "yes", "on"}


class PluginBridgeServer:
    """JSON-RPC bridge server for Python plugins."""

    def __init__(self, module_name: str) -> None:
        self.module_name = module_name
        self.plugin: Plugin | None = None
        self.actions: dict[str, Any] = {}
        self.providers: dict[str, Any] = {}
        self.evaluators: dict[str, Any] = {}
        self.services: dict[str, Any] = {}
        self.routes: dict[str, Any] = {}
        self.initialized = False

    async def load_plugin(self) -> None:
        """Load the Python plugin module."""
        try:
            module = importlib.import_module(self.module_name)

            # Look for plugin export
            if hasattr(module, "plugin"):
                self.plugin = module.plugin
            elif hasattr(module, "default"):
                self.plugin = module.default
            else:
                raise RuntimeError(f"Module {self.module_name} has no plugin export")

            # Index components for fast lookup
            if hasattr(self.plugin, "actions") and self.plugin.actions:
                for action in self.plugin.actions:
                    self.actions[action.name] = action

            if hasattr(self.plugin, "providers") and self.plugin.providers:
                for provider in self.plugin.providers:
                    self.providers[provider.name] = provider

            if hasattr(self.plugin, "evaluators") and self.plugin.evaluators:
                for evaluator in self.plugin.evaluators:
                    self.evaluators[evaluator.name] = evaluator

            if hasattr(self.plugin, "services") and self.plugin.services:
                for service in self.plugin.services:
                    service_name = getattr(service, "service_type", None) or getattr(service, "name", str(service))
                    self.services[service_name] = service

            if hasattr(self.plugin, "routes") and self.plugin.routes:
                for route in self.plugin.routes:
                    route_path = route.path if hasattr(route, "path") else route.get("path", "")
                    self.routes[route_path] = route

        except Exception as e:
            raise RuntimeError(f"Failed to load plugin: {e}") from e

    def get_manifest(self) -> dict[str, Any]:
        """Get the plugin manifest as a dictionary."""
        if not self.plugin:
            raise RuntimeError("Plugin not loaded")

        manifest: dict[str, Any] = {
            "name": self.plugin.name,
            "description": self.plugin.description,
            "version": getattr(self.plugin, "version", "1.0.0"),
            "language": "python",
        }

        if hasattr(self.plugin, "config") and self.plugin.config:
            manifest["config"] = self.plugin.config

        if hasattr(self.plugin, "dependencies") and self.plugin.dependencies:
            manifest["dependencies"] = self.plugin.dependencies

        if hasattr(self.plugin, "actions") and self.plugin.actions:
            manifest["actions"] = [
                {
                    "name": a.name,
                    "description": a.description,
                    "similes": getattr(a, "similes", None),
                }
                for a in self.plugin.actions
            ]

        if hasattr(self.plugin, "providers") and self.plugin.providers:
            manifest["providers"] = [
                {
                    "name": p.name,
                    "description": getattr(p, "description", None),
                    "dynamic": getattr(p, "dynamic", None),
                    "position": getattr(p, "position", None),
                    "private": getattr(p, "private", None),
                }
                for p in self.plugin.providers
            ]

        if hasattr(self.plugin, "evaluators") and self.plugin.evaluators:
            manifest["evaluators"] = [
                {
                    "name": e.name,
                    "description": e.description,
                    "alwaysRun": getattr(e, "always_run", None),
                    "similes": getattr(e, "similes", None),
                }
                for e in self.plugin.evaluators
            ]

        if hasattr(self.plugin, "services") and self.plugin.services:
            manifest["services"] = [
                {
                    "type": getattr(s, "service_type", None) or getattr(s, "name", str(s)),
                    "description": getattr(s, "description", None),
                }
                for s in self.plugin.services
            ]

        if hasattr(self.plugin, "routes") and self.plugin.routes:
            manifest["routes"] = [
                {
                    "path": r.path if hasattr(r, "path") else r.get("path", ""),
                    "type": r.type if hasattr(r, "type") else r.get("type", "GET"),
                    "public": r.public if hasattr(r, "public") else r.get("public", False),
                    "name": getattr(r, "name", None) or r.get("name"),
                }
                for r in self.plugin.routes
            ]

        return manifest

    async def handle_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """Handle an incoming JSON-RPC request."""
        req_type = request.get("type", "")
        req_id = request.get("id", "")

        try:
            if req_type == "plugin.init":
                config = request.get("config", {})
                if self.plugin and hasattr(self.plugin, "init") and self.plugin.init:
                    await self.plugin.init(config, None)  # type: ignore
                self.initialized = True
                return {"type": "plugin.init.result", "id": req_id, "success": True}

            elif req_type == "action.validate":
                action_name = request.get("action", "")
                action = self.actions.get(action_name)
                if not action:
                    return {"type": "validate.result", "id": req_id, "valid": False}

                memory = self._parse_memory(request.get("memory"))
                state = self._parse_state(request.get("state"))

                # Call validate function
                valid = await action.validate(None, memory, state)  # type: ignore
                return {"type": "validate.result", "id": req_id, "valid": valid}

            elif req_type == "action.invoke":
                action_name = request.get("action", "")
                action = self.actions.get(action_name)
                if not action:
                    return {
                        "type": "action.result",
                        "id": req_id,
                        "result": {"success": False, "error": f"Action not found: {action_name}"},
                    }

                memory = self._parse_memory(request.get("memory"))
                state = self._parse_state(request.get("state"))
                options = request.get("options") or {}

                # Call handler
                result = await action.handler(
                    None,  # runtime
                    memory,
                    state,
                    HandlerOptions(**options) if isinstance(options, dict) else None,
                    None,  # callback
                    None,  # responses
                )

                return {
                    "type": "action.result",
                    "id": req_id,
                    "result": self._serialize_action_result(result),
                }

            elif req_type == "provider.get":
                provider_name = request.get("provider", "")
                provider = self.providers.get(provider_name)
                if not provider:
                    return {
                        "type": "provider.result",
                        "id": req_id,
                        "result": {"text": None, "values": None, "data": None},
                    }

                memory = self._parse_memory(request.get("memory"))
                state = self._parse_state(request.get("state"))

                result = await provider.get(None, memory, state)  # type: ignore

                return {
                    "type": "provider.result",
                    "id": req_id,
                    "result": self._serialize_provider_result(result),
                }

            elif req_type == "evaluator.invoke":
                evaluator_name = request.get("evaluator", "")
                evaluator = self.evaluators.get(evaluator_name)
                if not evaluator:
                    return {
                        "type": "action.result",
                        "id": req_id,
                        "result": None,
                    }

                memory = self._parse_memory(request.get("memory"))
                state = self._parse_state(request.get("state"))

                result = await evaluator.handler(
                    None,  # runtime
                    memory,
                    state,
                    None,  # options
                    None,  # callback
                    None,  # responses
                )

                return {
                    "type": "action.result",
                    "id": req_id,
                    "result": self._serialize_action_result(result) if result else None,
                }

            elif req_type == "service.start":
                service_type = request.get("serviceType", "")
                service_class = self.services.get(service_type)
                if not service_class:
                    return {
                        "type": "service.result",
                        "id": req_id,
                        "success": False,
                        "error": f"Service not found: {service_type}",
                    }

                # Start the service
                try:
                    if hasattr(service_class, "start"):
                        service_instance = await service_class.start(None)  # runtime
                    elif callable(service_class):
                        service_instance = service_class(None)  # runtime
                        if hasattr(service_instance, "start"):
                            await service_instance.start()
                    
                    return {
                        "type": "service.result",
                        "id": req_id,
                        "success": True,
                        "serviceType": service_type,
                    }
                except Exception as e:
                    return {
                        "type": "service.result",
                        "id": req_id,
                        "success": False,
                        "error": str(e),
                    }

            elif req_type == "service.stop":
                service_type = request.get("serviceType", "")
                # Note: In a real implementation, we'd track running service instances
                return {
                    "type": "service.result",
                    "id": req_id,
                    "success": True,
                    "serviceType": service_type,
                }

            elif req_type == "route.handle":
                route_path = request.get("path", "")
                route = self.routes.get(route_path)
                if not route:
                    return {
                        "type": "route.result",
                        "id": req_id,
                        "status": 404,
                        "body": {"error": f"Route not found: {route_path}"},
                    }

                handler = getattr(route, "handler", None) or route.get("handler")
                if not handler:
                    return {
                        "type": "route.result",
                        "id": req_id,
                        "status": 501,
                        "body": {"error": "Route has no handler"},
                    }

                # Create mock request/response objects
                req_data = request.get("request", {})
                mock_req = {
                    "body": req_data.get("body", {}),
                    "params": req_data.get("params", {}),
                    "query": req_data.get("query", {}),
                    "headers": req_data.get("headers", {}),
                    "method": req_data.get("method", "GET"),
                    "path": route_path,
                }

                response_data: dict[str, Any] = {"status": 200, "body": None, "headers": {}}
                
                class MockResponse:
                    def status(self, code: int) -> "MockResponse":
                        response_data["status"] = code
                        return self
                    
                    def json(self, data: Any) -> "MockResponse":
                        response_data["body"] = data
                        return self
                    
                    def send(self, data: Any) -> "MockResponse":
                        response_data["body"] = data
                        return self
                    
                    def end(self) -> "MockResponse":
                        return self
                    
                    def setHeader(self, name: str, value: str) -> "MockResponse":
                        response_data["headers"][name] = value
                        return self

                try:
                    if asyncio.iscoroutinefunction(handler):
                        await handler(mock_req, MockResponse(), None)  # runtime
                    else:
                        handler(mock_req, MockResponse(), None)  # runtime

                    return {
                        "type": "route.result",
                        "id": req_id,
                        "status": response_data["status"],
                        "body": response_data["body"],
                        "headers": response_data["headers"],
                    }
                except Exception as e:
                    return {
                        "type": "route.result",
                        "id": req_id,
                        "status": 500,
                        "body": {"error": str(e)},
                    }

            else:
                return {
                    "type": "error",
                    "id": req_id,
                    "error": f"Unknown request type: {req_type}",
                }

        except Exception as e:
            error_response: dict[str, Any] = {
                "type": "error",
                "id": req_id,
                "error": str(e),
            }
            if _include_error_details():
                error_response["details"] = traceback.format_exc()
            return error_response

    def _parse_memory(self, data: dict[str, Any] | None) -> Memory:
        """Parse memory from JSON."""
        if data is None:
            return Memory()  # type: ignore
        if isinstance(data, dict):
            return Memory(**data)  # type: ignore
        return data  # type: ignore

    def _parse_state(self, data: dict[str, Any] | None) -> State | None:
        """Parse state from JSON."""
        if data is None:
            return None
        if isinstance(data, dict):
            return State(**data)  # type: ignore
        return data  # type: ignore

    def _serialize_action_result(self, result: ActionResult | None) -> dict[str, Any] | None:
        """Serialize action result to JSON-compatible dict."""
        if result is None:
            return None

        if isinstance(result, dict):
            return result

        return {
            "success": result.success,
            "text": result.text,
            "error": str(result.error) if result.error else None,
            "data": result.data,
            "values": result.values,
        }

    def _serialize_provider_result(self, result: ProviderResult) -> dict[str, Any]:
        """Serialize provider result to JSON-compatible dict."""
        if isinstance(result, dict):
            return result

        return {
            "text": result.text,
            "values": result.values,
            "data": result.data,
        }


async def main(module_name: str) -> None:
    """Main entry point for the bridge server."""
    server = PluginBridgeServer(module_name)

    # Load the plugin
    await server.load_plugin()

    # Send ready message with manifest
    manifest = server.get_manifest()
    ready_msg = {"type": "ready", "manifest": manifest}
    print(json.dumps(ready_msg), flush=True)

    # Process requests from stdin
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_event_loop().connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        try:
            line = await reader.readline()
            if not line:
                break

            line_str = line.decode("utf-8").strip()
            if not line_str:
                continue

            request = json.loads(line_str)
            response = await server.handle_request(request)
            print(json.dumps(response), flush=True)

        except json.JSONDecodeError as e:
            error_response = {"type": "error", "id": "", "error": f"JSON parse error: {e}"}
            print(json.dumps(error_response), flush=True)
        except Exception as e:
            error_response: dict[str, Any] = {
                "type": "error",
                "id": "",
                "error": str(e),
            }
            if _include_error_details():
                error_response["details"] = traceback.format_exc()
            print(json.dumps(error_response), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="elizaOS Python Plugin Bridge Server")
    parser.add_argument("--module", "-m", required=True, help="Python module name to load")
    args = parser.parse_args()

    asyncio.run(main(args.module))

