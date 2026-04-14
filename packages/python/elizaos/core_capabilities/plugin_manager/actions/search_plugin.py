"""Search plugin action.

Allows searching loaded plugins by name or component and returning
details about matching plugins.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

    from ..service import PluginManagerService


@dataclass
class SearchPluginAction:
    name: str = "SEARCH_PLUGIN"
    similes: list[str] = field(
        default_factory=lambda: ["FIND_PLUGIN", "PLUGIN_SEARCH", "LOOKUP_PLUGIN"]
    )
    description: str = "Search for a plugin by name or component and return details"

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

        query = (message.content.text if message.content else "").strip().lower()
        if not query:
            msg = "Please provide a search query (plugin name or component name)."
            if callback:
                await callback(Content(text=msg, actions=["SEARCH_PLUGIN"]))
            return ActionResult(text=msg, success=False)

        all_plugins = pm_svc.get_all_plugins()
        matches = []

        for plugin in all_plugins:
            # Match on plugin name
            if query in plugin.name.lower():
                matches.append(plugin)
                continue
            # Match on component names
            if plugin.components:
                all_component_names = (
                    plugin.components.actions
                    | plugin.components.providers
                    | plugin.components.evaluators
                    | plugin.components.services
                )
                if any(query in cn.lower() for cn in all_component_names):
                    matches.append(plugin)

        if not matches:
            msg = f"No plugins found matching '{query}'."
            if callback:
                await callback(Content(text=msg, actions=["SEARCH_PLUGIN"]))
            return ActionResult(text=msg, values={"matchCount": 0}, success=True)

        lines = [f"# Plugin Search Results for '{query}'", f"Found {len(matches)} match(es):\n"]
        for plugin in matches:
            lines.append(f"## {plugin.name}")
            lines.append(f"  Status: {plugin.status.value}")
            if plugin.version:
                lines.append(f"  Version: {plugin.version}")
            if plugin.components:
                if plugin.components.actions:
                    lines.append(f"  Actions: {', '.join(sorted(plugin.components.actions))}")
                if plugin.components.providers:
                    lines.append(f"  Providers: {', '.join(sorted(plugin.components.providers))}")
                if plugin.components.evaluators:
                    lines.append(f"  Evaluators: {', '.join(sorted(plugin.components.evaluators))}")
                if plugin.components.services:
                    lines.append(f"  Services: {', '.join(sorted(plugin.components.services))}")
            lines.append("")

        text = "\n".join(lines)

        if callback:
            await callback(Content(text=text, actions=["SEARCH_PLUGIN"]))

        return ActionResult(
            text=text,
            values={"success": True, "matchCount": len(matches)},
            data={
                "actionName": "SEARCH_PLUGIN",
                "query": query,
                "matches": [{"name": p.name, "status": p.status.value} for p in matches],
            },
            success=True,
        )

    @property
    def examples(self) -> list:
        return []


_inst = SearchPluginAction()

search_plugin_action = Action(
    name=_inst.name,
    similes=_inst.similes,
    description=_inst.description,
    validate=_inst.validate,
    handler=_inst.handler,
    examples=_inst.examples,
)
