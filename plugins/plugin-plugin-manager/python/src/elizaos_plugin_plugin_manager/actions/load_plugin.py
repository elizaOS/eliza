"""LOAD_PLUGIN action - loads a plugin that is in ready or unloaded state."""

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
from elizaos_plugin_plugin_manager.types import LoadPluginParams, PluginStatus

logger = logging.getLogger(__name__)


async def _validate(
    runtime: RuntimeProtocol, message: Memory, state: State | None
) -> bool:
    service = runtime.get_service("plugin_manager")
    if not isinstance(service, PluginManagerService):
        return False
    plugins = service.get_all_plugins()
    return any(p.status in (PluginStatus.READY, PluginStatus.UNLOADED) for p in plugins)


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

    # Find plugin to load - try exact match first
    plugin_to_load = next(
        (
            p
            for p in plugins
            if p.name.lower() in message_text
            and p.status in (PluginStatus.READY, PluginStatus.UNLOADED)
        ),
        None,
    )

    if plugin_to_load is None:
        plugin_to_load = next(
            (p for p in plugins if p.status in (PluginStatus.READY, PluginStatus.UNLOADED)),
            None,
        )

    if plugin_to_load is None:
        text = "No plugins are available to load. All plugins are either already loaded or have errors."
        if callback:
            await callback({"text": text})
        return ActionResult(text=text, success=False)

    logger.info("[loadPluginAction] Loading plugin: %s", plugin_to_load.name)

    try:
        service.load_plugin(LoadPluginParams(plugin_id=plugin_to_load.id))
        text = f"Successfully loaded plugin: {plugin_to_load.name}"
        if callback:
            await callback({"text": text})
        return ActionResult(text=text, success=True)
    except Exception as e:
        text = f"Failed to load plugin {plugin_to_load.name}: {e}"
        logger.error("[loadPluginAction] %s", text)
        if callback:
            await callback({"text": text})
        return ActionResult(text=text, success=False)


load_plugin_action = create_action(
    name="LOAD_PLUGIN",
    description="Load a plugin that is currently in the ready or unloaded state",
    similes=["load plugin", "enable plugin", "activate plugin", "start plugin"],
    examples=[
        [
            ActionExample(
                name="Autoliza",
                content={"text": "I need to load the shell plugin", "actions": ["LOAD_PLUGIN"]},
            ),
            ActionExample(
                name="Autoliza",
                content={"text": "Loading the shell plugin now.", "actions": ["LOAD_PLUGIN"]},
            ),
        ],
    ],
    validate=_validate,
    handler=_handler,
)
