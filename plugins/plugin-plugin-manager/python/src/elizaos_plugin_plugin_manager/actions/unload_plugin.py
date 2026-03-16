"""UNLOAD_PLUGIN action - unloads a currently loaded plugin."""

from __future__ import annotations

import logging

from elizaos_plugin_plugin_manager.actions.base import (
    Action,
    ActionExample,
    ActionResult,
    HandlerCallback,
    Memory,
    RuntimeProtocol,
    State,
    create_action,
)
from elizaos_plugin_plugin_manager.services.plugin_manager_service import PluginManagerService
from elizaos_plugin_plugin_manager.types import PluginStatus, UnloadPluginParams

logger = logging.getLogger(__name__)


async def _validate(
    runtime: RuntimeProtocol, message: Memory, state: State | None
) -> bool:
    service = runtime.get_service("plugin_manager")
    if not isinstance(service, PluginManagerService):
        return False
    plugins = service.get_all_plugins()
    return any(
        p.status == PluginStatus.LOADED and service.can_unload_plugin(p.name) for p in plugins
    )


async def _handler(
    runtime: RuntimeProtocol,
    message: Memory,
    state: State | None,
    options: dict[str, str | int | float | bool | None] | None,
    callback: HandlerCallback | None,
) -> ActionResult:
    service = runtime.get_service("plugin_manager")
    if not isinstance(service, PluginManagerService):
        if callback:
            await callback({"text": "Plugin Manager service is not available."})
        return ActionResult(text="Plugin Manager service is not available.", success=False)

    message_text = str(message.get("content", {}).get("text", "")).lower()  # type: ignore[union-attr]
    plugins = service.get_all_plugins()

    # Find plugin to unload - try exact match
    plugin_to_unload = next(
        (
            p
            for p in plugins
            if p.name.lower() in message_text and p.status == PluginStatus.LOADED
        ),
        None,
    )

    if plugin_to_unload is None:
        unloadable = [
            p
            for p in plugins
            if p.status == PluginStatus.LOADED and service.can_unload_plugin(p.name)
        ]
        if not unloadable:
            text = "No plugins are currently loaded that can be unloaded. All loaded plugins are protected system plugins."
            if callback:
                await callback({"text": text})
            return ActionResult(text=text, success=False)

        names = ", ".join(p.name for p in unloadable)
        text = f"Please specify which plugin to unload. Available plugins that can be unloaded: {names}"
        if callback:
            await callback({"text": text})
        return ActionResult(text=text, success=False)

    if not service.can_unload_plugin(plugin_to_unload.name):
        reason = service.get_protection_reason(plugin_to_unload.name) or "Plugin is protected"
        text = f"Cannot unload plugin: {reason}"
        if callback:
            await callback({"text": text})
        return ActionResult(text=text, success=False)

    logger.info("[unloadPluginAction] Unloading plugin: %s", plugin_to_unload.name)

    try:
        service.unload_plugin(UnloadPluginParams(plugin_id=plugin_to_unload.id))
        text = f"Successfully unloaded plugin: {plugin_to_unload.name}"
        if callback:
            await callback({"text": text})
        return ActionResult(text=text, success=True)
    except Exception as e:
        text = f"Failed to unload plugin {plugin_to_unload.name}: {e}"
        logger.error("[unloadPluginAction] %s", text)
        if callback:
            await callback({"text": text})
        return ActionResult(text=text, success=False)


unload_plugin_action = create_action(
    name="UNLOAD_PLUGIN",
    description="Unload a plugin that is currently loaded (except original plugins)",
    similes=["unload plugin", "disable plugin", "deactivate plugin", "stop plugin", "remove plugin"],
    examples=[
        [
            ActionExample(
                name="Autoliza",
                content={"text": "I need to unload the example-plugin", "actions": ["UNLOAD_PLUGIN"]},
            ),
            ActionExample(
                name="Autoliza",
                content={"text": "Unloading the example-plugin now.", "actions": ["UNLOAD_PLUGIN"]},
            ),
        ],
    ],
    validate=_validate,
    handler=_handler,
)
