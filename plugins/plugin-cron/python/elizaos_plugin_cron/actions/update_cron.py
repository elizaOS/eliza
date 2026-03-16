"""UPDATE_CRON action: updates an existing cron job."""

from __future__ import annotations

from elizaos_plugin_cron.actions.common import ActionResult, Message, extract_job_id
from elizaos_plugin_cron.schedule import format_schedule, parse_natural_language_schedule
from elizaos_plugin_cron.service import CronService
from elizaos_plugin_cron.types import JobState, JobUpdate


class UpdateCronAction:
    @property
    def name(self) -> str:
        return "UPDATE_CRON"

    @property
    def similes(self) -> list[str]:
        return [
            "MODIFY_CRON", "EDIT_CRON", "CHANGE_CRON",
            "ENABLE_CRON", "DISABLE_CRON", "PAUSE_CRON", "RESUME_CRON",
        ]

    @property
    def description(self) -> str:
        return (
            "Updates an existing cron job. Can pause/resume, "
            "change schedules, or modify other properties."
        )

    async def validate(self, message: Message, _state: dict) -> bool:
        text = (message.get("content") or {}).get("text", "").lower()
        has_update = any(
            kw in text
            for kw in ["update", "modify", "edit", "change", "enable", "disable", "pause", "resume"]
        )
        has_cron = any(kw in text for kw in ["cron", "job", "schedule"])
        return has_update and has_cron

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
                "Please specify which cron job to update (by ID or name).",
                error="No job identifier",
            )

        updates = _parse_update_intent(text)

        if (
            updates.name is None
            and updates.schedule is None
            and updates.state is None
            and updates.payload is None
        ):
            return ActionResult(
                False,
                "Please specify what to update (e.g. pause, resume, change schedule).",
                error="No updates specified",
            )

        try:
            job = service.update_job(job_id, updates)
        except (KeyError, ValueError, RuntimeError) as e:
            return ActionResult(False, f"Failed to update job: {e}", error=str(e))

        schedule_str = format_schedule(job.schedule)
        return ActionResult(
            True,
            f'Updated cron job "{job.name}" ({job.id})\n'
            f"- Schedule: {schedule_str}\n"
            f"- State: {job.state.value}",
            data={"jobId": job.id, "jobName": job.name},
        )


def _parse_update_intent(text: str) -> JobUpdate:
    updates = JobUpdate()
    lower = text.lower()

    if "pause" in lower or "disable" in lower:
        updates.state = JobState.PAUSED
    elif "resume" in lower or "enable" in lower:
        updates.state = JobState.ACTIVE

    schedule = parse_natural_language_schedule(text)
    if schedule is not None:
        updates.schedule = schedule

    import re

    m = re.search(r"""(?i)rename\s+(?:to|as)\s+["']?([^"']+)["']?""", text)
    if m:
        updates.name = m.group(1).strip()

    return updates
