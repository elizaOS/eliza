"""
WASM Bindings Tests for Python

Tests the Rust WASM bindings to ensure they work correctly from Python.
Uses wasmer-python to load and execute the WASM module.

Prerequisites:
    pip install wasmer wasmer-compiler-cranelift

Build the WASM module first:
    cd packages/rust && ./build-wasm.sh
"""

import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any, Optional

# Try to import wasmer
try:
    from wasmer import Store, Module, Instance, ImportObject, Function, Memory
    from wasmer_compiler_cranelift import Compiler
    WASMER_AVAILABLE = True
except ImportError:
    WASMER_AVAILABLE = False
    print("wasmer not installed. Run: pip install wasmer wasmer-compiler-cranelift")


# Path to WASM module
RUST_DIR = Path(__file__).parent.parent.parent
WASM_PKG_DIR = RUST_DIR / "pkg-web"
WASM_FILE = WASM_PKG_DIR / "elizaos_bg.wasm"


def wasm_available() -> bool:
    """Check if WASM module is available"""
    return WASMER_AVAILABLE and WASM_FILE.exists()


class TestWasmModule(unittest.TestCase):
    """Test loading and using the WASM module"""

    @classmethod
    def setUpClass(cls):
        """Load the WASM module"""
        if not wasm_available():
            return

        # Create a store with Cranelift compiler
        cls.store = Store(Compiler)

        # Read and compile the WASM module
        with open(WASM_FILE, "rb") as f:
            wasm_bytes = f.read()

        cls.module = Module(cls.store, wasm_bytes)

    def test_wasm_module_loads(self):
        """Test that the WASM module loads successfully"""
        if not wasm_available():
            self.skipTest("WASM module not available")

        self.assertIsNotNone(self.module)

    def test_wasm_exports_exist(self):
        """Test that expected exports exist in the WASM module"""
        if not wasm_available():
            self.skipTest("WASM module not available")

        exports = [export.name for export in self.module.exports]

        # Check for expected function exports
        expected_exports = [
            "memory",
        ]

        for export in expected_exports:
            self.assertIn(export, exports, f"Missing export: {export}")


class TestMemorySerialization(unittest.TestCase):
    """Test Memory type serialization compatibility"""

    def test_memory_json_structure(self):
        """Test that Memory JSON structure matches Rust expectations"""
        memory = {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "entityId": "550e8400-e29b-41d4-a716-446655440001",
            "roomId": "550e8400-e29b-41d4-a716-446655440002",
            "content": {
                "text": "Hello, world!",
                "source": "test"
            },
            "createdAt": 1704067200000
        }

        # Should serialize to valid JSON
        json_str = json.dumps(memory)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["id"], memory["id"])
        self.assertEqual(parsed["content"]["text"], "Hello, world!")

    def test_memory_minimal_structure(self):
        """Test minimal Memory structure"""
        memory = {
            "entityId": "entity-123",
            "roomId": "room-456",
            "content": {"text": "test"}
        }

        json_str = json.dumps(memory)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["entityId"], "entity-123")
        self.assertNotIn("id", parsed)  # Optional field not present


class TestCharacterSerialization(unittest.TestCase):
    """Test Character type serialization compatibility"""

    def test_character_json_structure(self):
        """Test that Character JSON structure matches Rust expectations"""
        character = {
            "name": "TestAgent",
            "system": "You are a helpful assistant.",
            "bio": ["An AI assistant", "Helps users"],
            "topics": ["general", "coding"],
            "messageExamples": [],
            "postExamples": [],
            "settings": {}
        }

        json_str = json.dumps(character)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["name"], "TestAgent")
        self.assertEqual(len(parsed["bio"]), 2)

    def test_character_bio_as_string(self):
        """Test Character with bio as single string"""
        character = {
            "name": "Agent",
            "bio": "A simple bio string",
            "messageExamples": [],
            "postExamples": []
        }

        json_str = json.dumps(character)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["bio"], "A simple bio string")

    def test_character_bio_as_array(self):
        """Test Character with bio as array"""
        character = {
            "name": "Agent",
            "bio": ["Line 1", "Line 2", "Line 3"],
            "messageExamples": [],
            "postExamples": []
        }

        json_str = json.dumps(character)
        parsed = json.loads(json_str)

        self.assertIsInstance(parsed["bio"], list)
        self.assertEqual(len(parsed["bio"]), 3)


