"""Tests for the OpenPI local server launcher."""

from __future__ import annotations

import subprocess

import pytest

from eliza_robot.policy.openpi import server


def test_build_command_includes_gpu_port_policy_env_and_volume() -> None:
    argv = server.build_command(
        image="registry.example/openpi:prod",
        port=9300,
        policy="pi0_ainex",
        gpu=True,
        detach=True,
        name="openpi-a",
        env=("MODEL=/models/pi0",),
        volume=("/tmp/models:/models:ro",),
    )

    assert argv == [
        "docker",
        "run",
        "--rm",
        "-d",
        "--name",
        "openpi-a",
        "--gpus",
        "all",
        "-e",
        "MODEL=/models/pi0",
        "-v",
        "/tmp/models:/models:ro",
        "-p",
        "9300:9300",
        "registry.example/openpi:prod",
        "--policy",
        "pi0_ainex",
    ]


@pytest.mark.parametrize("port", [0, 65536])
def test_build_command_rejects_invalid_ports(port: int) -> None:
    with pytest.raises(ValueError, match="port must be in 1..65535"):
        server.build_command(port=port)


def test_main_prints_command_by_default(capsys: pytest.CaptureFixture[str]) -> None:
    code = server.main(["--port", "9300", "--policy", "pi0_ainex", "--no-gpu"])

    captured = capsys.readouterr()
    assert code == 0
    assert captured.err == ""
    assert captured.out.strip() == (
        "docker run --rm -it -p 9300:9300 "
        "physical-intelligence/openpi-server:latest --policy pi0_ainex"
    )


def test_main_execute_fails_closed_when_docker_is_missing(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(server.shutil, "which", lambda _name: None)

    code = server.main(["--execute"])

    captured = capsys.readouterr()
    assert code == 127
    assert "Executing: docker run" in captured.out
    assert "Docker executable not found" in captured.err


def test_main_execute_uses_resolved_docker_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake_run(argv: list[str], *, check: bool) -> subprocess.CompletedProcess[str]:
        calls.append(argv)
        assert check is False
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(server.shutil, "which", lambda _name: "/usr/local/bin/docker")
    monkeypatch.setattr(server.subprocess, "run", fake_run)

    code = server.main(["--execute", "--no-gpu", "--port", "9300"])

    assert code == 0
    assert calls == [
        [
            "/usr/local/bin/docker",
            "run",
            "--rm",
            "-it",
            "-p",
            "9300:9300",
            "physical-intelligence/openpi-server:latest",
            "--policy",
            "pi0_ainex",
        ]
    ]
