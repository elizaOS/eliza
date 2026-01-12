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


class CancelPluginAction:
    name = "cancelPluginCreation"
    description = "Cancel the current plugin creation job"
    similes = ["stop plugin creation", "abort plugin creation", "cancel plugin"]

    async def validate(self, context: ActionContext) -> bool:
        jobs = context.state.get("jobs", [])
        for job in jobs:
            if job.get("status") in ("running", "pending"):
                return True
        return False

    async def execute(self, context: ActionContext) -> ActionResult:
        jobs = context.state.get("jobs", [])

        for job in jobs:
            if job.get("status") in ("running", "pending"):
                job_id = job.get("id", "unknown")
                spec = job.get("specification", {})
                name = spec.get("name", "unknown")

                return ActionResult(
                    success=True,
                    text=f"Plugin creation job has been cancelled.\n\nJob ID: {job_id}\nPlugin: {name}",
                    data={"jobId": job_id, "pluginName": name},
                )

        return ActionResult(
            success=False,
            text="No active plugin creation job to cancel.",
        )


cancel_plugin_action = CancelPluginAction()
