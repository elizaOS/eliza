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


class CreateFromDescriptionAction:
    name = "createPluginFromDescription"
    description = "Create a plugin from a natural language description"
    similes = [
        "describe plugin",
        "plugin from description",
        "explain plugin",
        "I need a plugin that",
    ]

    async def validate(self, context: ActionContext) -> bool:
        active_jobs = context.state.get("activeJobs", [])
        for job in active_jobs:
            if job.get("status") in ("running", "pending"):
                return False

        return len(context.message_text) > 20

    async def execute(self, context: ActionContext) -> ActionResult:
        description = context.message_text
        lower_desc = description.lower()

        if "weather" in lower_desc:
            plugin_type = "weather"
        elif "database" in lower_desc or "sql" in lower_desc:
            plugin_type = "database"
        elif "api" in lower_desc or "rest" in lower_desc:
            plugin_type = "api"
        elif "todo" in lower_desc or "task" in lower_desc:
            plugin_type = "todo"
        elif "email" in lower_desc or "mail" in lower_desc:
            plugin_type = "email"
        else:
            plugin_type = "custom"

        name = f"@elizaos/plugin-{plugin_type}"
        truncated_desc = description[:200] if len(description) > 200 else description

        return ActionResult(
            success=True,
            text=f"Creating plugin based on your description!\n\nPlugin: {name}\nDescription: {truncated_desc}\n\nUse 'checkPluginCreationStatus' to monitor progress.",
            data={
                "pluginName": name,
                "description": truncated_desc,
                "status": "pending",
            },
        )


create_from_description_action = CreateFromDescriptionAction()
