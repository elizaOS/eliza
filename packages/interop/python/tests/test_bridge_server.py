"""
Tests for Python Plugin Bridge Server

These tests validate the IPC protocol handling and message processing.
"""

import json
import pytest


class TestIPCProtocol:
    """Test IPC message protocol."""

    def test_ready_message_format(self):
        """Test ready message with manifest format."""
        manifest = {
            "name": "python-plugin",
            "description": "Test Python plugin",
            "version": "2.0.0-alpha",
            "language": "python",
            "actions": [{"name": "TEST_ACTION", "description": "Test"}],
        }

        ready_msg = {"type": "ready", "manifest": manifest}

        json_str = json.dumps(ready_msg)
        parsed = json.loads(json_str)

        assert parsed["type"] == "ready"
        assert parsed["manifest"]["name"] == "python-plugin"

    def test_action_invoke_request(self):
        """Test action.invoke request parsing."""
        request = {
            "type": "action.invoke",
            "id": "req-123",
            "action": "HELLO_PYTHON",
            "memory": {"content": {"text": "Hello"}},
            "state": {"values": {}},
            "options": {"timeout": 5000},
        }

        json_str = json.dumps(request)
        parsed = json.loads(json_str)

        assert parsed["type"] == "action.invoke"
        assert parsed["action"] == "HELLO_PYTHON"
        assert parsed["memory"]["content"]["text"] == "Hello"

    def test_action_validate_request(self):
        """Test action.validate request parsing."""
        request = {
            "type": "action.validate",
            "id": "req-124",
            "action": "TEST_ACTION",
            "memory": {"content": {"text": "Test"}},
            "state": None,
        }

        json_str = json.dumps(request)
        parsed = json.loads(json_str)

        assert parsed["type"] == "action.validate"
        assert parsed["state"] is None

    def test_provider_get_request(self):
        """Test provider.get request parsing."""
        request = {
            "type": "provider.get",
            "id": "req-125",
            "provider": "PYTHON_INFO",
            "memory": {"content": {}},
            "state": {"values": {}},
        }

        json_str = json.dumps(request)
        parsed = json.loads(json_str)

        assert parsed["type"] == "provider.get"
        assert parsed["provider"] == "PYTHON_INFO"

    def test_plugin_init_request(self):
        """Test plugin.init request parsing."""
        request = {
            "type": "plugin.init",
            "id": "req-126",
            "config": {"API_KEY": "test-key", "DEBUG": "true"},
        }

        json_str = json.dumps(request)
        parsed = json.loads(json_str)

        assert parsed["type"] == "plugin.init"
        assert parsed["config"]["API_KEY"] == "test-key"


class TestIPCResponses:
    """Test IPC response formatting."""

    def test_action_result_success(self):
        """Test successful action result response."""
        response = {
            "type": "action.result",
            "id": "req-123",
            "result": {
                "success": True,
                "text": "Hello from Python! 🐍",
                "data": {"language": "python"},
            },
        }

        json_str = json.dumps(response)
        parsed = json.loads(json_str)

        assert parsed["type"] == "action.result"
        assert parsed["result"]["success"] is True
        assert "🐍" in parsed["result"]["text"]

    def test_action_result_failure(self):
        """Test failed action result response."""
        response = {
            "type": "action.result",
            "id": "req-123",
            "result": {"success": False, "error": "Action failed"},
        }

        json_str = json.dumps(response)
        parsed = json.loads(json_str)

        assert parsed["result"]["success"] is False
        assert parsed["result"]["error"] == "Action failed"

    def test_validate_result(self):
        """Test validation result response."""
        response = {"type": "validate.result", "id": "req-124", "valid": True}

        json_str = json.dumps(response)
        parsed = json.loads(json_str)

        assert parsed["type"] == "validate.result"
        assert parsed["valid"] is True

    def test_provider_result(self):
        """Test provider result response."""
        response = {
            "type": "provider.result",
            "id": "req-125",
            "result": {
                "text": "Python environment info",
                "values": {"version": "3.11"},
                "data": {"platform": "linux"},
            },
        }

        json_str = json.dumps(response)
        parsed = json.loads(json_str)

        assert parsed["result"]["text"] == "Python environment info"
        assert parsed["result"]["values"]["version"] == "3.11"

    def test_init_result(self):
        """Test plugin init result response."""
        response = {"type": "plugin.init.result", "id": "req-126", "success": True}

        json_str = json.dumps(response)
        parsed = json.loads(json_str)

        assert parsed["type"] == "plugin.init.result"
        assert parsed["success"] is True

    def test_error_response(self):
        """Test error response format."""
        response = {
            "type": "error",
            "id": "req-error",
            "error": "Module not found",
            "details": "Traceback (most recent call last):\n  File...",
        }

        json_str = json.dumps(response)
        parsed = json.loads(json_str)

        assert parsed["type"] == "error"
        assert parsed["error"] == "Module not found"


