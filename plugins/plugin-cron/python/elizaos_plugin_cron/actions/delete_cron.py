"""DELETE_CRON action: deletes a cron job."""

from __future__ import annotations

from elizaos_plugin_cron.actions.common import ActionResult, Message, extract_job_id
from elizaos_plugin_cron.service import CronService


class DeleteCronAction:
    @property
    def name(self) -> str:
        return "DELETE_CRON"

    @property
    def similes(self) -> list[str]:
        return [
            "REMOVE_CRON", "CANCEL_CRON", "STOP_CRON",
            "DELETE_SCHEDULED_JOB", "REMOVE_SCHEDULED_JOB",
        ]

    @property
    def description(self) -> str:
        return "Deletes a cron job by ID or name, removing it from the schedule permanently."

    async def validate(self, message: Message, _state: dict) -> bool:
        text = (message.get("content") or {}).get("text", "").lower()
        has_delete = any(
            kw in text for kw in ["delete", "remove", "cancel"]
        ) or ("stop" in text and "stop running" not in text)
        has_cron = any(kw in text for kw in ["cron", "job", "schedule"])
        return has_delete and has_cron

    async def handler(
        self,
        message: Message,
        _state: dict,
        service: CronService | None = None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "Cron service is not available.", error="missing_service")

        text = (message.get("content") or {}).get("text", "")
        job_id = extract_job_id(text, service)

        if job_id is None:
            return ActionResult(
                False,
                "Please specify which cron job to delete (by ID or name).",
                error="No job identifier",
            )

        # Get name before deletion
        job = service.get_job(job_id)
        job_name = job.name if job else "unknown"

        deleted = service.delete_job(job_id)
        if not deleted:
            return ActionResult(
                False,
                f"No cron job found with ID: {job_id}",
                error="Job not found",
            )

        return ActionResult(
            True,
            f'Deleted cron job "{job_name}" ({job_id}).\n'
            "The job has been permanently removed.",
            data={"jobId": job_id, "jobName": job_name, "deleted": True},
        )
