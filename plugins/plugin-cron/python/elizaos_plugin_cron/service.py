"""High-level CronService: CRUD, scheduling, and execution coordination."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from elizaos_plugin_cron.schedule import (
    compute_next_run,
    format_schedule,
    validate_cron_expression,
)
from elizaos_plugin_cron.storage import CronStorage
from elizaos_plugin_cron.types import (
    CronConfig,
    JobDefinition,
    JobState,
    JobUpdate,
    PayloadType,
    ScheduleAt,
    ScheduleCron,
    ScheduleEvery,
    ScheduleType,
)

logger = logging.getLogger(__name__)


class CronService:
    """Manages cron job CRUD, scheduling, and execution coordination."""

    def __init__(self, config: CronConfig | None = None) -> None:
        self._config = config or CronConfig()
        self._storage = CronStorage()
        logger.info("CronService initialised (max_jobs=%d)", self._config.max_jobs)

    @property
    def config(self) -> CronConfig:
        return self._config

    @property
    def job_count(self) -> int:
        return len(self._storage)

    # -- CRUD -----------------------------------------------------------------

    def create_job(
        self,
        name: str,
        schedule: ScheduleType,
        payload: PayloadType,
        *,
        description: str | None = None,
        max_runs: int | None = None,
        room_id: str | None = None,
    ) -> JobDefinition:
        """Create a new cron job.

        Raises ValueError on invalid schedule or capacity exceeded.
        """
        if not self._config.enabled:
            raise RuntimeError("Cron service is disabled")

        self._validate_schedule(schedule)

        if len(self._storage) >= self._config.max_jobs:
            raise ValueError(
                f"Maximum job limit reached ({self._config.max_jobs}). "
                "Delete some jobs first."
            )

        now = datetime.now(timezone.utc)
        next_run = compute_next_run(schedule, now)

        job = JobDefinition(
            id=str(uuid.uuid4()),
            name=name,
            schedule=schedule,
            payload=payload,
            description=description,
            created_at=now,
            updated_at=now,
            next_run=next_run,
            max_runs=max_runs,
            room_id=room_id,
        )

        self._storage.add_job(job)
        logger.info(
            'Created job "%s" (%s) - %s', job.name, job.id, format_schedule(job.schedule)
        )
        return job

    def update_job(self, job_id: str, updates: JobUpdate) -> JobDefinition:
        """Update an existing job. Raises KeyError if not found."""
        if not self._config.enabled:
            raise RuntimeError("Cron service is disabled")

        if updates.schedule is not None:
            self._validate_schedule(updates.schedule)

        job = self._storage.update_job(job_id, updates)
        logger.info('Updated job "%s" (%s)', job.name, job.id)
        return job

    def delete_job(self, job_id: str) -> bool:
        """Delete a job by ID. Returns True if it existed."""
        job = self._storage.get_job(job_id)
        name = job.name if job else "unknown"
        deleted = self._storage.delete_job(job_id)
        if deleted:
            logger.info('Deleted job "%s" (%s)', name, job_id)
        return deleted

    def get_job(self, job_id: str) -> JobDefinition | None:
        """Get a job by ID."""
        return self._storage.get_job(job_id)

    def list_jobs(self, state_filter: JobState | None = None) -> list[JobDefinition]:
        """List all jobs, optionally filtered by state."""
        return self._storage.list_jobs(state_filter)

    def find_job_by_name(self, name: str) -> JobDefinition | None:
        """Find a job by name (case-insensitive)."""
        return self._storage.find_by_name(name)

    # -- Execution ------------------------------------------------------------

    def run_job(self, job_id: str) -> JobDefinition:
        """Simulate running a job: updates run count, timestamps, and state.

        Raises KeyError if not found, RuntimeError if service disabled.
        """
        if not self._config.enabled:
            raise RuntimeError("Cron service is disabled")

        job = self._storage.get_job(job_id)
        if job is None:
            raise KeyError(f"Job not found: {job_id}")

        now = datetime.now(timezone.utc)
        job.run_count += 1
        job.last_run = now
        job.updated_at = now

        # Determine new state
        if isinstance(job.schedule, ScheduleAt):
            job.state = JobState.COMPLETED
            job.next_run = None
        elif job.max_runs is not None and job.run_count >= job.max_runs:
            job.state = JobState.COMPLETED
            job.next_run = None
        else:
            job.next_run = compute_next_run(job.schedule, now)

        logger.info(
            'Ran job "%s" (%s) - run #%d, state=%s',
            job.name, job.id, job.run_count, job.state.value,
        )
        return job

    def get_due_jobs(self) -> list[JobDefinition]:
        """Return all jobs that are currently due for execution."""
        return self._storage.get_due_jobs()

    # -- Helpers --------------------------------------------------------------

    def _validate_schedule(self, schedule: ScheduleType) -> None:
        """Validate a schedule, raising ValueError on problems."""
        if isinstance(schedule, ScheduleAt):
            # Allow past timestamps for testing but they won't have a next_run
            return
        if isinstance(schedule, ScheduleEvery):
            if schedule.interval.total_seconds() <= 0:
                raise ValueError("Interval must be positive")
            return
        if isinstance(schedule, ScheduleCron):
            if not validate_cron_expression(schedule.expr):
                raise ValueError(f"Invalid cron expression: {schedule.expr}")
            return
        raise ValueError(f"Unknown schedule type: {type(schedule)}")
