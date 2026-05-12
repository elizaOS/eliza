"""Unit tests for scripts.lib.backends.vast.VastBackend.

Mocks ``subprocess.run`` and the ``scripts.lib.vast`` low-level shim so
the adapter contract can be verified without touching the real
``vastai`` binary or vast.ai's API. CPU-only.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

from scripts.lib import vast as _vast_cli
from scripts.lib.backends.base import (
    BACKEND_REGISTRY,
    BackendError,
    InstanceHandle,
    NoOffersError,
    Offer,
    OfferConstraints,
    ProvisionError,
)
from scripts.lib.backends.vast import VastBackend


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def backend() -> VastBackend:
    return VastBackend()


@pytest.fixture
def handle() -> InstanceHandle:
    return InstanceHandle(
        backend="vast",
        instance_id="42",
        label="test-label",
        created_at=0.0,
    )


def _raw_vast_offer(*, oid: int = 12345, dph: float = 1.07) -> dict[str, Any]:
    return {
        "id": oid,
        "gpu_name": "RTX_PRO_6000_S",
        "num_gpus": 1,
        "gpu_total_ram": 96 * 1024,
        "dph_total": dph,
        "dlperf": 100.0,
        "reliability2": 0.985,
        "inet_down": 1200.0,
        "inet_up": 800.0,
        "disk_space": 1500.0,
        "duration": 7 * 86400.0,
        "geolocation": "US-CA",
        "cuda_max_good": 12.6,
    }


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------


def test_vast_backend_is_registered() -> None:
    assert BACKEND_REGISTRY.get("vast") is VastBackend
    assert VastBackend.name == "vast"


# ---------------------------------------------------------------------------
# search_offers
# ---------------------------------------------------------------------------


def test_search_offers_parses_vastai_json_into_offer(
    backend: VastBackend,
) -> None:
    raw = [_raw_vast_offer(oid=111, dph=0.95), _raw_vast_offer(oid=222, dph=1.50)]
    parsed = [_vast_cli.Offer.from_raw(r) for r in raw]
    with mock.patch.object(_vast_cli, "search", return_value=parsed):
        offers = backend.search_offers(
            OfferConstraints(gpu_target="blackwell6000-1x")
        )

    assert len(offers) == 2
    first = offers[0]
    assert isinstance(first, Offer)
    assert first.backend == "vast"
    assert first.id == "111"
    assert first.gpu_name == "RTX_PRO_6000_S"
    assert first.num_gpus == 1
    assert first.gpu_total_ram_gb == 96
    assert first.dph == pytest.approx(0.95)
    assert first.reliability == pytest.approx(0.985)
    assert first.inet_down_mbps == pytest.approx(1200.0)
    assert first.geolocation == "US-CA"


def test_search_offers_raises_no_offers_when_empty(backend: VastBackend) -> None:
    with mock.patch.object(_vast_cli, "search", return_value=[]):
        with pytest.raises(NoOffersError) as exc:
            backend.search_offers(
                OfferConstraints(gpu_target="blackwell6000-1x")
            )
    assert "no vast offers match" in str(exc.value)


def test_search_offers_applies_max_dph_filter(backend: VastBackend) -> None:
    parsed = [
        _vast_cli.Offer.from_raw(_raw_vast_offer(oid=111, dph=0.95)),
        _vast_cli.Offer.from_raw(_raw_vast_offer(oid=222, dph=2.50)),
    ]
    with mock.patch.object(_vast_cli, "search", return_value=parsed):
        offers = backend.search_offers(
            OfferConstraints(gpu_target="blackwell6000-1x", max_dph=1.00)
        )
    assert [o.id for o in offers] == ["111"]


# ---------------------------------------------------------------------------
# provision
# ---------------------------------------------------------------------------


def test_provision_raises_on_vastai_create_failure(
    backend: VastBackend, tmp_path: Path
) -> None:
    pubkey = tmp_path / "id_test.pub"
    pubkey.write_text("ssh-ed25519 AAAA test\n")
    err = subprocess.CalledProcessError(
        returncode=1,
        cmd=["vastai", "create", "instance"],
        output="",
        stderr="api error: offer not available\n",
    )
    with mock.patch.object(subprocess, "run", side_effect=err):
        with pytest.raises(ProvisionError) as exc:
            backend.provision(
                "999",
                disk_gb=2048,
                image="pytorch/pytorch:2.6.0-cuda12.6-cudnn9-devel",
                ssh_pubkey_path=pubkey,
                label="eliza-test",
            )
    msg = str(exc.value)
    assert "vastai create instance failed" in msg
    assert "offer not available" in msg


def test_provision_raises_on_missing_pubkey(
    backend: VastBackend, tmp_path: Path
) -> None:
    with pytest.raises(ProvisionError) as exc:
        backend.provision(
            "999",
            disk_gb=100,
            image="img",
            ssh_pubkey_path=tmp_path / "missing.pub",
            label="eliza-test",
        )
    assert "ssh public key not found" in str(exc.value)


def test_provision_returns_instance_handle_on_success(
    backend: VastBackend, tmp_path: Path
) -> None:
    pubkey = tmp_path / "id_test.pub"
    pubkey.write_text("ssh-ed25519 AAAA test\n")
    create_payload = json.dumps({"new_contract": 12345678, "success": True})

    def fake_run(
        cmd: list[str], **kwargs: Any
    ) -> "subprocess.CompletedProcess[str]":
        if "create" in cmd:
            return subprocess.CompletedProcess(
                args=cmd, returncode=0, stdout=create_payload, stderr=""
            )
        if "attach" in cmd:
            return subprocess.CompletedProcess(
                args=cmd, returncode=0, stdout="", stderr=""
            )
        raise AssertionError(f"unexpected command: {cmd!r}")

    with mock.patch.object(subprocess, "run", side_effect=fake_run):
        handle = backend.provision(
            "999",
            disk_gb=2048,
            image="pytorch/pytorch:2.6.0-cuda12.6-cudnn9-devel",
            ssh_pubkey_path=pubkey,
            label="eliza-test",
        )
    assert handle.backend == "vast"
    assert handle.instance_id == "12345678"
    assert handle.label == "eliza-test"


# ---------------------------------------------------------------------------
# teardown idempotency
# ---------------------------------------------------------------------------


def test_teardown_succeeds_on_first_call(
    backend: VastBackend, handle: InstanceHandle
) -> None:
    ok = subprocess.CompletedProcess(
        args=["vastai", "destroy", "instance", "42"],
        returncode=0, stdout="ok\n", stderr="",
    )
    with mock.patch.object(subprocess, "run", return_value=ok) as run:
        backend.teardown(handle)
    run.assert_called_once()


def test_teardown_is_idempotent_when_instance_already_gone(
    backend: VastBackend, handle: InstanceHandle, caplog: pytest.LogCaptureFixture
) -> None:
    err = subprocess.CalledProcessError(
        returncode=1,
        cmd=["vastai", "destroy", "instance", "42"],
        output="",
        stderr="error: no such instance 42\n",
    )
    with mock.patch.object(subprocess, "run", side_effect=err):
        # Must NOT raise — second teardowns are expected to no-op.
        backend.teardown(handle)
    # Warning must be logged so operators see the no-op.
    assert any(
        "already destroyed" in rec.getMessage() for rec in caplog.records
    )


def test_teardown_raises_on_unrelated_failure(
    backend: VastBackend, handle: InstanceHandle
) -> None:
    err = subprocess.CalledProcessError(
        returncode=1,
        cmd=["vastai", "destroy", "instance", "42"],
        output="",
        stderr="auth error: invalid api key\n",
    )
    with mock.patch.object(subprocess, "run", side_effect=err):
        with pytest.raises(BackendError) as exc:
            backend.teardown(handle)
    assert "auth error" in str(exc.value)
