"""Tests for CronService: lifecycle, limits, execution, edge cases."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from elizaos_plugin_cron.service import CronService
from elizaos_plugin_cron.types import (
    CronConfig,
    JobState,
    JobUpdate,
    PayloadAction,
    PayloadEvent,
    PayloadPrompt,
    ScheduleAt,
    ScheduleCron,
    ScheduleEvery,
)


def test_create_list_update_delete_lifecycle(service: CronService):
    # Create
    job = service.create_job(
        "lifecycle-test",
        schedule=ScheduleEvery(interval=timedelta(minutes=10)),
        payload=PayloadPrompt(text="Do something"),
        description="A test job",
    )
    assert job.name == "lifecycle-test"
    assert job.state == JobState.ACTIVE
    assert job.next_run is not None

    # List
    jobs = service.list_jobs()
    assert len(jobs) == 1

    # Update
    updated = service.update_job(
        job.id, JobUpdate(name="renamed-test", state=JobState.PAUSED)
    )
    assert updated.name == "renamed-test"
    assert updated.state == JobState.PAUSED

    # Delete
    assert service.delete_job(job.id)
    assert service.list_jobs() == []


def test_max_jobs_limit(limited_service: CronService):
    limited_service.create_job(
        "job-1",
        schedule=ScheduleEvery(interval=timedelta(minutes=1)),
        payload=PayloadPrompt(text="a"),
    )
    limited_service.create_job(
        "job-2",
        schedule=ScheduleEvery(interval=timedelta(minutes=1)),
        payload=PayloadPrompt(text="b"),
    )

    with pytest.raises(ValueError, match="Maximum job limit"):
        limited_service.create_job(
            "job-3",
            schedule=ScheduleEvery(interval=timedelta(minutes=1)),
            payload=PayloadPrompt(text="c"),
        )


def test_disabled_service(disabled_service: CronService):
    with pytest.raises(RuntimeError, match="disabled"):
        disabled_service.create_job(
            "test",
            schedule=ScheduleEvery(interval=timedelta(minutes=1)),
            payload=PayloadPrompt(text="x"),
        )


def test_run_job(service: CronService):
    job = service.create_job(
        "runner",
        schedule=ScheduleEvery(interval=timedelta(minutes=5)),
        payload=PayloadPrompt(text="run me"),
    )

    ran = service.run_job(job.id)
    assert ran.run_count == 1
    assert ran.last_run is not None
    assert ran.state == JobState.ACTIVE


def test_run_job_with_max_runs(service: CronService):
    job = service.create_job(
        "limited",
        schedule=ScheduleEvery(interval=timedelta(minutes=1)),
        payload=PayloadPrompt(text="x"),
        max_runs=2,
    )

    service.run_job(job.id)
    finished = service.run_job(job.id)
    assert finished.run_count == 2
    assert finished.state == JobState.COMPLETED


def test_run_at_schedule_completes(service: CronService):
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    job = service.create_job(
        "one-shot",
        schedule=ScheduleAt(at=future),
        payload=PayloadPrompt(text="once"),
    )

    ran = service.run_job(job.id)
    assert ran.state == JobState.COMPLETED
    assert ran.next_run is None


def test_invalid_cron_expression(service: CronService):
    with pytest.raises(ValueError, match="Invalid cron"):
        service.create_job(
            "bad-cron",
            schedule=ScheduleCron(expr="not valid"),
            payload=PayloadPrompt(text="x"),
        )


def test_invalid_interval(service: CronService):
    with pytest.raises(ValueError, match="positive"):
        service.create_job(
            "bad-interval",
            schedule=ScheduleEvery(interval=timedelta(0)),
            payload=PayloadPrompt(text="x"),
        )


def test_find_by_name(service: CronService):
    service.create_job(
        "My Job",
        schedule=ScheduleEvery(interval=timedelta(minutes=1)),
        payload=PayloadPrompt(text="x"),
    )

    assert service.find_job_by_name("my job") is not None
    assert service.find_job_by_name("MY JOB") is not None
    assert service.find_job_by_name("nonexistent") is None


def test_action_payload(service: CronService):
    job = service.create_job(
        "action-job",
        schedule=ScheduleEvery(interval=timedelta(hours=1)),
        payload=PayloadAction(name="SEND_EMAIL", params={"to": "user@example.com"}),
    )
    assert isinstance(job.payload, PayloadAction)
    assert job.payload.name == "SEND_EMAIL"


def test_event_payload(service: CronService):
    job = service.create_job(
        "event-job",
        schedule=ScheduleCron(expr="0 0 * * *"),
        payload=PayloadEvent(name="daily_reset"),
    )
    assert isinstance(job.payload, PayloadEvent)
    assert job.payload.name == "daily_reset"


def test_run_nonexistent_job(service: CronService):
    with pytest.raises(KeyError):
        service.run_job("nonexistent-id")


def test_delete_nonexistent_returns_false(service: CronService):
    assert not service.delete_job("nonexistent-id")


def test_job_count(service: CronService):
    assert service.job_count == 0
    service.create_job(
        "test",
        schedule=ScheduleEvery(interval=timedelta(minutes=1)),
        payload=PayloadPrompt(text="x"),
    )
    assert service.job_count == 1
