"""List ejected plugins action.

Reports all plugins that have been ejected (cloned locally for development)
and are being managed outside the normal npm workflow.

Ported from plugin-manager/actions/listEjectedPluginsAction.ts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

    from ..service import PluginManagerService


@dataclass
class ListEjectedPluginsAction:
    name: str = "LIST_EJECTED_PLUGINS"
    similes: list[str] = field(
        default_factory=lambda: [
            "LIST_EJECTED",
            "SHOW_EJECTED_PLUGINS",
            "WHICH_PLUGINS_ARE_EJECTED",
            "LIST_LOCAL_PLUGINS",
        ]
    )
    description: str = "List all ejected plugins currently being managed locally"

    async def validate(
        self, runtime: IAgentRuntime, message: Memory, _state: State | None = None
    ) -> bool:
        text = ""
        if message.content:
            text = getattr(message.content, "text", "") or ""
        text = text.lower()
        if "ejected" not in text or "plugin" not in text:
            return False
        # Confirm the plugin manager service is available
        for svc in (runtime.services or {}).values():
            if getattr(svc, "service_type", None) == "plugin_manager":
                return True
        return False

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
            msg = "Plugin manager service not available"
            if callback:
                await callback(Content(text=msg))
            return ActionResult(text=msg, success=False)

        try:
            plugins = await pm_svc.list_ejected_plugins()

            if not plugins:
                msg = "No ejected plugins found."
                if callback:
                    await callback(Content(text=msg))
                return ActionResult(text=msg, success=True)

            lines = [f"- {p.name} (v{p.version}) at {p.path}" for p in plugins]
            text = "Ejected Plugins:\n" + "\n".join(lines)
            if callback:
                await callback(Content(text=text))

            return ActionResult(
                text=text,
                values={"success": True, "ejectedCount": len(plugins)},
                data={
                    "actionName": "LIST_EJECTED_PLUGINS",
                    "ejectedPlugins": [
                        {"name": p.name, "version": p.version, "path": p.path} for p in plugins
                    ],
                },
                success=True,
            )

        except Exception as exc:
            msg = f"Error listing ejected plugins: {exc}"
            if callback:
                await callback(Content(text=msg))
            return ActionResult(text=msg, success=False)

    @property
    def examples(self) -> list:
        return []


_inst = ListEjectedPluginsAction()

list_ejected_action = Action(
    name=_inst.name,
    similes=_inst.similes,
    description=_inst.description,
    validate=_inst.validate,
    handler=_inst.handler,
    examples=_inst.examples,
)
