"""LIST_CRONS action: lists all cron jobs."""

from __future__ import annotations

from elizaos_plugin_cron.actions.common import ActionResult, Message
from elizaos_plugin_cron.schedule import format_schedule
from elizaos_plugin_cron.service import CronService
from elizaos_plugin_cron.types import JobState


class ListCronsAction:
    @property
    def name(self) -> str:
        return "LIST_CRONS"

    @property
    def similes(self) -> list[str]:
        return [
            "SHOW_CRONS", "GET_CRONS", "VIEW_CRONS",
            "LIST_SCHEDULED_JOBS", "SHOW_SCHEDULED_JOBS",
            "MY_CRONS", "CRON_STATUS",
        ]

    @property
    def description(self) -> str:
        return "Lists all cron jobs. Can filter by state or show details of a specific job."

    async def validate(self, message: Message, _state: dict) -> bool:
        text = (message.get("content") or {}).get("text", "").lower()
        has_list = any(kw in text for kw in ["list", "show", "view", "get", "what"])
        has_cron = any(kw in text for kw in ["cron", "scheduled", "job", "schedule"])
        return has_list and has_cron

    async def handler(
        self,
        message: Message,
        _state: dict,
        service: CronService | None = None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "Cron service is not available.", error="missing_service")

        text = (message.get("content") or {}).get("text", "").lower()

        # Determine filter
        state_filter: JobState | None = None
        if "active" in text or "enabled" in text:
            state_filter = JobState.ACTIVE
        elif "paused" in text or "disabled" in text:
            state_filter = JobState.PAUSED
        elif "completed" in text or "finished" in text:
            state_filter = JobState.COMPLETED
        elif "failed" in text:
            state_filter = JobState.FAILED

        jobs = service.list_jobs(state_filter)

        if not jobs:
            filter_desc = f" with state {state_filter.value}" if state_filter else ""
            return ActionResult(
                True,
                f"No cron jobs found{filter_desc}.",
                data={"jobs": [], "count": 0},
            )

        lines = [f"Found {len(jobs)} cron job{'s' if len(jobs) != 1 else ''}:\n"]
        for job in jobs:
            schedule_str = format_schedule(job.schedule)
            next_run = (
                job.next_run.strftime("%Y-%m-%d %H:%M:%S UTC") if job.next_run else "not scheduled"
            )
            lines.append(
                f"- {job.name} ({job.state.value})\n"
                f"  ID: {job.id}\n"
                f"  Schedule: {schedule_str}\n"
                f"  Next run: {next_run}\n"
                f"  Runs: {job.run_count}"
            )

        return ActionResult(
            True,
            "\n".join(lines),
            data={
                "count": len(jobs),
                "jobs": [
                    {
                        "id": j.id,
                        "name": j.name,
                        "state": j.state.value,
                        "schedule": format_schedule(j.schedule),
                        "run_count": j.run_count,
                    }
                    for j in jobs
                ],
            },
        )
