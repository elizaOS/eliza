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


class CheckStatusAction:
    name = "checkPluginCreationStatus"
    description = "Check the status of a plugin creation job"
    similes = [
        "plugin status",
        "check plugin progress",
        "plugin creation status",
        "get plugin status",
    ]

    async def validate(self, context: ActionContext) -> bool:
        jobs = context.state.get("jobs", [])
        return len(jobs) > 0

    async def execute(self, context: ActionContext) -> ActionResult:
        jobs = context.state.get("jobs", [])

        if not jobs:
            return ActionResult(
                success=False,
                text="No plugin creation jobs found.",
            )

        job = jobs[0]
        status = job.get("status", "unknown")
        progress = job.get("progress", 0)
        spec = job.get("specification", {})
        name = spec.get("name", "unknown")

        return ActionResult(
            success=True,
            text=f"Plugin Creation Status\n\nPlugin: {name}\nStatus: {status.upper()}\nProgress: {progress:.0f}%",
            data={
                "status": status,
                "progress": progress,
                "pluginName": name,
            },
        )


check_status_action = CheckStatusAction()
