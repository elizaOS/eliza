"""Unit tests for scripts.lib.vast_budget.

Mocks the vastai instance-show call and the wall clock so the budget
math can be verified deterministically. CPU-only and entirely offline —
the module under test never touches the real vastai binary in these
tests.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

from scripts.lib import vast_budget


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def isolated_state_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Redirect ELIZA_STATE_DIR so writes from enforce() are sandboxed."""
    monkeypatch.setenv("ELIZA_STATE_DIR", str(tmp_path))
    # Make sure no operator ELIZA_VAST_MAX_USD leaks into the test process.
    monkeypatch.delenv("ELIZA_VAST_MAX_USD", raising=False)
    return tmp_path


def _show_payload(
    *,
    dph: float = 3.51,
    start_offset_s: float = 3600.0,
    state: str = "running",
    gpu: str = "B200",
    num_gpus: int = 2,
    now_value: float = 1_000_000.0,
) -> dict[str, Any]:
    """Build a ``vastai show instance --raw`` payload as the module expects."""
    return {
        "id": 42,
        "actual_status": state,
        "gpu_name": gpu,
        "num_gpus": num_gpus,
        "dph_total": dph,
        "start_date": now_value - start_offset_s,
    }


# ---------------------------------------------------------------------------
# fetch_snapshot
# ---------------------------------------------------------------------------


def test_snapshot_computes_total_so_far_from_dph_and_uptime() -> None:
    now = 1_000_000.0
    payload = _show_payload(dph=4.00, start_offset_s=2 * 3600.0, now_value=now)

    snap = vast_budget.fetch_snapshot(
        42,
        pipeline="qwen3.5-9b-apollo",
        run_name="run-1",
        show_fn=lambda _id: payload,
        now_fn=lambda: now,
    )

    assert snap.pipeline == "qwen3.5-9b-apollo"
    assert snap.run_name == "run-1"
    assert snap.gpu_sku == "B200x2"
    assert snap.dph_total == pytest.approx(4.00)
    assert snap.uptime_seconds == pytest.approx(2 * 3600.0)
    assert snap.uptime_pretty == "2:00:00"
    # 4 USD/hr × 2 h = 8 USD
    assert snap.total_so_far_usd == pytest.approx(8.00)
    assert snap.soft_cap_usd is None
    assert snap.hard_cap_usd is None
    assert snap.over_soft is False
    assert snap.over_hard is False


def test_snapshot_reads_soft_and_hard_caps_from_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "10")
    now = 1_000_000.0
    payload = _show_payload(dph=2.00, start_offset_s=3600.0, now_value=now)

    snap = vast_budget.fetch_snapshot(
        42,
        pipeline="p",
        run_name="r",
        show_fn=lambda _id: payload,
        now_fn=lambda: now,
    )

    assert snap.soft_cap_usd == pytest.approx(10.0)
    assert snap.hard_cap_usd == pytest.approx(15.0)
    # 2 × 1h = 2 USD, well under both caps.
    assert snap.total_so_far_usd == pytest.approx(2.0)
    assert snap.over_soft is False
    assert snap.over_hard is False


def test_snapshot_invalid_max_usd_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "not-a-number")
    with pytest.raises(SystemExit) as exc:
        vast_budget.fetch_snapshot(
            42,
            pipeline="p",
            run_name="r",
            show_fn=lambda _id: _show_payload(),
            now_fn=lambda: 1_000_000.0,
        )
    assert "must be a number" in str(exc.value)


def test_snapshot_negative_max_usd_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "-5")
    with pytest.raises(SystemExit) as exc:
        vast_budget.fetch_snapshot(
            42,
            pipeline="p",
            run_name="r",
            show_fn=lambda _id: _show_payload(),
            now_fn=lambda: 1_000_000.0,
        )
    assert "must be > 0" in str(exc.value)


def test_snapshot_missing_start_date_means_zero_uptime() -> None:
    now = 1_000_000.0
    payload = _show_payload(now_value=now)
    payload["start_date"] = 0  # not yet booted
    snap = vast_budget.fetch_snapshot(
        42,
        pipeline="p",
        run_name="r",
        show_fn=lambda _id: payload,
        now_fn=lambda: now,
    )
    assert snap.uptime_seconds == 0.0
    assert snap.total_so_far_usd == 0.0


