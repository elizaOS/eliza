import pytest

from elizaos_plugin_shell import ShellConfig, ShellService


@pytest.fixture
def shell_config() -> ShellConfig:
    return ShellConfig(
        enabled=True,
        allowed_directory="/test/allowed",
        timeout=30000,
        forbidden_commands=["rm", "rmdir"],
    )


@pytest.fixture
def shell_service(shell_config: ShellConfig) -> ShellService:
    return ShellService(shell_config)
