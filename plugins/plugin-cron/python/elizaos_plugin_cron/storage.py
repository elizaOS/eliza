"""In-memory storage for cron job definitions."""

from __future__ import annotations

from datetime import datetime, timezone

from elizaos_plugin_cron.schedule import compute_next_run
from elizaos_plugin_cron.types import JobDefinition, JobState, JobUpdate


class CronStorage:
    """In-memory store for cron job definitions."""

    def __init__(self) -> None:
        self._jobs: dict[str, JobDefinition] = {}

    def __len__(self) -> int:
        return len(self._jobs)

    @property
    def is_empty(self) -> bool:
        return len(self._jobs) == 0

    # -- CRUD -----------------------------------------------------------------

    def add_job(self, job: JobDefinition) -> None:
        """Add a job to storage. Raises ValueError if ID already exists."""
        if job.id in self._jobs:
            raise ValueError(f"Job already exists: {job.id}")
        self._jobs[job.id] = job

    def get_job(self, job_id: str) -> JobDefinition | None:
        """Get a job by ID, or None."""
        return self._jobs.get(job_id)

    def update_job(self, job_id: str, updates: JobUpdate) -> JobDefinition:
        """Apply partial updates to a job. Raises KeyError if not found."""
        job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(f"Job not found: {job_id}")

        now = datetime.now(timezone.utc)

        if updates.name is not None:
            job.name = updates.name
        if updates._clear_description:
            job.description = None
        elif updates.description is not None:
            job.description = updates.description
        if updates.schedule is not None:
            job.schedule = updates.schedule
            job.next_run = compute_next_run(job.schedule, now)
        if updates.payload is not None:
            job.payload = updates.payload
        if updates.state is not None:
            job.state = updates.state
        if updates.max_runs is not None:
            job.max_runs = updates.max_runs
        if updates.room_id is not None:
            job.room_id = updates.room_id

        job.updated_at = now
        return job

    def delete_job(self, job_id: str) -> bool:
        """Delete a job by ID. Returns True if it existed."""
        return self._jobs.pop(job_id, None) is not None

    # -- Queries --------------------------------------------------------------

    def list_jobs(self, state_filter: JobState | None = None) -> list[JobDefinition]:
        """List all jobs, optionally filtered by state. Sorted by next_run."""
        if state_filter is not None:
            jobs = [j for j in self._jobs.values() if j.state == state_filter]
        else:
            jobs = list(self._jobs.values())

        far_future = datetime.max.replace(tzinfo=timezone.utc)
        jobs.sort(key=lambda j: j.next_run or far_future)
        return jobs

    def get_due_jobs(self, now: datetime | None = None) -> list[JobDefinition]:
        """Return all active jobs whose next_run is at or before `now`."""
        if now is None:
            now = datetime.now(timezone.utc)
        due = [
            j
            for j in self._jobs.values()
            if j.state == JobState.ACTIVE
            and j.next_run is not None
            and j.next_run <= now
        ]
        due.sort(key=lambda j: j.next_run or now)
        return due

    def find_by_name(self, name: str) -> JobDefinition | None:
        """Find a job by name (case-insensitive)."""
        lower = name.lower()
        for job in self._jobs.values():
            if job.name.lower() == lower:
                return job
        return None
