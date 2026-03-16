"""Tests for CLI registry."""

from __future__ import annotations

from elizaos_plugin_cli.registry import CliRegistry
from elizaos_plugin_cli.types import CliArg, CliCommand


def test_register_and_lookup(registry: CliRegistry) -> None:
    cmd = CliCommand(name="run", description="Run the agent", handler_name="handle_run")
    registry.register_command(cmd)

    found = registry.get_command("run")
    assert found is not None
    assert found.name == "run"
    assert found.description == "Run the agent"


def test_has_command(registry: CliRegistry) -> None:
    assert not registry.has_command("run")
    registry.register_command(
        CliCommand(name="run", description="Run", handler_name="handle_run")
    )
    assert registry.has_command("run")
    assert not registry.has_command("build")


def test_list_sorted_by_priority(registry: CliRegistry) -> None:
    registry.register_command(
        CliCommand(name="config", description="Config", handler_name="h1", priority=50)
    )
    registry.register_command(
        CliCommand(name="run", description="Run", handler_name="h2", priority=10)
    )
    registry.register_command(
        CliCommand(name="build", description="Build", handler_name="h3", priority=30)
    )

    cmds = registry.list_commands()
    assert len(cmds) == 3
    assert cmds[0].name == "run"     # priority 10
    assert cmds[1].name == "build"   # priority 30
    assert cmds[2].name == "config"  # priority 50


def test_unregister(registry: CliRegistry) -> None:
    registry.register_command(
        CliCommand(name="run", description="Run", handler_name="h")
    )
    assert registry.has_command("run")

    removed = registry.unregister_command("run")
    assert removed is not None
    assert not registry.has_command("run")
    assert len(registry) == 0


def test_replace_existing(registry: CliRegistry) -> None:
    registry.register_command(
        CliCommand(name="run", description="Old", handler_name="h_v1")
    )
    old = registry.register_command(
        CliCommand(name="run", description="New", handler_name="h_v2")
    )

    assert old is not None
    assert old.description == "Old"
    assert registry.get_command("run") is not None
    assert registry.get_command("run").description == "New"


def test_find_by_alias(registry: CliRegistry, sample_command: CliCommand) -> None:
    registry.register_command(sample_command)

    assert registry.find_command("start") is not None
    assert registry.find_command("go") is not None
    assert registry.find_command("run") is not None
    assert registry.find_command("stop") is None


def test_command_names(registry: CliRegistry) -> None:
    registry.register_command(CliCommand(name="build", description="B", handler_name="h1"))
    registry.register_command(CliCommand(name="run", description="R", handler_name="h2"))
    registry.register_command(CliCommand(name="config", description="C", handler_name="h3"))

    names = registry.command_names()
    assert names == ["build", "config", "run"]


def test_clear(registry: CliRegistry) -> None:
    registry.register_command(CliCommand(name="a", description="A", handler_name="h1"))
    registry.register_command(CliCommand(name="b", description="B", handler_name="h2"))
    assert len(registry) == 2

    registry.clear()
    assert len(registry) == 0
    assert not registry


def test_contains_protocol(registry: CliRegistry) -> None:
    registry.register_command(CliCommand(name="run", description="R", handler_name="h"))
    assert "run" in registry
    assert "build" not in registry


def test_iter_protocol(registry: CliRegistry) -> None:
    registry.register_command(CliCommand(name="a", description="A", handler_name="h1"))
    registry.register_command(CliCommand(name="b", description="B", handler_name="h2"))
    names = {cmd.name for cmd in registry}
    assert names == {"a", "b"}


def test_command_with_args() -> None:
    cmd = (
        CliCommand(name="deploy", description="Deploy", handler_name="handle_deploy")
        .with_arg(CliArg.required_arg("target", "Deployment target"))
        .with_arg(CliArg.optional_arg("port", "Listen port", "3000"))
    )
    assert len(cmd.args) == 2
    assert cmd.args[0].required is True
    assert cmd.args[0].name == "target"
    assert cmd.args[1].required is False
    assert cmd.args[1].default_value == "3000"


def test_command_matches() -> None:
    cmd = CliCommand(
        name="run",
        description="Run",
        handler_name="h",
        aliases=("start", "go"),
    )
    assert cmd.matches("run")
    assert cmd.matches("start")
    assert cmd.matches("go")
    assert not cmd.matches("stop")


def test_unregister_nonexistent(registry: CliRegistry) -> None:
    result = registry.unregister_command("nonexistent")
    assert result is None
