"""CREATE_CRON action: creates a new cron job."""

from __future__ import annotations

import re

from elizaos_plugin_cron.actions.common import ActionResult, Message
from elizaos_plugin_cron.schedule import format_schedule, parse_natural_language_schedule, parse_schedule
from elizaos_plugin_cron.service import CronService
from elizaos_plugin_cron.types import PayloadPrompt


class CreateCronAction:
    @property
    def name(self) -> str:
        return "CREATE_CRON"

    @property
    def similes(self) -> list[str]:
        return [
            "SCHEDULE_CRON", "ADD_CRON", "NEW_CRON",
            "CREATE_SCHEDULED_JOB", "SET_UP_CRON", "SCHEDULE_JOB",
        ]

    @property
    def description(self) -> str:
        return (
            "Creates a new cron job that runs on a schedule. "
            "Supports interval-based, cron expressions, and one-time schedules."
        )

    async def validate(self, message: Message, _state: dict) -> bool:
        text = (message.get("content") or {}).get("text", "").lower()
        has_schedule = any(
            kw in text
            for kw in ["cron", "schedule", "every ", "recurring", "daily", "hourly"]
        )
        has_create = any(
            kw in text for kw in ["create", "add", "set up", "schedule", "make"]
        )
        return has_schedule and has_create

    async def handler(
        self,
        message: Message,
        _state: dict,
        service: CronService | None = None,
    ) -> ActionResult:
        if service is None:
            return ActionResult(False, "Cron service is not available.", error="missing_service")

        text = (message.get("content") or {}).get("text", "")

        # Structured input via options
        options = message.get("options") or {}
        if "name" in options and "schedule" in options:
            try:
                schedule = parse_schedule(str(options["schedule"]))
            except ValueError as e:
                return ActionResult(False, f"Invalid schedule: {e}", error=str(e))

            prompt_text = options.get("prompt", "Run scheduled task")
            payload = PayloadPrompt(text=str(prompt_text))

            try:
                job = service.create_job(
                    name=str(options["name"]),
                    schedule=schedule,
                    payload=payload,
                    description=options.get("description"),
                    max_runs=options.get("max_runs"),
                    room_id=options.get("room_id"),
                )
            except (ValueError, RuntimeError) as e:
                return ActionResult(False, f"Failed to create job: {e}", error=str(e))

            return ActionResult(
                True,
                _format_created(job),
                data={"jobId": job.id, "jobName": job.name},
            )

        # Natural language
        name, schedule, prompt = _parse_create_request(text)

        if schedule is None:
            return ActionResult(
                False,
                "Could not understand the schedule. Try:\n"
                '- "every 5 minutes"\n'
                '- "daily at 9am"\n'
                '- A cron expression like "0 9 * * 1-5"',
                error="Could not parse schedule",
            )

        payload = PayloadPrompt(text=prompt or "Run scheduled task")
        try:
            job = service.create_job(name=name, schedule=schedule, payload=payload)
        except (ValueError, RuntimeError) as e:
            return ActionResult(False, f"Failed to create job: {e}", error=str(e))

        return ActionResult(
            True,
            _format_created(job),
            data={"jobId": job.id, "jobName": job.name},
        )


def _format_created(job) -> str:  # noqa: ANN001
    schedule_str = format_schedule(job.schedule)
    return (
        f'Created cron job "{job.name}"\n'
        f"- ID: {job.id}\n"
        f"- Schedule: {schedule_str}\n"
        f"- Status: {job.state.value}"
    )


_TO_RE = re.compile(r"(?i)(?:to|that)\s+(.+?)(?:\s+every|\s+at\s+\d|$)")
_NAME_RE = re.compile(r"""(?i)(?:called|named)\s+["']?([^"']+)["']?""")


def _parse_create_request(text: str):
    name = "Unnamed cron job"
    prompt = None

    m = _TO_RE.search(text)
    if m:
        action_text = m.group(1).strip()
        name = action_text[:50]
        prompt = action_text

    m = _NAME_RE.search(text)
    if m:
        name = m.group(1).strip()

    schedule = parse_natural_language_schedule(text)

    # Fallback: try extracting "every N unit" directly
    if schedule is None:
        every_m = re.search(
            r"(?i)every\s+(\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?))", text
        )
        if every_m:
            schedule = parse_natural_language_schedule(f"every {every_m.group(1)}")

    return name, schedule, prompt