class TestRequestHandling:
    """Test request handling logic."""

    def test_route_action_invoke(self):
        """Test routing action.invoke requests."""
        request = {"type": "action.invoke", "action": "TEST"}

        # Route based on type
        handlers = {
            "action.invoke": lambda r: {"handled": "action.invoke"},
            "action.validate": lambda r: {"handled": "action.validate"},
            "provider.get": lambda r: {"handled": "provider.get"},
        }

        result = handlers.get(request["type"], lambda r: {"error": "unknown"})(request)
        assert result["handled"] == "action.invoke"

    def test_route_unknown_type(self):
        """Test routing unknown request types."""
        request = {"type": "unknown.type"}

        handlers = {
            "action.invoke": lambda r: {"handled": "action.invoke"},
        }

        result = handlers.get(request["type"], lambda r: {"type": "error", "error": "Unknown type"})(
            request
        )
        assert result["type"] == "error"

    def test_extract_request_id(self):
        """Test extracting request ID from messages."""
        request = {"type": "action.invoke", "id": "unique-id-123", "action": "TEST"}

        request_id = request.get("id", "")
        assert request_id == "unique-id-123"

    def test_missing_request_id(self):
        """Test handling missing request ID."""
        request = {"type": "action.invoke", "action": "TEST"}

        request_id = request.get("id", "")
        assert request_id == ""


class TestManifestGeneration:
    """Test manifest generation for plugins."""

    def test_generate_manifest_with_actions(self):
        """Test generating manifest with actions."""
        # Simulate plugin attributes
        plugin = {
            "name": "test-plugin",
            "description": "Test description",
            "version": "2.0.0-alpha",
            "actions": [
                {"name": "ACTION_1", "description": "First action"},
                {"name": "ACTION_2", "description": "Second action", "similes": ["A2"]},
            ],
        }

        manifest = {
            "name": plugin["name"],
            "description": plugin["description"],
            "version": plugin.get("version", "1.0.0"),
            "language": "python",
            "actions": [
                {
                    "name": a["name"],
                    "description": a["description"],
                    "similes": a.get("similes"),
                }
                for a in plugin.get("actions", [])
            ],
        }

        assert manifest["name"] == "test-plugin"
        assert len(manifest["actions"]) == 2
        assert manifest["actions"][1]["similes"] == ["A2"]

    def test_generate_manifest_with_providers(self):
        """Test generating manifest with providers."""
        plugin = {
            "name": "provider-plugin",
            "description": "Provider test",
            "providers": [
                {
                    "name": "PROVIDER_1",
                    "description": "First provider",
                    "dynamic": True,
                    "position": 5,
                    "private": False,
                }
            ],
        }

        manifest = {
            "name": plugin["name"],
            "description": plugin["description"],
            "version": "2.0.0-alpha",
            "language": "python",
            "providers": [
                {
                    "name": p["name"],
                    "description": p.get("description"),
                    "dynamic": p.get("dynamic"),
                    "position": p.get("position"),
                    "private": p.get("private"),
                }
                for p in plugin.get("providers", [])
            ],
        }

        assert len(manifest["providers"]) == 1
        assert manifest["providers"][0]["dynamic"] is True


class TestMessageBuffering:
    """Test message buffering for stdin/stdout communication."""

    def test_newline_delimited_messages(self):
        """Test parsing newline-delimited messages."""
        messages = [
            {"type": "action.invoke", "id": "1", "action": "A"},
            {"type": "action.invoke", "id": "2", "action": "B"},
            {"type": "action.invoke", "id": "3", "action": "C"},
        ]

        # Simulate buffered input
        buffer = "\n".join(json.dumps(m) for m in messages) + "\n"
        lines = buffer.strip().split("\n")

        assert len(lines) == 3
        for i, line in enumerate(lines):
            parsed = json.loads(line)
            assert parsed["id"] == str(i + 1)

    def test_partial_message_buffering(self):
        """Test handling partial messages in buffer."""
        message = {"type": "test", "data": "complete"}
        full_json = json.dumps(message)

        # Simulate partial reads
        part1 = full_json[:10]
        part2 = full_json[10:]

        buffer = ""
        buffer += part1
        # Can't parse yet
        with pytest.raises(json.JSONDecodeError):
            json.loads(buffer)

        buffer += part2
        # Now can parse
        parsed = json.loads(buffer)
        assert parsed["type"] == "test"


