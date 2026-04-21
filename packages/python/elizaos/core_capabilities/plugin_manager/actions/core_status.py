"""Core status action.

Reports the current status of the plugin system including loaded plugins,
component counts, and any errors.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

    from ..service import PluginManagerService


@dataclass
class CoreStatusAction:
    name: str = "CORE_STATUS"
    similes: list[str] = field(
        default_factory=lambda: ["PLUGIN_STATUS", "SYSTEM_STATUS", "SHOW_PLUGINS"]
    )
    description: str = "Show the current status of loaded plugins and core system components"

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, _state: State | None = None
    ) -> bool:
        return True

    async def handler(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        pm_svc: PluginManagerService | None = None
        for svc in (runtime.services or {}).values():
            if getattr(svc, "service_type", None) == "plugin_manager":
                pm_svc = svc  # type: ignore[assignment]
                break

        if pm_svc is None:
            return ActionResult(text="Plugin manager service is not available.", success=False)

        plugins = pm_svc.get_all_plugins()
        status_summary = pm_svc.get_status_summary()
        component_counts = pm_svc.get_total_component_count()

        lines = ["# Core System Status"]
        lines.append(f"\nTotal plugins: {len(plugins)}")
        for status, count in sorted(status_summary.items()):
            lines.append(f"  {status}: {count}")
        lines.append(f"\nComponents: {component_counts}")
        lines.append("\n## Loaded Plugins")

        for plugin in sorted(plugins, key=lambda p: p.name):
            error_info = f" [ERROR: {plugin.error}]" if plugin.error else ""
            comp_info = ""
            if plugin.components:
                parts = []
                if plugin.components.actions:
                    parts.append(f"{len(plugin.components.actions)} actions")
                if plugin.components.providers:
                    parts.append(f"{len(plugin.components.providers)} providers")
                if plugin.components.evaluators:
                    parts.append(f"{len(plugin.components.evaluators)} evaluators")
                if plugin.components.services:
                    parts.append(f"{len(plugin.components.services)} services")
                if parts:
                    comp_info = f" ({', '.join(parts)})"

            lines.append(f"- {plugin.name}: {plugin.status.value}{comp_info}{error_info}")

        text = "\n".join(lines)

        if callback:
            await callback(Content(text=text, actions=["CORE_STATUS"]))

        return ActionResult(
            text=text,
            values={
                "success": True,
                "pluginCount": len(plugins),
                "statusSummary": status_summary,
            },
            data={
                "actionName": "CORE_STATUS",
                "plugins": [
                    {
                        "name": p.name,
                        "status": p.status.value,
                        "error": p.error,
                    }
                    for p in plugins
                ],
                "componentCounts": component_counts,
            },
            success=True,
        )

    @property
    def examples(self) -> list:
        return []


_inst = CoreStatusAction()

core_status_action = Action(
    name=_inst.name,
    similes=_inst.similes,
    description=_inst.description,
    validate=_inst.validate,
    handler=_inst.handler,
    examples=_inst.examples,
)
