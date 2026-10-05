"""Unit tests for the Docker pre-flight check and image-pull error surfaces.

These tests do not require a live Docker daemon — they mock the
``docker`` Python client to simulate daemon-down, rate-limit, and
authentication-failure cases. They are the test plan exit criteria for
the Docker robustness work in ``environment.py``.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from elizaos_terminal_bench import environment as env_mod
from elizaos_terminal_bench.environment import (
    TerminalBenchDockerUnavailableError,
    TerminalBenchImagePullError,
    TerminalEnvironmentError,
    _docker_install_hint,
    _pull_image_with_retries,
    check_docker,
)


# ---------------------------------------------------------------------------
# Pre-flight: daemon unreachable
# ---------------------------------------------------------------------------


class _FakeDockerException(Exception):
    """Stand-in for docker.errors.DockerException."""


@pytest.fixture(autouse=True)
def _reset_pull_cache():
    """Each test starts with an empty pulled-image cache so cases don't leak."""
    env_mod._pulled_images.clear()
    env_mod._auth_hint_logged = False
    yield
    env_mod._pulled_images.clear()
    env_mod._auth_hint_logged = False


@pytest.mark.parametrize(
    "system,fragment",
    [
        ("Windows", "Docker Desktop"),
        ("Darwin", "brew install --cask docker"),
        ("Linux", "docker.io"),
    ],
)
def test_install_hint_per_platform(system: str, fragment: str) -> None:
    """Each platform gets its own actionable hint."""
    with patch("elizaos_terminal_bench.environment.platform.system", return_value=system):
        hint = _docker_install_hint()
    assert fragment in hint, hint


@pytest.mark.parametrize(
    "system,fragment",
    [
        ("Windows", "Docker Desktop"),
        ("Darwin", "brew install --cask docker"),
        ("Linux", "docker.io"),
    ],
)
def test_check_docker_raises_unavailable_with_platform_hint(system: str, fragment: str) -> None:
    """When ``ping()`` fails the error message must include the
    platform-specific install hint."""
    fake_client = MagicMock()
    fake_client.ping.side_effect = _FakeDockerException("connection refused")
    with patch("elizaos_terminal_bench.environment.docker") as docker_mod, \
         patch("elizaos_terminal_bench.environment.platform.system", return_value=system):
        docker_mod.from_env.return_value = fake_client
        with pytest.raises(TerminalBenchDockerUnavailableError) as exc_info:
            check_docker()
    msg = str(exc_info.value)
    assert "Docker daemon is not reachable" in msg
    assert fragment in msg
    # Also surfaces the skip-on-error escape hatch so users know they have an option.
    assert "--skip-on-docker-error" in msg


def test_check_docker_returns_client_when_ping_succeeds() -> None:
    fake_client = MagicMock()
    fake_client.ping.return_value = True
    with patch("elizaos_terminal_bench.environment.docker") as docker_mod:
        docker_mod.from_env.return_value = fake_client
        out = check_docker()
    assert out is fake_client
    fake_client.ping.assert_called_once()


def test_check_docker_when_package_missing(monkeypatch) -> None:
    """If the ``docker`` package never imported we still surface a clean error."""
    monkeypatch.setattr(env_mod, "DOCKER_AVAILABLE", False)
    with pytest.raises(TerminalBenchDockerUnavailableError) as exc_info:
        check_docker()
    assert "pip install docker" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Image pull: rate limit (429)
# ---------------------------------------------------------------------------


class _FakeAPIError(Exception):
    """Stand-in for docker.errors.APIError that exposes ``status_code``."""

    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


def test_pull_image_raises_rate_limit_error_on_429() -> None:
    client = MagicMock()
    # ``images.get`` raises so we proceed to pull.
    client.images.get.side_effect = Exception("not present")
    client.images.pull.side_effect = _FakeAPIError(
        "toomanyrequests: You have reached your pull rate limit", 429
    )
    with pytest.raises(TerminalBenchImagePullError) as exc_info:
        _pull_image_with_retries(client, "python:3.11-slim", max_retries=0)
    msg = str(exc_info.value)
    assert "429" in msg or "rate limit" in msg.lower()
    assert "docker login" in msg.lower()


