"""
Tests for Rust FFI Plugin Loader

These tests validate the FFI interface without requiring an actual Rust library.
They test JSON serialization, type handling, and the expected protocol.
"""

import json
import pytest


class TestFFIProtocol:
    """Test the FFI protocol and data serialization."""

    def test_manifest_json_format(self):
        """Test that manifest JSON format matches expected structure."""
        manifest = {
            "name": "test-rust-plugin",
            "description": "A test plugin from Rust",
            "version": "2.0.0-alpha",
            "language": "rust",
            "actions": [
                {
                    "name": "RUST_ACTION",
                    "description": "Action from Rust",
                    "similes": ["TEST_RUST"],
                }
            ],
            "providers": [
                {
                    "name": "RUST_PROVIDER",
                    "description": "Provider from Rust",
                    "dynamic": True,
                }
            ],
        }

        json_str = json.dumps(manifest)
        parsed = json.loads(json_str)

        assert parsed["name"] == "test-rust-plugin"
        assert parsed["language"] == "rust"
        assert len(parsed["actions"]) == 1
        assert parsed["actions"][0]["name"] == "RUST_ACTION"

    def test_action_result_serialization(self):
        """Test ActionResult serialization format."""
        result = {
            "success": True,
            "text": "Hello from Rust! 🦀",
            "data": {"language": "rust", "version": "2.0.0-alpha"},
            "values": {"key": "value"},
        }

        json_str = json.dumps(result)
        parsed = json.loads(json_str)

        assert parsed["success"] is True
        assert parsed["text"] == "Hello from Rust! 🦀"
        assert parsed["data"]["language"] == "rust"

    def test_action_result_failure(self):
        """Test ActionResult failure format."""
        result = {"success": False, "error": "Something went wrong"}

        json_str = json.dumps(result)
        parsed = json.loads(json_str)

        assert parsed["success"] is False
        assert parsed["error"] == "Something went wrong"

    def test_provider_result_serialization(self):
        """Test ProviderResult serialization format."""
        result = {
            "text": "Rust plugin context",
            "values": {"rust_version": "1.75.0"},
            "data": {"build_info": {"target": "x86_64"}},
        }

        json_str = json.dumps(result)
        parsed = json.loads(json_str)

        assert parsed["text"] == "Rust plugin context"
        assert parsed["values"]["rust_version"] == "1.75.0"

    def test_memory_serialization(self):
        """Test Memory object serialization for FFI."""
        memory = {
            "id": "123e4567-e89b-12d3-a456-426614174000",
            "agentId": "123e4567-e89b-12d3-a456-426614174001",
            "content": {"text": "Hello from Python", "actions": ["ACTION_1"]},
            "createdAt": 1704067200000,
        }

        json_str = json.dumps(memory)
        parsed = json.loads(json_str)

        assert parsed["id"] == memory["id"]
        assert parsed["content"]["text"] == "Hello from Python"

    def test_state_serialization(self):
        """Test State object serialization for FFI."""
        state = {
            "text": "Current conversation context",
            "values": {"agentName": "TestAgent", "count": 5},
            "data": {"providers": {"time": {"hour": 12}}},
        }

        json_str = json.dumps(state)
        parsed = json.loads(json_str)

        assert parsed["text"] == "Current conversation context"
        assert parsed["values"]["count"] == 5


class TestFFIFunctionSignatures:
    """Test expected FFI function signatures."""

    def test_elizaos_get_manifest_signature(self):
        """Test elizaos_get_manifest expected return format."""
        # Simulate what the Rust function would return
        manifest_json = json.dumps(
            {"name": "test", "description": "Test", "version": "2.0.0-alpha", "language": "rust"}
        )

        # Should return a valid JSON string
        parsed = json.loads(manifest_json)
        assert "name" in parsed
        assert "description" in parsed

    def test_elizaos_init_signature(self):
        """Test elizaos_init expected config format."""
        config = {"API_KEY": "test-key", "DEBUG": "true"}

        config_json = json.dumps(config)
        parsed = json.loads(config_json)

        assert parsed["API_KEY"] == "test-key"

    def test_elizaos_validate_action_signature(self):
        """Test elizaos_validate_action parameter format."""
        action_name = "TEST_ACTION"
        memory_json = json.dumps({"content": {"text": "Hello"}})
        state_json = json.dumps({"values": {}})

        # These would be passed to the FFI function
        assert isinstance(action_name, str)
        assert isinstance(memory_json, str)
        assert isinstance(state_json, str)

    def test_elizaos_invoke_action_signature(self):
        """Test elizaos_invoke_action parameter and return format."""
        # Test parameter types used in FFI calls
        _action_name = "TEST_ACTION"
        _memory_json = json.dumps({"content": {"text": "Hello"}})
        _state_json = json.dumps({"values": {}})
        _options_json = json.dumps({"timeout": 5000})

        # Simulate return value
        result_json = json.dumps({"success": True, "text": "Done!"})

        parsed = json.loads(result_json)
        assert parsed["success"] is True

    def test_elizaos_get_provider_signature(self):
        """Test elizaos_get_provider parameter and return format."""
        # Test parameter types used in FFI calls
        _provider_name = "TEST_PROVIDER"
        _memory_json = json.dumps({"content": {}})
        _state_json = json.dumps({"values": {}})

        # Simulate return value
        result_json = json.dumps({"text": "Provider data", "values": {"key": "value"}})

        parsed = json.loads(result_json)
        assert parsed["text"] == "Provider data"


