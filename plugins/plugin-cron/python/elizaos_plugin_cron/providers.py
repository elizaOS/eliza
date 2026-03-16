"""Cron context provider: exposes cron job context to the agent."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from elizaos_plugin_cron.schedule import format_schedule
from elizaos_plugin_cron.service import CronService
from elizaos_plugin_cron.types import JobState


@dataclass(frozen=True)
class ProviderResult:
    values: dict[str, Any]
    text: str
    data: dict[str, Any]


class CronContextProvider:
    @property
    def name(self) -> str:
        return "CRON_CONTEXT"

    @property
    def description(self) -> str:
        return "Provides information about scheduled cron jobs"

    @property
    def position(self) -> int:
        return 50

    async def get(
        self,
        _message: dict,
        _state: dict,
        service: CronService | None = None,
    ) -> ProviderResult:
        if service is None:
            return ProviderResult(
                values={"hasCronService": False, "cronJobCount": 0},
                text="",
                data={"available": False},
            )

        all_jobs = service.list_jobs()
        active_jobs = [j for j in all_jobs if j.state == JobState.ACTIVE]
        paused_jobs = [j for j in all_jobs if j.state == JobState.PAUSED]
        failed_jobs = [j for j in all_jobs if j.state == JobState.FAILED]

        lines: list[str] = []
        if not all_jobs:
            lines.append("No cron jobs are scheduled.")
        else:
            lines.append(
                f"Scheduled Jobs ({len(active_jobs)} active, {len(paused_jobs)} paused):"
            )

            if failed_jobs:
                lines.append("\nRecently failed:")
                for job in failed_jobs[:3]:
                    lines.append(f"- {job.name}: failed")

            if len(active_jobs) <= 10:
                lines.append("\nAll active jobs:")
                for job in active_jobs:
                    schedule_str = format_schedule(job.schedule)
                    next_str = (
                        job.next_run.strftime("%Y-%m-%dT%H:%M:%SZ")
                        if job.next_run
                        else "not scheduled"
                    )
                    lines.append(f"- {job.name} ({schedule_str}) - next: {next_str}")
            elif active_jobs:
                lines.append(
                    f"\n{len(active_jobs)} active jobs total. "
                    'Use "list crons" to see all.'
                )

        jobs_data = [
            {
                "id": j.id,
                "name": j.name,
                "state": j.state.value,
                "schedule": format_schedule(j.schedule),
                "next_run": j.next_run.isoformat() if j.next_run else None,
            }
            for j in all_jobs
        ]

        return ProviderResult(
            values={
                "hasCronService": True,
                "cronJobCount": len(all_jobs),
                "activeJobCount": len(active_jobs),
                "pausedJobCount": len(paused_jobs),
                "failedJobCount": len(failed_jobs),
            },
            text="\n".join(lines),
            data={"available": True, "jobs": jobs_data},
        )