def test_pull_image_detects_rate_limit_in_message_without_status_code() -> None:
    """Some clients raise generic Exception with a 'toomanyrequests' substring."""
    client = MagicMock()
    client.images.get.side_effect = Exception("not present")
    client.images.pull.side_effect = Exception(
        "toomanyrequests: Too Many Requests"
    )
    with pytest.raises(TerminalBenchImagePullError) as exc_info:
        _pull_image_with_retries(client, "python:3.11-slim", max_retries=0)
    assert "rate limit" in str(exc_info.value).lower()


# ---------------------------------------------------------------------------
# Image pull: auth failures (401 / 403)
# ---------------------------------------------------------------------------


def test_pull_image_raises_auth_error_on_401_for_ghcr() -> None:
    client = MagicMock()
    client.images.get.side_effect = Exception("not present")
    client.images.pull.side_effect = _FakeAPIError(
        "unauthorized: HTTP Basic: Access denied", 401
    )
    with pytest.raises(TerminalBenchImagePullError) as exc_info:
        _pull_image_with_retries(
            client, "ghcr.io/laude-institute/t-bench/python-3-13:latest", max_retries=0
        )
    msg = str(exc_info.value)
    assert "authentication" in msg.lower()
    assert "docker login ghcr.io" in msg
    assert "read:packages" in msg


def test_pull_image_auth_error_on_403_dockerhub() -> None:
    client = MagicMock()
    client.images.get.side_effect = Exception("not present")
    client.images.pull.side_effect = _FakeAPIError("denied: requested access denied", 403)
    with pytest.raises(TerminalBenchImagePullError) as exc_info:
        _pull_image_with_retries(client, "private/image:tag", max_retries=0)
    msg = str(exc_info.value)
    assert "authentication" in msg.lower()
    assert "docker login" in msg


# ---------------------------------------------------------------------------
# Image pull: caching
# ---------------------------------------------------------------------------


def test_pulled_images_cache_prevents_duplicate_pulls() -> None:
    client = MagicMock()
    client.images.get.side_effect = Exception("not present")
    # First call: succeed.
    _pull_image_with_retries(client, "python:3.11-slim", max_retries=0)
    assert client.images.pull.call_count == 1
    assert "python:3.11-slim" in env_mod._pulled_images

    # Second call: cached, no new pull.
    _pull_image_with_retries(client, "python:3.11-slim", max_retries=0)
    assert client.images.pull.call_count == 1


def test_pull_image_uses_local_image_without_network() -> None:
    """If the image is already present locally we skip ``pull()`` entirely."""
    client = MagicMock()
    # ``images.get`` succeeds -> nothing else gets called.
    client.images.get.return_value = MagicMock()
    _pull_image_with_retries(client, "ubuntu:22.04", max_retries=0)
    client.images.pull.assert_not_called()
    assert "ubuntu:22.04" in env_mod._pulled_images


# ---------------------------------------------------------------------------
# Image pull: generic transport error -> retry then re-raise as
# TerminalEnvironmentError (not Image*PullError, which is reserved for
# actionable cases).
# ---------------------------------------------------------------------------


def test_pull_image_retries_then_raises_transport_error() -> None:
    client = MagicMock()
    client.images.get.side_effect = Exception("not present")
    client.images.pull.side_effect = RuntimeError("connection reset by peer")
    with pytest.raises(TerminalEnvironmentError) as exc_info:
        _pull_image_with_retries(client, "python:3.11-slim", max_retries=2)
    # 1 initial + 2 retries.
    assert client.images.pull.call_count == 3
    assert "Failed to pull image" in str(exc_info.value)
    # Generic transport failure must NOT be tagged as the more specific
    # ImagePullError, which is reserved for actionable cases.
    assert not isinstance(exc_info.value, TerminalBenchImagePullError)
