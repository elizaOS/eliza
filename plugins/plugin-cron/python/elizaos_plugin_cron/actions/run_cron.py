"""RUN_CRON action: manually runs a cron job."""

from __future__ import annotations

from elizaos_plugin_cron.actions.common import ActionResult, Message, extract_job_id
from elizaos_plugin_cron.service import CronService


class RunCronAction:
    @property
    def name(self) -> str:
        return "RUN_CRON"

    @property
    def similes(self) -> list[str]:
        return [
            "EXECUTE_CRON", "TRIGGER_CRON", "FIRE_CRON",
            "RUN_SCHEDULED_JOB", "EXECUTE_JOB", "TRIGGER_JOB",
        ]

    @property
    def description(self) -> str:
        return "Manually runs a cron job immediately, regardless of its schedule."

    async def validate(self, message: Message, _state: dict) -> bool:
        text = (message.get("content") or {}).get("text", "").lower()
        has_run = any(kw in text for kw in ["run", "execute", "trigger", "fire"])
        has_cron = any(kw in text for kw in ["cron", "job", "schedule"])
        is_create = "run every" in text or "runs every" in text
        return has_run and has_cron and not is_create

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
                "Please specify which cron job to run (by ID or name).",
                error="No job identifier",
            )

        # Get name before running
        job_pre = service.get_job(job_id)
        job_name = job_pre.name if job_pre else "unknown"

        try:
            job = service.run_job(job_id)
        except (KeyError, RuntimeError) as e:
            return ActionResult(False, f"Failed to run job: {e}", error=str(e))

        return ActionResult(
            True,
            f'Ran cron job "{job_name}" ({job.id})\n'
            f"- Status: {job.state.value}\n"
            f"- Run count: {job.run_count}",
            data={"jobId": job.id, "jobName": job_name, "runCount": job.run_count},
        )