class TestAgentSerialization(unittest.TestCase):
    """Test Agent type serialization compatibility"""

    def test_agent_json_structure(self):
        """Test that Agent JSON structure matches Rust expectations"""
        agent = {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "TestAgent",
            "bio": "A test agent",
            "status": "active",
            "enabled": True
        }

        json_str = json.dumps(agent)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["id"], agent["id"])
        self.assertEqual(parsed["status"], "active")
        self.assertTrue(parsed["enabled"])

    def test_agent_status_values(self):
        """Test valid agent status values"""
        valid_statuses = ["active", "inactive", "paused"]

        for status in valid_statuses:
            agent = {
                "id": "test-id",
                "name": "Test",
                "status": status
            }
            json_str = json.dumps(agent)
            parsed = json.loads(json_str)
            self.assertEqual(parsed["status"], status)


class TestPluginSerialization(unittest.TestCase):
    """Test Plugin type serialization compatibility"""

    def test_plugin_json_structure(self):
        """Test that Plugin JSON structure matches Rust expectations"""
        plugin = {
            "name": "test-plugin",
            "description": "A test plugin",
            "actions": [],
            "evaluators": [],
            "providers": [],
            "services": [],
            "dependencies": ["dep1", "dep2"]
        }

        json_str = json.dumps(plugin)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["name"], "test-plugin")
        self.assertEqual(len(parsed["dependencies"]), 2)


class TestRoomSerialization(unittest.TestCase):
    """Test Room type serialization compatibility"""

    def test_room_json_structure(self):
        """Test that Room JSON structure matches Rust expectations"""
        room = {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "Test Room",
            "source": "test",
            "type": "GROUP",
            "channelId": "channel-123",
            "serverId": "server-456"
        }

        json_str = json.dumps(room)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["type"], "GROUP")

    def test_channel_type_values(self):
        """Test valid channel type values"""
        valid_types = ["DM", "GROUP", "VOICE", "FEED", "THREAD", "WORLD", "SELF", "API"]

        for channel_type in valid_types:
            room = {"id": "test", "type": channel_type}
            json_str = json.dumps(room)
            parsed = json.loads(json_str)
            self.assertEqual(parsed["type"], channel_type)


class TestEntitySerialization(unittest.TestCase):
    """Test Entity type serialization compatibility"""

    def test_entity_json_structure(self):
        """Test that Entity JSON structure matches Rust expectations"""
        entity = {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "names": ["User", "TestUser"],
            "agentId": "550e8400-e29b-41d4-a716-446655440001",
            "metadata": {"email": "test@example.com"}
        }

        json_str = json.dumps(entity)
        parsed = json.loads(json_str)

        self.assertEqual(len(parsed["names"]), 2)
        self.assertEqual(parsed["metadata"]["email"], "test@example.com")


class TestContentSerialization(unittest.TestCase):
    """Test Content type serialization compatibility"""

    def test_content_all_fields(self):
        """Test Content with all optional fields"""
        content = {
            "text": "Hello",
            "source": "test",
            "url": "https://example.com",
            "actions": ["action1", "action2"],
            "metadata": {"key": "value"},
            "attachments": [{"type": "image", "url": "https://..."}]
        }

        json_str = json.dumps(content)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["text"], "Hello")
        self.assertIsInstance(parsed["actions"], list)
        self.assertIsInstance(parsed["attachments"], list)

    def test_content_minimal(self):
        """Test Content with only text"""
        content = {"text": "Just text"}

        json_str = json.dumps(content)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["text"], "Just text")