def test_snapshot_empty_payload_raises() -> None:
    with pytest.raises(SystemExit) as exc:
        vast_budget.fetch_snapshot(
            42,
            pipeline="p",
            run_name="r",
            show_fn=lambda _id: {},
            now_fn=lambda: 1_000_000.0,
        )
    assert "empty payload" in str(exc.value)


# ---------------------------------------------------------------------------
# enforce — the cap policy
# ---------------------------------------------------------------------------


def test_enforce_returns_ok_under_soft_cap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "10")
    now = 1_000_000.0
    payload = _show_payload(dph=3.0, start_offset_s=1 * 3600.0, now_value=now)

    snap, rc = vast_budget.enforce(
        42,
        pipeline="p",
        run_name="r",
        show_fn=lambda _id: payload,
        now_fn=lambda: now,
    )

    assert rc == vast_budget.EXIT_OK
    # 3 USD/hr × 1 h = 3 USD, under 10 USD cap.
    assert snap.total_so_far_usd == pytest.approx(3.0)
    assert not (tmp_path / "vast-budget" / "42.teardown").exists()


def test_enforce_returns_soft_breach_when_over_soft_but_under_hard(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "10")
    now = 1_000_000.0
    # 3 USD/hr × 4 h = 12 USD — over soft (10) but under hard (15).
    payload = _show_payload(dph=3.0, start_offset_s=4 * 3600.0, now_value=now)

    snap, rc = vast_budget.enforce(
        42,
        pipeline="p",
        run_name="r",
        show_fn=lambda _id: payload,
        now_fn=lambda: now,
    )

    assert rc == vast_budget.EXIT_OVER_SOFT
    assert snap.over_soft is True
    assert snap.over_hard is False
    # event was appended; sentinel was NOT created (we only kill on hard).
    assert (tmp_path / "vast-budget" / "42.events.jsonl").is_file()
    assert not (tmp_path / "vast-budget" / "42.teardown").exists()


def test_enforce_hard_cap_writes_teardown_sentinel(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The dry-run contract: enforce() never destroys an instance directly.

    The watcher reads the sentinel and runs ``vastai destroy instance``.
    Keeping the destructive call out of the module makes test runs safe.
    """
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "10")
    now = 1_000_000.0
    # 3 USD/hr × 6 h = 18 USD — over hard (15).
    payload = _show_payload(dph=3.0, start_offset_s=6 * 3600.0, now_value=now)

    snap, rc = vast_budget.enforce(
        42,
        pipeline="qwen3.5-9b-apollo",
        run_name="run-1",
        show_fn=lambda _id: payload,
        now_fn=lambda: now,
    )

    assert rc == vast_budget.EXIT_OVER_HARD
    assert snap.over_soft is True
    assert snap.over_hard is True
    assert snap.total_so_far_usd == pytest.approx(18.0)
    assert snap.hard_cap_usd == pytest.approx(15.0)

    sentinel = tmp_path / "vast-budget" / "42.teardown"
    assert sentinel.is_file()
    payload_json = json.loads(sentinel.read_text())
    assert payload_json["instance_id"] == 42
    assert payload_json["reason"] == "hard_cap_breach"
    assert payload_json["total_so_far_usd"] == pytest.approx(18.0)

    # event log records the breach for forensics.
    events = (tmp_path / "vast-budget" / "42.events.jsonl").read_text().splitlines()
    assert any("hard_cap_breach" in line for line in events)


def test_enforce_hard_cap_is_idempotent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Re-running enforce after a hard breach must not rewrite the sentinel.

    The watcher polls every minute; if the first breach pass triggered
    a teardown but the destroy call hadn't finished yet, we'd see the
    instance still alive on the next pass. The sentinel must already
    exist so we don't blow away the forensic record.
    """
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "10")
    now = 1_000_000.0
    payload = _show_payload(dph=3.0, start_offset_s=6 * 3600.0, now_value=now)
    sentinel = tmp_path / "vast-budget" / "42.teardown"

    vast_budget.enforce(
        42,
        pipeline="p",
        run_name="r",
        show_fn=lambda _id: payload,
        now_fn=lambda: now,
    )
    first_mtime = sentinel.stat().st_mtime

    # Second pass with a later clock should not rewrite the file.
    vast_budget.enforce(
        42,
        pipeline="p",
        run_name="r",
        show_fn=lambda _id: payload,
        now_fn=lambda: now + 600.0,
    )
    second_mtime = sentinel.stat().st_mtime
    assert first_mtime == second_mtime


