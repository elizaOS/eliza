"""Tests for CronStorage: CRUD, filtering, due jobs."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from elizaos_plugin_cron.storage import CronStorage
from elizaos_plugin_cron.types import (
    JobDefinition,
    JobState,
    JobUpdate,
    PayloadPrompt,
    ScheduleEvery,
)


def _make_job(name: str, state: JobState = JobState.ACTIVE) -> JobDefinition:
    now = datetime.now(timezone.utc)
    return JobDefinition(
        id=str(uuid.uuid4()),
        name=name,
        schedule=ScheduleEvery(interval=timedelta(minutes=5)),
        payload=PayloadPrompt(text="test"),
        state=state,
        created_at=now,
        updated_at=now,
        next_run=now + timedelta(minutes=5),
    )


def test_add_and_get():
    storage = CronStorage()
    job = _make_job("test-job")
    storage.add_job(job)

    assert len(storage) == 1
    retrieved = storage.get_job(job.id)
    assert retrieved is not None
    assert retrieved.name == "test-job"


def test_duplicate_id_rejected():
    storage = CronStorage()
    job = _make_job("job-1")
    storage.add_job(job)

    dup = _make_job("job-dup")
    dup.id = job.id
    with pytest.raises(ValueError, match="already exists"):
        storage.add_job(dup)


def test_update():
    storage = CronStorage()
    job = _make_job("original")
    storage.add_job(job)

    storage.update_job(job.id, JobUpdate(name="renamed", state=JobState.PAUSED))
    updated = storage.get_job(job.id)
    assert updated is not None
    assert updated.name == "renamed"
    assert updated.state == JobState.PAUSED


def test_update_nonexistent():
    storage = CronStorage()
    with pytest.raises(KeyError):
        storage.update_job("nope", JobUpdate(name="x"))


def test_delete():
    storage = CronStorage()
    job = _make_job("deletable")
    storage.add_job(job)

    assert storage.delete_job(job.id)
    assert len(storage) == 0
    assert storage.get_job(job.id) is None


def test_delete_nonexistent():
    storage = CronStorage()
    assert not storage.delete_job("nope")


def test_list_all():
    storage = CronStorage()
    storage.add_job(_make_job("a"))
    storage.add_job(_make_job("b", JobState.PAUSED))
    storage.add_job(_make_job("c"))

    all_jobs = storage.list_jobs()
    assert len(all_jobs) == 3


def test_list_filtered():
    storage = CronStorage()
    storage.add_job(_make_job("a", JobState.ACTIVE))
    storage.add_job(_make_job("b", JobState.PAUSED))
    storage.add_job(_make_job("c", JobState.ACTIVE))

    active = storage.list_jobs(JobState.ACTIVE)
    assert len(active) == 2

    paused = storage.list_jobs(JobState.PAUSED)
    assert len(paused) == 1

    completed = storage.list_jobs(JobState.COMPLETED)
    assert len(completed) == 0


def test_get_due_jobs():
    storage = CronStorage()
    now = datetime.now(timezone.utc)

    due_job = _make_job("due")
    due_job.next_run = now - timedelta(minutes=1)
    storage.add_job(due_job)

    future_job = _make_job("future")
    future_job.next_run = now + timedelta(hours=1)
    storage.add_job(future_job)

    paused_due = _make_job("paused-due", JobState.PAUSED)
    paused_due.next_run = now - timedelta(minutes=1)
    storage.add_job(paused_due)

    due = storage.get_due_jobs(now)
    assert len(due) == 1
    assert due[0].name == "due"


def test_find_by_name():
    storage = CronStorage()
    storage.add_job(_make_job("Daily Check"))
    storage.add_job(_make_job("hourly sync"))

    assert storage.find_by_name("daily check") is not None
    assert storage.find_by_name("DAILY CHECK") is not None
    assert storage.find_by_name("nonexistent") is None


def test_empty_storage():
    storage = CronStorage()
    assert len(storage) == 0
    assert storage.is_empty
    assert storage.list_jobs() == []
    assert storage.get_due_jobs() == []
