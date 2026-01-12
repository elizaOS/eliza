import json
from dataclasses import dataclass


@dataclass
class ActionContext:
    message_text: str
    state: dict


@dataclass
class ActionResult:
    success: bool
    text: str
    data: dict | None = None
    error: str | None = None


class CreatePluginAction:
    name = "createPlugin"
    description = "Create a new plugin from a specification using AI assistance"
    similes = [
        "generate plugin",
        "build plugin",
        "make plugin",
        "develop plugin",
        "create extension",
        "build extension",
    ]

    async def validate(self, context: ActionContext) -> bool:
        """Check if this action should run."""
        # Check if there's no active job running
        active_jobs = context.state.get("activeJobs", [])
        for job in active_jobs:
            if job.get("status") in ("running", "pending"):
                return False

        # Check if message contains valid JSON specification
        return "{" in context.message_text and "}" in context.message_text

    async def execute(self, context: ActionContext) -> ActionResult:
        try:
            spec = json.loads(context.message_text)
            name = spec.get("name", "unknown")

            return ActionResult(
                success=True,
                text=f"Plugin creation job started successfully!\n\nPlugin: {name}\n\nUse 'checkPluginCreationStatus' to monitor progress.",
                data={"pluginName": name, "status": "pending"},
            )
        except json.JSONDecodeError as e:
            return ActionResult(
                success=False,
                text=f"Failed to parse specification: {e}",
                error=str(e),
            )


create_plugin_action = CreatePluginAction()