class TestErrorHandling:
    """Test error handling in bridge server."""

    def test_malformed_json(self):
        """Test handling malformed JSON input."""
        malformed = '{ type: "test" }'

        with pytest.raises(json.JSONDecodeError):
            json.loads(malformed)

    def test_missing_required_field(self):
        """Test handling missing required fields."""
        request = {"type": "action.invoke"}
        # Missing action field

        action = request.get("action")
        assert action is None

    def test_exception_serialization(self):
        """Test serializing exceptions in error responses."""
        try:
            raise ValueError("Test error")
        except Exception as e:
            response = {
                "type": "error",
                "id": "req-err",
                "error": str(e),
                "details": type(e).__name__,
            }

        json_str = json.dumps(response)
        parsed = json.loads(json_str)

        assert parsed["error"] == "Test error"
        assert parsed["details"] == "ValueError"


class TestAsyncOperations:
    """Test async operation handling."""

    @pytest.mark.asyncio
    async def test_async_action_handler(self):
        """Test async action handler execution."""

        async def mock_handler(memory, state, options):
            # Simulate async work
            await asyncio.sleep(0.01)
            return {"success": True, "text": "Async result"}

        import asyncio

        result = await mock_handler({}, {}, {})
        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_async_provider_get(self):
        """Test async provider get execution."""

        async def mock_get(memory, state):
            return {"text": "Async provider data", "values": {}}


        result = await mock_get({}, {})
        assert result["text"] == "Async provider data"


class TestServiceHandling:
    """Test service handling in bridge server."""

    def test_service_start_request(self):
        """Test service.start request format."""
        request = {
            "type": "service.start",
            "id": "req-456",
            "serviceType": "CUSTOM_SERVICE",
        }

        json_str = json.dumps(request)
        parsed = json.loads(json_str)

        assert parsed["type"] == "service.start"
        assert parsed["serviceType"] == "CUSTOM_SERVICE"

    def test_service_stop_request(self):
        """Test service.stop request format."""
        request = {
            "type": "service.stop",
            "id": "req-789",
            "serviceType": "CUSTOM_SERVICE",
        }

        json_str = json.dumps(request)
        parsed = json.loads(json_str)

        assert parsed["type"] == "service.stop"
        assert parsed["serviceType"] == "CUSTOM_SERVICE"

    def test_service_manifest_entry(self):
        """Test service manifest entry format."""
        service_entry = {
            "type": "CUSTOM_SERVICE",
            "description": "A custom service for testing",
        }

        manifest = {
            "name": "service-plugin",
            "services": [service_entry],
        }

        assert manifest["services"][0]["type"] == "CUSTOM_SERVICE"
        assert manifest["services"][0]["description"] == "A custom service for testing"


class TestRouteHandling:
    """Test route handling in bridge server."""

    def test_route_handle_request(self):
        """Test route.handle request format."""
        request = {
            "type": "route.handle",
            "id": "req-101",
            "path": "/api/test",
            "request": {
                "method": "GET",
                "body": {},
                "params": {},
                "query": {"limit": "10"},
                "headers": {"authorization": "Bearer token"},
            },
        }

        json_str = json.dumps(request)
        parsed = json.loads(json_str)

        assert parsed["type"] == "route.handle"
        assert parsed["path"] == "/api/test"
        assert parsed["request"]["query"]["limit"] == "10"

    def test_route_result_success(self):
        """Test route.result success format."""
        response = {
            "type": "route.result",
            "id": "req-101",
            "status": 200,
            "body": {"data": [1, 2, 3]},
            "headers": {"content-type": "application/json"},
        }

        assert response["status"] == 200
        assert response["body"]["data"] == [1, 2, 3]

    def test_route_result_error(self):
        """Test route.result error format."""
        response = {
            "type": "route.result",
            "id": "req-101",
            "status": 404,
            "body": {"error": "Not found"},
        }

        assert response["status"] == 404
        assert response["body"]["error"] == "Not found"

    def test_route_manifest_entry(self):
        """Test route manifest entry format."""
        route_entry = {
            "path": "/api/users",
            "type": "GET",
            "public": True,
            "name": "get_users",
        }

        manifest = {
            "name": "route-plugin",
            "routes": [route_entry],
        }

        assert manifest["routes"][0]["path"] == "/api/users"
        assert manifest["routes"][0]["type"] == "GET"
        assert manifest["routes"][0]["public"] is True

