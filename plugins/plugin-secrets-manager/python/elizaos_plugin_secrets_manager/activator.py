"""
Plugin Activator Service.

Manages dynamic plugin activation based on secret requirements.
"""

import asyncio
import logging
import time
from typing import Optional, Dict, List, Callable, Awaitable
from dataclasses import dataclass, field

from elizaos.runtime import AgentRuntime
from elizaos.types import Service, Plugin

from .types import (
    SecretLevel,
    SecretContext,
    PluginSecretRequirement,
    PluginRequirementStatus,
)
from .service import SecretsService


logger = logging.getLogger(__name__)


@dataclass
class PluginWithSecrets:
    """Extended plugin interface with secret requirements."""
    plugin: Plugin
    secret_requirements: Dict[str, PluginSecretRequirement]
    on_secrets_ready: Optional[Callable[[], Awaitable[None]]] = None


@dataclass
class PendingPluginActivation:
    """Tracks a pending plugin activation."""
    plugin: PluginWithSecrets
    activation_callback: Optional[Callable[[], Awaitable[None]]] = None
    last_check: int = 0
    status: Optional[PluginRequirementStatus] = None
    attempts: int = 0


class PluginActivatorService(Service):
    """
    Plugin Activator Service
    
    Manages dynamic plugin activation:
    - Registers plugins with their secret requirements
    - Monitors for secret changes
    - Activates plugins once all requirements are met
    - Supports polling for lazy activation
    """
    
    service_type = "PLUGIN_ACTIVATOR"
    
    def __init__(
        self,
        runtime: AgentRuntime,
        poll_interval_ms: int = 5000,
        max_poll_attempts: int = 100,
    ):
        self.runtime = runtime
        self.poll_interval_ms = poll_interval_ms
        self.max_poll_attempts = max_poll_attempts
        
        self._secrets_service: Optional[SecretsService] = None
        self._pending_plugins: Dict[str, PendingPluginActivation] = {}
        self._activated_plugins: Dict[str, PluginWithSecrets] = {}
        self._polling_task: Optional[asyncio.Task] = None
        self._is_running = False
        self._unsubscribe: Optional[Callable[[], None]] = None
    
    async def start(self) -> None:
        """Start the service."""
        logger.info("[PluginActivatorService] Starting")
        
        # Get secrets service
        self._secrets_service = self.runtime.get_service(SecretsService.service_type)
        if not self._secrets_service:
            logger.error("[PluginActivatorService] SecretsService not found, cannot activate")
            return
        
        # Subscribe to all secret changes
        self._unsubscribe = self._secrets_service.on_any_secret_changed(self._on_secret_changed)
        
        # Start polling
        self._is_running = True
        self._start_polling()
        
        logger.info("[PluginActivatorService] Started")
    
    async def stop(self) -> None:
        """Stop the service."""
        logger.info("[PluginActivatorService] Stopping")
        
        self._is_running = False
        
        if self._unsubscribe:
            self._unsubscribe()
            self._unsubscribe = None
        
        if self._polling_task and not self._polling_task.done():
            self._polling_task.cancel()
            try:
                await self._polling_task
            except asyncio.CancelledError:
                pass
            self._polling_task = None
        
        self._pending_plugins.clear()
        self._activated_plugins.clear()
        
        logger.info("[PluginActivatorService] Stopped")
    
    async def register_plugin(
        self,
        plugin: PluginWithSecrets,
        activation_callback: Optional[Callable[[], Awaitable[None]]] = None,
    ) -> bool:
        """Register a plugin for activation."""
        plugin_id = plugin.plugin.name if hasattr(plugin.plugin, "name") else str(id(plugin.plugin))
        
        if plugin_id in self._activated_plugins:
            logger.debug(f"[PluginActivatorService] Plugin {plugin_id} already activated")
            return True
        
        if plugin_id in self._pending_plugins:
            logger.debug(f"[PluginActivatorService] Plugin {plugin_id} already pending")
            return False
        
        # Check if requirements are already met
        if self._secrets_service:
            status = await self._secrets_service.check_plugin_requirements(
                plugin_id, plugin.secret_requirements
            )
            
            if status.ready:
                await self._activate_plugin(plugin, activation_callback)
                return True
            
            logger.info(
                f"[PluginActivatorService] Plugin {plugin_id} pending: {status.message}"
            )
        
        # Add to pending
        self._pending_plugins[plugin_id] = PendingPluginActivation(
            plugin=plugin,
            activation_callback=activation_callback,
            last_check=int(time.time() * 1000),
        )
        
        return False
    
    async def unregister_plugin(self, plugin_id: str) -> bool:
        """Unregister a plugin."""
        if plugin_id in self._pending_plugins:
            del self._pending_plugins[plugin_id]
            return True
        
        if plugin_id in self._activated_plugins:
            del self._activated_plugins[plugin_id]
            return True
        
        return False
    
    def get_pending_plugins(self) -> List[PendingPluginActivation]:
        """Get list of pending plugins."""
        return list(self._pending_plugins.values())
    
    def get_activated_plugins(self) -> List[str]:
        """Get list of activated plugin IDs."""
        return list(self._activated_plugins.keys())
    
    async def check_plugin_status(self, plugin_id: str) -> Optional[PluginRequirementStatus]:
        """Check the status of a specific plugin."""
        if not self._secrets_service:
            return None
        
        if plugin_id in self._activated_plugins:
            return PluginRequirementStatus(
                plugin_id=plugin_id,
                ready=True,
                missing_required=[],
                missing_optional=[],
                invalid=[],
                message="Already activated",
            )
        
        pending = self._pending_plugins.get(plugin_id)
        if not pending:
            return None
        
        return await self._secrets_service.check_plugin_requirements(
            plugin_id, pending.plugin.secret_requirements
        )
    
    async def force_check(self) -> int:
        """Force check all pending plugins. Returns number activated."""
        activated = 0
        
        to_remove = []
        
        for plugin_id, pending in self._pending_plugins.items():
            if await self._try_activate(plugin_id, pending):
                to_remove.append(plugin_id)
                activated += 1
        
        for plugin_id in to_remove:
            del self._pending_plugins[plugin_id]
        
        return activated
    
    async def _on_secret_changed(
        self,
        key: str,
        value: Optional[str],
        context: SecretContext,
    ) -> None:
        """Handle secret change events."""
        if context.level != SecretLevel.GLOBAL:
            return
        
        logger.debug(f"[PluginActivatorService] Secret changed: {key}")
        
        # Check plugins that might need this secret
        to_remove = []
        
        for plugin_id, pending in self._pending_plugins.items():
            if key in pending.plugin.secret_requirements:
                if await self._try_activate(plugin_id, pending):
                    to_remove.append(plugin_id)
        
        for plugin_id in to_remove:
            del self._pending_plugins[plugin_id]
    
    async def _try_activate(
        self,
        plugin_id: str,
        pending: PendingPluginActivation,
    ) -> bool:
        """Try to activate a pending plugin. Returns True if activated."""
        if not self._secrets_service:
            return False
        
        pending.attempts += 1
        pending.last_check = int(time.time() * 1000)
        
        status = await self._secrets_service.check_plugin_requirements(
            plugin_id, pending.plugin.secret_requirements
        )
        pending.status = status
        
        if status.ready:
            await self._activate_plugin(pending.plugin, pending.activation_callback)
            return True
        
        return False
    
    async def _activate_plugin(
        self,
        plugin: PluginWithSecrets,
        callback: Optional[Callable[[], Awaitable[None]]] = None,
    ) -> None:
        """Activate a plugin."""
        plugin_id = plugin.plugin.name if hasattr(plugin.plugin, "name") else str(id(plugin.plugin))
        
        logger.info(f"[PluginActivatorService] Activating plugin: {plugin_id}")
        
        # Call plugin's onSecretsReady if defined
        if plugin.on_secrets_ready:
            await plugin.on_secrets_ready()
        
        # Call activation callback
        if callback:
            await callback()
        
        # Mark as activated
        self._activated_plugins[plugin_id] = plugin
        
        logger.info(f"[PluginActivatorService] Plugin activated: {plugin_id}")
    
    def _start_polling(self) -> None:
        """Start the polling task."""
        if self._polling_task and not self._polling_task.done():
            return
        
        self._polling_task = asyncio.create_task(self._poll_loop())
    
    async def _poll_loop(self) -> None:
        """Polling loop for checking pending plugins."""
        logger.debug("[PluginActivatorService] Polling started")
        
        while self._is_running:
            await asyncio.sleep(self.poll_interval_ms / 1000)
            
            if not self._pending_plugins:
                continue
            
            to_remove = []
            
            for plugin_id, pending in list(self._pending_plugins.items()):
                # Skip if max attempts reached
                if pending.attempts >= self.max_poll_attempts:
                    logger.warning(
                        f"[PluginActivatorService] Max attempts reached for {plugin_id}"
                    )
                    continue
                
                if await self._try_activate(plugin_id, pending):
                    to_remove.append(plugin_id)
            
            for plugin_id in to_remove:
                if plugin_id in self._pending_plugins:
                    del self._pending_plugins[plugin_id]
        
        logger.debug("[PluginActivatorService] Polling stopped")
