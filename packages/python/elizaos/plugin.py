from __future__ import annotations

import importlib
from typing import TYPE_CHECKING

from elizaos.logger import logger
from elizaos.types.plugin import Plugin

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime


class PluginLoadError(Exception):
    def __init__(self, message: str, plugin_name: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.plugin_name = plugin_name
        self.cause = cause


class PluginRegistrationError(Exception):
    def __init__(self, message: str, plugin_name: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.plugin_name = plugin_name
        self.cause = cause


def load_plugin(name: str) -> Plugin:
    try:
        module = importlib.import_module(name)
        if hasattr(module, "plugin"):
            plugin = module.plugin
            if isinstance(plugin, Plugin):
                logger.debug(f"Loaded plugin: {plugin.name}")
                return plugin
            if isinstance(plugin, dict):
                return Plugin(**plugin)
        if hasattr(module, "default"):
            default = module.default
            if isinstance(default, Plugin):
                logger.debug(f"Loaded plugin from default export: {default.name}")
                return default
            if isinstance(default, dict):
                return Plugin(**default)

        raise PluginLoadError(
            f"Module {name} does not export a valid plugin",
            plugin_name=name,
        )

    except ImportError as e:
        raise PluginLoadError(
            f"Failed to import plugin module: {name}",
            plugin_name=name,
            cause=e,
        ) from e
    except Exception as e:
        raise PluginLoadError(
            f"Failed to load plugin {name}: {e}",
            plugin_name=name,
            cause=e,
        ) from e


async def register_plugin(runtime: IAgentRuntime, plugin: Plugin) -> None:
    try:
        logger.info(f"Registering plugin: {plugin.name}")
        # Use getattr for optional plugin attributes to handle non-standard plugins
        dependencies = getattr(plugin, "dependencies", None)
        if dependencies:
            for dep in dependencies:
                if dep not in [p.name for p in runtime.plugins]:
                    raise PluginRegistrationError(
                        f"Missing dependency: {dep}",
                        plugin_name=plugin.name,
                    )

        init_fn = getattr(plugin, "init", None)
        if init_fn:
            config = getattr(plugin, "config", None) or {}
            # Handle different init signatures
            import inspect

            sig = inspect.signature(init_fn)
            params = list(sig.parameters.values())
            # Filter out 'self' parameter for bound methods
            non_self_params = [p for p in params if p.name != "self"]
            if len(non_self_params) >= 2:
                await init_fn(config, runtime)
            elif len(non_self_params) == 1:
                await init_fn(config)
            else:
                await init_fn()

        actions = getattr(plugin, "actions", None)
        if actions:
            for action in actions:
                runtime.register_action(action)
                logger.debug(f"Registered action: {action.name}")

        providers = getattr(plugin, "providers", None)
        if providers:
            for provider in providers:
                runtime.register_provider(provider)
                logger.debug(f"Registered provider: {provider.name}")

        evaluators = getattr(plugin, "evaluators", None)
        if evaluators:
            for evaluator in evaluators:
                runtime.register_evaluator(evaluator)
                logger.debug(f"Registered evaluator: {evaluator.name}")

        services = getattr(plugin, "services", None)
        if services:
            for service_class in services:
                await runtime.register_service(service_class)
                logger.debug(
                    f"Registered service: {getattr(service_class, 'service_type', 'unknown')}"
                )

        models = getattr(plugin, "models", None)
        if models:
            for model_type, handler in models.items():
                runtime.register_model(
                    model_type,
                    handler,
                    provider=plugin.name,
                )
                logger.debug(f"Registered model: {model_type}")

        streaming_models = getattr(plugin, "streaming_models", None)
        if streaming_models:
            for model_type, handler in streaming_models.items():
                runtime.register_streaming_model(
                    model_type,
                    handler,
                    provider=plugin.name,
                )
                logger.debug(f"Registered streaming model: {model_type}")

        events = getattr(plugin, "events", None)
        if events:
            for event_type, event_handlers in events.items():
                for event_handler in event_handlers:
                    runtime.register_event(event_type, event_handler)
                logger.debug(f"Registered event handlers for: {event_type}")

        logger.info(f"Plugin registered successfully: {plugin.name}")

    except PluginRegistrationError:
        raise
    except Exception as e:
        raise PluginRegistrationError(
            f"Failed to register plugin {plugin.name}: {e}",
            plugin_name=plugin.name,
            cause=e,
        ) from e


def resolve_plugin_dependencies(plugins: list[Plugin]) -> list[Plugin]:
    plugin_map = {p.name: p for p in plugins}
    resolved: list[Plugin] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str) -> None:
        if name in visited:
            return
        if name in visiting:
            raise PluginLoadError(
                f"Circular dependency detected: {name}",
                plugin_name=name,
            )

        visiting.add(name)
        plugin = plugin_map.get(name)

        if plugin and plugin.dependencies:
            for dep in plugin.dependencies:
                if dep in plugin_map:
                    visit(dep)

        visiting.remove(name)
        visited.add(name)

        if plugin:
            resolved.append(plugin)

    for plugin in plugins:
        visit(plugin.name)

    return resolved