def test_enforce_with_no_cap_configured_always_returns_ok(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """No ELIZA_VAST_MAX_USD => budget is opt-in, never enforced."""
    monkeypatch.delenv("ELIZA_VAST_MAX_USD", raising=False)
    now = 1_000_000.0
    # Would be very over any reasonable cap if one were set.
    payload = _show_payload(dph=100.0, start_offset_s=100 * 3600.0, now_value=now)

    snap, rc = vast_budget.enforce(
        42,
        pipeline="p",
        run_name="r",
        show_fn=lambda _id: payload,
        now_fn=lambda: now,
    )
    assert rc == vast_budget.EXIT_OK
    assert snap.soft_cap_usd is None
    assert snap.hard_cap_usd is None
    assert snap.over_soft is False
    assert snap.over_hard is False
    assert not (tmp_path / "vast-budget" / "42.teardown").exists()


# ---------------------------------------------------------------------------
# CLI surface — verifies the bash launcher contract
# ---------------------------------------------------------------------------


def test_cli_snapshot_prints_one_line_summary(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "10")
    now = 1_000_000.0
    payload = _show_payload(dph=3.51, start_offset_s=2 * 3600.0, now_value=now)
    with mock.patch.object(
        vast_budget, "fetch_snapshot",
        return_value=vast_budget.fetch_snapshot(
            42,
            pipeline="qwen3.5-9b-apollo",
            run_name="run-1",
            show_fn=lambda _id: payload,
            now_fn=lambda: now,
        ),
    ):
        rc = vast_budget.main(
            ["snapshot", "42", "--pipeline", "qwen3.5-9b-apollo",
             "--run-name", "run-1"]
        )
    assert rc == vast_budget.EXIT_OK
    out = capsys.readouterr().out
    assert "pipeline=qwen3.5-9b-apollo" in out
    assert "gpu=B200x2" in out
    assert "$/hr=$3.51" in out
    assert "total=$7.02" in out  # 3.51 * 2


def test_cli_snapshot_json_emits_full_record(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "10")
    now = 1_000_000.0
    payload = _show_payload(dph=2.0, start_offset_s=3600.0, now_value=now)
    with mock.patch.object(
        vast_budget, "fetch_snapshot",
        return_value=vast_budget.fetch_snapshot(
            42, pipeline="p", run_name="r",
            show_fn=lambda _id: payload, now_fn=lambda: now,
        ),
    ):
        rc = vast_budget.main(
            ["snapshot", "42", "--pipeline", "p", "--run-name", "r", "--json"]
        )
    assert rc == vast_budget.EXIT_OK
    record = json.loads(capsys.readouterr().out)
    assert record["pipeline"] == "p"
    assert record["dph_total"] == pytest.approx(2.0)
    assert record["soft_cap_usd"] == pytest.approx(10.0)
    assert record["hard_cap_usd"] == pytest.approx(15.0)


def test_cli_enforce_returns_hard_cap_exit_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Asserts the bash launcher contract: rc=11 => watcher initiates teardown."""
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "10")
    now = 1_000_000.0
    payload = _show_payload(dph=3.0, start_offset_s=6 * 3600.0, now_value=now)

    with mock.patch.object(
        vast_budget._vast_cli, "show_instance", return_value=payload
    ), mock.patch.object(vast_budget.time, "time", return_value=now):
        rc = vast_budget.main(["enforce", "42", "--pipeline", "p", "--run-name", "r"])
    assert rc == vast_budget.EXIT_OVER_HARD
    assert (tmp_path / "vast-budget" / "42.teardown").is_file()


def test_cli_enforce_returns_soft_cap_exit_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("ELIZA_VAST_MAX_USD", "10")
    now = 1_000_000.0
    payload = _show_payload(dph=3.0, start_offset_s=4 * 3600.0, now_value=now)

    with mock.patch.object(
        vast_budget._vast_cli, "show_instance", return_value=payload
    ), mock.patch.object(vast_budget.time, "time", return_value=now):
        rc = vast_budget.main(["enforce", "42", "--pipeline", "p", "--run-name", "r"])
    assert rc == vast_budget.EXIT_OVER_SOFT
    # Soft cap => warning event only; no destructive sentinel.
    assert not (tmp_path / "vast-budget" / "42.teardown").exists()


def test_teardown_sentinel_path_is_stable() -> None:
    """The watcher consumes teardown_sentinel() — its layout is API."""
    p = vast_budget.teardown_sentinel(123)
    assert p.endswith(os.path.join("vast-budget", "123.teardown"))
