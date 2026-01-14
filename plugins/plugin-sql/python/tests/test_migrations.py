"""Tests for migration service using real PostgreSQL via testcontainers."""

from __future__ import annotations

import hashlib
import time
from typing import TYPE_CHECKING

import pytest

from elizaos_plugin_sql.migration_service import MigrationService, derive_schema_name

if TYPE_CHECKING:
    pass


class TestMigrationService:
    @pytest.mark.asyncio
    async def test_initialization(self, migration_service: MigrationService) -> None:
        # Service should be initialized without errors
        assert migration_service is not None

    @pytest.mark.asyncio
    async def test_record_migration(self, migration_service: MigrationService) -> None:
        plugin_name = "@test/plugin-example"
        test_hash = hashlib.sha256(b"test schema").hexdigest()
        created_at = int(time.time() * 1000)

        await migration_service.record_migration(plugin_name, test_hash, created_at)

        # Verify migration was recorded
        last_migration = await migration_service.get_last_migration(plugin_name)
        assert last_migration is not None
        assert last_migration["hash"] == test_hash
        assert last_migration["created_at"] == created_at

    @pytest.mark.asyncio
    async def test_save_and_get_snapshot(self, migration_service: MigrationService) -> None:
        plugin_name = "@test/plugin-snapshot"
        snapshot = {
            "version": "0.0.1",
            "tables": {
                "test_table": {
                    "name": "test_table",
                    "columns": {
                        "id": {"type": "uuid", "primaryKey": True},
                        "name": {"type": "text", "notNull": True},
                    },
                },
            },
        }

        await migration_service.save_snapshot(plugin_name, 0, snapshot)

        # Retrieve snapshot
        retrieved = await migration_service.get_latest_snapshot(plugin_name)
        assert retrieved is not None
        assert retrieved["version"] == "0.0.1"
        assert "test_table" in retrieved["tables"]

    @pytest.mark.asyncio
    async def test_hash_snapshot(self, migration_service: MigrationService) -> None:
        snapshot1 = {"tables": {"a": 1, "b": 2}}
        snapshot2 = {"tables": {"b": 2, "a": 1}}  # Same content, different order
        snapshot3 = {"tables": {"a": 1, "c": 3}}  # Different content

        hash1 = migration_service.hash_snapshot(snapshot1)
        hash2 = migration_service.hash_snapshot(snapshot2)
        hash3 = migration_service.hash_snapshot(snapshot3)

        # Same content should produce same hash (JSON is sorted)
        assert hash1 == hash2
        # Different content should produce different hash
        assert hash1 != hash3

    @pytest.mark.asyncio
    async def test_get_status(self, migration_service: MigrationService) -> None:
        plugin_name = "@test/plugin-status-test"

        # Initial status (no migrations)
        status = await migration_service.get_status(plugin_name)
        assert status["hasRun"] is False
        assert status["snapshots"] == 0

        # Record a migration and snapshot
        test_hash = hashlib.sha256(b"test schema").hexdigest()
        await migration_service.record_migration(plugin_name, test_hash)
        await migration_service.save_snapshot(plugin_name, 0, {"version": "1.0"})

        # Status after migration
        status = await migration_service.get_status(plugin_name)
        assert status["hasRun"] is True
        assert status["lastMigration"] is not None
        assert status["snapshots"] == 1

    @pytest.mark.asyncio
    async def test_multiple_migrations(self, migration_service: MigrationService) -> None:
        plugin_name = "@test/plugin-multi"

        # Record first migration
        hash1 = hashlib.sha256(b"schema v1").hexdigest()
        await migration_service.record_migration(plugin_name, hash1)
        await migration_service.save_snapshot(plugin_name, 0, {"version": "1"})

        # Record second migration
        hash2 = hashlib.sha256(b"schema v2").hexdigest()
        await migration_service.record_migration(plugin_name, hash2)
        await migration_service.save_snapshot(plugin_name, 1, {"version": "2"})

        # Last migration should be the second one
        last = await migration_service.get_last_migration(plugin_name)
        assert last is not None
        assert last["hash"] == hash2

        # Should have 2 snapshots
        status = await migration_service.get_status(plugin_name)
        assert status["snapshots"] == 2

    @pytest.mark.asyncio
    async def test_multiple_plugins(self, migration_service: MigrationService) -> None:
        plugin1 = "@test/plugin-one"
        plugin2 = "@test/plugin-two"

        hash1 = hashlib.sha256(b"plugin one schema").hexdigest()
        hash2 = hashlib.sha256(b"plugin two schema").hexdigest()

        await migration_service.record_migration(plugin1, hash1)
        await migration_service.record_migration(plugin2, hash2)

        # Each plugin should have its own migration
        last1 = await migration_service.get_last_migration(plugin1)
        last2 = await migration_service.get_last_migration(plugin2)

        assert last1 is not None
        assert last2 is not None
        assert last1["hash"] == hash1
        assert last2["hash"] == hash2
        assert last1["hash"] != last2["hash"]


