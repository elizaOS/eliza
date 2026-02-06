"""Tests for cron actions: CREATE, UPDATE, DELETE, LIST, RUN."""

from __future__ import annotations

from datetime import timedelta

import pytest

from elizaos_plugin_cron.actions.create_cron import CreateCronAction
from elizaos_plugin_cron.actions.delete_cron import DeleteCronAction
from elizaos_plugin_cron.actions.list_crons import ListCronsAction
from elizaos_plugin_cron.actions.run_cron import RunCronAction
from elizaos_plugin_cron.actions.update_cron import UpdateCronAction
from elizaos_plugin_cron.service import CronService
from elizaos_plugin_cron.types import PayloadPrompt, ScheduleEvery


def _msg(text: str, **options) -> dict:
    msg: dict = {"content": {"text": text}, "room_id": "room-1", "agent_id": "agent-1"}
    if options:
        msg["options"] = options
    return msg


# -- CREATE -------------------------------------------------------------------

async def test_create_action_natural_language(service: CronService):
    action = CreateCronAction()
    result = await action.handler(
        _msg("Create a cron job to check the news every 5 minutes"), {}, service
    )
    assert result.success
    assert "Created cron job" in result.text
    assert service.job_count == 1


async def test_create_action_structured(service: CronService):
    action = CreateCronAction()
    result = await action.handler(
        _msg("create", name="test-job", schedule="5m", prompt="do stuff"), {}, service
    )
    assert result.success
    assert "test-job" in result.text


async def test_create_action_no_schedule(service: CronService):
    action = CreateCronAction()
    result = await action.handler(
        _msg("Create a cron job to do something"), {}, service
    )
    # "do something" doesn't contain a schedule pattern
    assert not result.success
    assert "Could not understand" in result.text


async def test_create_action_no_service():
    action = CreateCronAction()
    result = await action.handler(_msg("create cron every 5 minutes"), {}, None)
    assert not result.success
    assert "not available" in result.text


async def test_create_validate():
    action = CreateCronAction()
    assert await action.validate(_msg("create a cron job every hour"), {})
    assert not await action.validate(_msg("hello world"), {})


# -- UPDATE -------------------------------------------------------------------

async def test_update_action_pause(service: CronService):
    job = service.create_job(
        "my-job",
        schedule=ScheduleEvery(interval=timedelta(minutes=5)),
        payload=PayloadPrompt(text="x"),
    )

    action = UpdateCronAction()
    result = await action.handler(
        _msg(f'Pause cron job "{job.name}"'), {}, service
    )
    assert result.success
    assert "paused" in result.text.lower()


async def test_update_action_no_identifier(service: CronService):
    action = UpdateCronAction()
    result = await action.handler(_msg("update cron job"), {}, service)
    assert not result.success
    assert "specify" in result.text.lower()


async def test_update_validate():
    action = UpdateCronAction()
    assert await action.validate(_msg("disable the cron job"), {})
    assert not await action.validate(_msg("hello world"), {})


# -- DELETE -------------------------------------------------------------------

async def test_delete_action(service: CronService):
    job = service.create_job(
        "deletable",
        schedule=ScheduleEvery(interval=timedelta(minutes=5)),
        payload=PayloadPrompt(text="x"),
    )

    action = DeleteCronAction()
    result = await action.handler(
        _msg(f'Delete cron job "{job.name}"'), {}, service
    )
    assert result.success
    assert "permanently removed" in result.text
    assert service.job_count == 0


async def test_delete_action_not_found(service: CronService):
    action = DeleteCronAction()
    result = await action.handler(
        _msg("Delete cron job called nonexistent"), {}, service
    )
    assert not result.success


async def test_delete_validate():
    action = DeleteCronAction()
    assert await action.validate(_msg("remove the cron job"), {})
    assert not await action.validate(_msg("create a cron job"), {})


# -- LIST ---------------------------------------------------------------------

async def test_list_action_empty(service: CronService):
    action = ListCronsAction()
    result = await action.handler(_msg("list cron jobs"), {}, service)
    assert result.success
    assert "No cron jobs" in result.text


async def test_list_action_with_jobs(service: CronService):
    service.create_job(
        "job-a",
        schedule=ScheduleEvery(interval=timedelta(minutes=5)),
        payload=PayloadPrompt(text="a"),
    )
    service.create_job(
        "job-b",
        schedule=ScheduleEvery(interval=timedelta(hours=1)),
        payload=PayloadPrompt(text="b"),
    )

    action = ListCronsAction()
    result = await action.handler(_msg("show my cron jobs"), {}, service)
    assert result.success
    assert "Found 2 cron jobs" in result.text
    assert "job-a" in result.text
    assert "job-b" in result.text


async def test_list_validate():
    action = ListCronsAction()
    assert await action.validate(_msg("list my cron jobs"), {})
    assert not await action.validate(_msg("create something"), {})


# -- RUN ----------------------------------------------------------------------

async def test_run_action(service: CronService):
    job = service.create_job(
        "runnable",
        schedule=ScheduleEvery(interval=timedelta(minutes=5)),
        payload=PayloadPrompt(text="x"),
    )

    action = RunCronAction()
    result = await action.handler(
        _msg(f'Run cron job "{job.name}"'), {}, service
    )
    assert result.success
    assert "Ran cron job" in result.text
    assert service.get_job(job.id).run_count == 1


async def test_run_action_not_found(service: CronService):
    action = RunCronAction()
    result = await action.handler(
        _msg("Run cron job called nonexistent"), {}, service
    )
    assert not result.success


async def test_run_validate():
    action = RunCronAction()
    assert await action.validate(_msg("run the cron job"), {})
    assert not await action.validate(_msg("run every 5 minutes"), {})  # create intent
    assert not await action.validate(_msg("hello"), {})
