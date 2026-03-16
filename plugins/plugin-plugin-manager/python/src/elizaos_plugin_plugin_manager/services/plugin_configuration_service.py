"""Plugin Configuration Service - checks plugin config schemas against runtime settings."""

from __future__ import annotations

import logging

from elizaos_plugin_plugin_manager.types import PluginConfigStatus

logger = logging.getLogger(__name__)


class PluginConfigurationService:
    """Checks plugin configuration status against runtime settings."""

    service_type = "plugin_configuration"

    def __init__(self) -> None:
        logger.info("[PluginConfigurationService] Started")

    def get_missing_config_keys(
        self,
        config: dict[str, str | None],
        env_vars: dict[str, str],
    ) -> list[str]:
        """Check which config keys are missing.

        A key is "missing" if its default value is None or empty string
        AND no environment variable is set for it.
        """
        missing: list[str] = []
        for key, default_value in config.items():
            is_empty = default_value is None or default_value == ""
            if is_empty and key not in env_vars:
                missing.append(key)
        return missing

    def get_plugin_config_status(
        self,
        config: dict[str, str | None],
        env_vars: dict[str, str],
    ) -> PluginConfigStatus:
        """Get configuration status for a plugin's config map."""
        missing_keys = self.get_missing_config_keys(config, env_vars)
        return PluginConfigStatus(
            configured=len(missing_keys) == 0,
            missing_keys=missing_keys,
            total_keys=len(config),
        )

    def stop(self) -> None:
        """Stop the service."""
        logger.info("[PluginConfigurationService] Stopped")