class TestPluginSchemaNamespacing:
    def test_derive_schema_name(self) -> None:
        # Core plugin uses public schema
        assert derive_schema_name("@elizaos/plugin-sql") == "public"

        # npm scope and plugin- prefix are removed
        assert derive_schema_name("@your-org/plugin-name") == "name"
        assert derive_schema_name("@elizaos/plugin-bootstrap") == "bootstrap"

    def test_simple_names(self) -> None:
        assert derive_schema_name("my-plugin") == "my_plugin"
        assert derive_schema_name("plugin-test") == "test"

    def test_special_characters_normalized(self) -> None:
        assert derive_schema_name("@org/plugin.name!") == "plugin_name"

    def test_numeric_prefix_handled(self) -> None:
        assert derive_schema_name("123plugin") == "p_123plugin"

    def test_lowercase_conversion(self) -> None:
        assert derive_schema_name("@MyOrg/MyPlugin") == "myplugin"
        assert derive_schema_name("@MyOrg/plugin-MyPlugin") == "myplugin"

    def test_reserved_names_handled(self) -> None:
        # "public" alone would be reserved, so it gets prefixed
        result = derive_schema_name("@org/plugin-public")
        assert result.startswith("plugin_")

    def test_no_special_chars(self) -> None:
        assert derive_schema_name("myplugin") == "myplugin"
        assert derive_schema_name("MyPlugin") == "myplugin"

    @pytest.mark.asyncio
    async def test_create_schema_for_plugin(self, migration_service: MigrationService) -> None:
        schema_name = "test_custom_schema"

        # The migration service should be able to create plugin schemas
        await migration_service.ensure_schema_exists(schema_name)

        # Record a migration for this plugin
        plugin_name = "@custom-org/my-plugin"
        test_hash = hashlib.sha256(b"custom plugin schema").hexdigest()
        await migration_service.record_migration(plugin_name, test_hash)

        # Verify migration was recorded
        status = await migration_service.get_status(plugin_name)
        assert status["hasRun"] is True

    @pytest.mark.asyncio
    async def test_invalid_schema_name_rejected(self, migration_service: MigrationService) -> None:
        # Schema names with special characters should be rejected
        with pytest.raises(ValueError, match="Invalid schema name"):
            await migration_service.ensure_schema_exists("invalid-name")

        with pytest.raises(ValueError, match="Invalid schema name"):
            await migration_service.ensure_schema_exists("invalid.name")

        with pytest.raises(ValueError, match="Invalid schema name"):
            await migration_service.ensure_schema_exists("invalid/name")

    @pytest.mark.asyncio
    async def test_public_schema_always_exists(self, migration_service: MigrationService) -> None:
        # Should not raise any errors
        await migration_service.ensure_schema_exists("public")


class TestMigrationEdgeCases:
    @pytest.mark.asyncio
    async def test_empty_snapshot(self, migration_service: MigrationService) -> None:
        plugin_name = "@test/empty-snapshot"
        empty_snapshot: dict[str, object] = {}

        await migration_service.save_snapshot(plugin_name, 0, empty_snapshot)

        retrieved = await migration_service.get_latest_snapshot(plugin_name)
        assert retrieved is not None
        assert retrieved == {}

    @pytest.mark.asyncio
    async def test_large_snapshot(self, migration_service: MigrationService) -> None:
        plugin_name = "@test/large-snapshot"
        # Create a large snapshot with many tables
        large_snapshot = {
            "version": "1.0.0",
            "tables": {f"table_{i}": {"id": i, "data": "x" * 100} for i in range(100)},
        }

        await migration_service.save_snapshot(plugin_name, 0, large_snapshot)

        retrieved = await migration_service.get_latest_snapshot(plugin_name)
        assert retrieved is not None
        assert len(retrieved["tables"]) == 100

    @pytest.mark.asyncio
    async def test_unicode_in_snapshot(self, migration_service: MigrationService) -> None:
        plugin_name = "@test/unicode-snapshot"
        unicode_snapshot = {
            "description": "Unicode test: 你好世界 🚀 émojis 日本語",
            "data": {"key": "value with émojis 🎉"},
        }

        await migration_service.save_snapshot(plugin_name, 0, unicode_snapshot)

        retrieved = await migration_service.get_latest_snapshot(plugin_name)
        assert retrieved is not None
        assert retrieved["description"] == "Unicode test: 你好世界 🚀 émojis 日本語"

    @pytest.mark.asyncio
    async def test_timestamp_ordering(self, migration_service: MigrationService) -> None:
        plugin_name = "@test/timestamp-order"
        base_time = int(time.time() * 1000)

        # Record migrations with specific timestamps (out of order)
        await migration_service.record_migration(plugin_name, "hash_3", base_time + 3000)
        await migration_service.record_migration(plugin_name, "hash_1", base_time + 1000)
        await migration_service.record_migration(plugin_name, "hash_2", base_time + 2000)

        # The last migration should be the one with the latest timestamp
        last = await migration_service.get_last_migration(plugin_name)
        assert last is not None
        assert last["hash"] == "hash_3"

    @pytest.mark.asyncio
    async def test_get_expected_schema_name(self, migration_service: MigrationService) -> None:
        schema = await migration_service.get_expected_schema_name("@elizaos/plugin-sql")
        assert schema == "public"

        schema = await migration_service.get_expected_schema_name("@my-org/plugin-name")
        assert schema == "name"