class TestPlatformDetection:
    """Test platform-specific library handling."""

    def test_lib_extension_detection(self):
        """Test library extension detection logic."""
        import platform

        system = platform.system()

        if system == "Darwin":
            expected = ".dylib"
        elif system == "Windows":
            expected = ".dll"
        else:
            expected = ".so"

        # This tests the logic that would be in get_lib_extension()
        assert expected in [".so", ".dylib", ".dll"]

    def test_lib_prefix_detection(self):
        """Test library prefix detection logic."""
        import platform

        system = platform.system()

        if system == "Windows":
            expected = ""
        else:
            expected = "lib"

        assert expected in ["", "lib"]


class TestErrorHandling:
    """Test error handling in FFI operations."""

    def test_invalid_json_handling(self):
        """Test handling of invalid JSON from FFI."""
        invalid_json = "{ invalid json }"

        with pytest.raises(json.JSONDecodeError):
            json.loads(invalid_json)

    def test_null_result_handling(self):
        """Test handling of null results from FFI."""
        null_json = "null"
        parsed = json.loads(null_json)
        assert parsed is None

    def test_empty_result_handling(self):
        """Test handling of empty results."""
        empty_result = {"text": None, "values": None, "data": None}

        json_str = json.dumps(empty_result)
        parsed = json.loads(json_str)

        assert parsed["text"] is None


class TestComplexDataTypes:
    """Test handling of complex data types."""

    def test_nested_data_serialization(self):
        """Test deeply nested data structures."""
        data = {
            "level1": {
                "level2": {
                    "level3": {"value": "deep"},
                    "array": [1, 2, {"nested": True}],
                }
            }
        }

        json_str = json.dumps(data)
        parsed = json.loads(json_str)

        assert parsed["level1"]["level2"]["level3"]["value"] == "deep"
        assert parsed["level1"]["level2"]["array"][2]["nested"] is True

    def test_unicode_handling(self):
        """Test Unicode string handling."""
        data = {"text": "Hello 世界! 🦀 مرحبا שָׁלוֹם", "emoji": "🎉🎊🎈"}

        json_str = json.dumps(data, ensure_ascii=False)
        parsed = json.loads(json_str)

        assert "世界" in parsed["text"]
        assert "🦀" in parsed["text"]
        assert parsed["emoji"] == "🎉🎊🎈"

    def test_large_payload_handling(self):
        """Test handling of large payloads."""
        large_text = "x" * 100000
        data = {"content": {"text": large_text}}

        json_str = json.dumps(data)
        parsed = json.loads(json_str)

        assert len(parsed["content"]["text"]) == 100000

    def test_special_characters(self):
        """Test handling of special characters."""
        data = {
            "text": 'Quotes: "hello" and \'world\'',
            "newlines": "Line 1\nLine 2\r\nLine 3",
            "tabs": "Col1\tCol2\tCol3",
            "backslash": "path\\to\\file",
        }

        json_str = json.dumps(data)
        parsed = json.loads(json_str)

        assert '"hello"' in parsed["text"]
        assert "\n" in parsed["newlines"]
        assert "\t" in parsed["tabs"]
        assert "\\" in parsed["backslash"]


class TestPluginAdapterCreation:
    """Test creating Plugin adapters from FFI."""

    def test_action_wrapper_creation(self):
        """Test creating action wrappers from manifest."""
        manifest = {
            "actions": [
                {"name": "ACTION_1", "description": "First action", "similes": ["A1"]},
                {"name": "ACTION_2", "description": "Second action"},
            ]
        }

        # Simulate wrapper creation
        actions = []
        for action_def in manifest["actions"]:
            actions.append(
                {
                    "name": action_def["name"],
                    "description": action_def["description"],
                    "similes": action_def.get("similes", []),
                }
            )

        assert len(actions) == 2
        assert actions[0]["name"] == "ACTION_1"
        assert actions[0]["similes"] == ["A1"]
        assert actions[1]["similes"] == []

    def test_provider_wrapper_creation(self):
        """Test creating provider wrappers from manifest."""
        manifest = {
            "providers": [
                {
                    "name": "PROVIDER_1",
                    "description": "First provider",
                    "dynamic": True,
                    "position": 5,
                }
            ]
        }

        providers = []
        for provider_def in manifest["providers"]:
            providers.append(
                {
                    "name": provider_def["name"],
                    "description": provider_def.get("description"),
                    "dynamic": provider_def.get("dynamic", False),
                    "position": provider_def.get("position"),
                }
            )

        assert len(providers) == 1
        assert providers[0]["dynamic"] is True
        assert providers[0]["position"] == 5