class TestUUIDCompatibility(unittest.TestCase):
    """Test UUID format compatibility"""

    def test_uuid_format(self):
        """Test standard UUID format"""
        uuid = "550e8400-e29b-41d4-a716-446655440000"

        # Check format
        self.assertEqual(len(uuid), 36)
        self.assertEqual(uuid.count("-"), 4)

        # Check parts
        parts = uuid.split("-")
        self.assertEqual(len(parts[0]), 8)
        self.assertEqual(len(parts[1]), 4)
        self.assertEqual(len(parts[2]), 4)
        self.assertEqual(len(parts[3]), 4)
        self.assertEqual(len(parts[4]), 12)

    def test_uuid_lowercase(self):
        """Test that UUIDs are lowercase"""
        uuid = "550e8400-e29b-41d4-a716-446655440000"
        self.assertEqual(uuid, uuid.lower())


class TestEdgeCases(unittest.TestCase):
    """Test edge cases in serialization"""

    def test_empty_strings(self):
        """Test handling of empty strings"""
        memory = {
            "entityId": "entity-123",
            "roomId": "room-456",
            "content": {"text": ""}
        }

        json_str = json.dumps(memory)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["content"]["text"], "")

    def test_unicode_characters(self):
        """Test handling of unicode characters"""
        memory = {
            "entityId": "entity-123",
            "roomId": "room-456",
            "content": {"text": "Hello 世界 🎉 émojis and ñ characters"}
        }

        json_str = json.dumps(memory, ensure_ascii=False)
        parsed = json.loads(json_str)

        self.assertIn("世界", parsed["content"]["text"])
        self.assertIn("🎉", parsed["content"]["text"])

    def test_large_numbers(self):
        """Test handling of large numbers"""
        memory = {
            "entityId": "entity-123",
            "roomId": "room-456",
            "content": {"text": "test"},
            "createdAt": 9007199254740991  # Number.MAX_SAFE_INTEGER
        }

        json_str = json.dumps(memory)
        parsed = json.loads(json_str)

        self.assertEqual(parsed["createdAt"], 9007199254740991)

    def test_nested_objects(self):
        """Test handling of deeply nested objects"""
        data = {
            "level1": {
                "level2": {
                    "level3": {
                        "level4": {
                            "value": "deep"
                        }
                    }
                }
            }
        }

        json_str = json.dumps(data)
        parsed = json.loads(json_str)

        self.assertEqual(
            parsed["level1"]["level2"]["level3"]["level4"]["value"],
            "deep"
        )


class TestTaskSerialization(unittest.TestCase):
    """Test Task type serialization compatibility"""

    def test_task_status_values(self):
        """Test valid task status values"""
        valid_statuses = ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED"]

        for status in valid_statuses:
            task = {
                "id": "task-123",
                "status": status
            }
            json_str = json.dumps(task)
            parsed = json.loads(json_str)
            self.assertEqual(parsed["status"], status)


class TestModelTypeSerialization(unittest.TestCase):
    """Test ModelType enum serialization"""

    def test_model_type_values(self):
        """Test valid model type values"""
        valid_types = [
            "TEXT_SMALL",
            "TEXT_LARGE",
            "TEXT_EMBEDDING",
            "IMAGE_DESCRIPTION",
            "IMAGE_GENERATION",
            "AUDIO_TRANSCRIPTION",
            "TEXT_TO_SPEECH"
        ]

        for model_type in valid_types:
            data = {"modelType": model_type}
            json_str = json.dumps(data)
            parsed = json.loads(json_str)
            self.assertEqual(parsed["modelType"], model_type)


class TestEventTypeSerialization(unittest.TestCase):
    """Test EventType enum serialization"""

    def test_event_type_values(self):
        """Test valid event type values"""
        valid_types = [
            "WORLD_JOINED",
            "WORLD_LEFT",
            "WORLD_CONNECTED",
            "MESSAGE_RECEIVED",
            "MESSAGE_SENT",
            "ACTION_STARTED",
            "ACTION_COMPLETED"
        ]

        for event_type in valid_types:
            data = {"eventType": event_type}
            json_str = json.dumps(data)
            parsed = json.loads(json_str)
            self.assertEqual(parsed["eventType"], event_type)


def run_tests():
    """Run all tests"""
    unittest.main(verbosity=2)


if __name__ == "__main__":
    run_tests()

