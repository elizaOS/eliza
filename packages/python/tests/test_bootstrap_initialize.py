import pytest

from elizaos.runtime import AgentRuntime
from elizaos.types import Character
from elizaos.types.service import ServiceType


@pytest.mark.asyncio
async def test_runtime_initialize_registers_bootstrap_services() -> None:
    """
    Ensure AgentRuntime.initialize() loads the bootstrap plugin and registers services.

    This guards against regressions where bootstrap service registration silently
    stores None or fails to start services properly.
    """
    runtime = AgentRuntime(
        character=Character(name="BootstrapTest", bio="bootstrap init test"),
        log_level="ERROR",
    )

    await runtime.initialize()

    assert any(p.name == "bootstrap" for p in runtime.plugins)

    # Bootstrap should register at least one service of type TASK.
    assert runtime.has_service(ServiceType.TASK)

    task_service = runtime.get_service(ServiceType.TASK)
    assert task_service is not None

    task_services = runtime.get_services_by_type(ServiceType.TASK)
    assert task_services
    assert all(s is not None for s in task_services)

    # Bootstrap should also register some core actions/providers/evaluators.
    assert runtime.actions
    assert runtime.providers
