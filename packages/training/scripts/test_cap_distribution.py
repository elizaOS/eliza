"""Unit tests for scripts/transform_cap_distribution.py.

CPU-only. Synthetic fixtures only — no real corpus on disk.
Consumed by the pre-flight gate (scripts/preflight.sh).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml

from scripts.transform_cap_distribution import (
    ELIZA_TIER_WHITELIST,
    apply_caps,
    primary_action,
    scan_corpus,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "transform_cap_distribution.py"


# ─────────────────────────── helpers ────────────────────────────


def _record(
    *,
    source: str,
    action: str,
    task_type: str = "reply",
    expected_response: str = "",
    available_actions: list[str] | None = None,
) -> dict:
    """Build a minimal valid record with the given source/action/task_type."""
    if available_actions is None:
        available_actions = [action]
    return {
        "roomName": "r",
        "agentId": "a",
        "memoryEntries": [],
        "currentMessage": {"role": "user", "speaker": "u", "content": "hi"},
        "expectedResponse": expected_response or f"reply: {action}",
        "availableActions": available_actions,
        "metadata": {
            "task_type": task_type,
            "source_dataset": source,
            "license": "unknown",
            "split": "train",
        },
    }


def _write_jsonl(path: Path, recs: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def _write_config(
    path: Path,
    *,
    max_per_source: int = 100_000,
    max_per_action: int = 50_000,
    max_non_eliza_fraction: float = 0.5,
    seed: int = 42,
    whitelist: list[str] | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cfg = {
        "seed": seed,
        "max_per_source": max_per_source,
        "max_per_action": max_per_action,
        "max_non_eliza_fraction": max_non_eliza_fraction,
        "eliza_tier_whitelist": whitelist or sorted(ELIZA_TIER_WHITELIST),
    }
    path.write_text(yaml.safe_dump(cfg), encoding="utf-8")


# ─────────────────────────── primary_action ────────────────────────────


def test_primary_action_routing_uses_available_actions_first():
    rec = _record(source="x", action="REPLY", task_type="reply",
                  available_actions=["REPLY", "IGNORE"])
    assert primary_action(rec) == "REPLY"


def test_primary_action_tool_call_uses_payload():
    er = "thought: do thing\nactions[1]{name,params}:\n  - name: TASK_CALL\n    params: ...\n"
    rec = _record(source="x", action="ignored", task_type="tool_call",
                  expected_response=er, available_actions=["TASK_CALL"])
    assert primary_action(rec) == "TASK_CALL"


def test_primary_action_unknown_falls_back_to_sentinel():
    rec = {
        "roomName": "r", "agentId": "a", "memoryEntries": [],
        "currentMessage": {"content": "hi"}, "expectedResponse": "",
        "availableActions": [], "metadata": {"task_type": "reply", "source_dataset": "x"},
    }
    assert primary_action(rec) == "_UNKNOWN_"


# ─────────────────────────── apply_caps ────────────────────────────


def test_per_action_cap_caps_dominant_action_exactly():
    # 1000 records of TASK_CALL, 50 of REPLY. Cap action at 100.
    records = [("srcA", "TASK_CALL", "tool_call")] * 1000 + \
              [("srcB", "REPLY", "reply")] * 50
    kept, drops = apply_caps(
        records,
        max_per_source=10_000,
        max_per_action=100,
        max_non_eliza_fraction=1.0,  # disable gate 3
        eliza_whitelist=frozenset(),
        seed=42,
    )
    after_actions = {}
    for i in kept:
        a = records[i][1]
        after_actions[a] = after_actions.get(a, 0) + 1
    assert after_actions["TASK_CALL"] == 100
    assert after_actions["REPLY"] == 50
    assert drops["too-many-of-action"] == 900


def test_non_eliza_fraction_gate_brings_below_cap():
    # 200 eliza records, 800 non-eliza records → 80% non-eliza.
    # Cap non-eliza at 50% → target ne = 200 * 0.5 / 0.5 = 200.
    eliza_recs = [("nubilio-trajectories", "REPLY", "reply")] * 200
    non_eliza_recs = [("agent-trove", "TASK_CALL", "tool_call")] * 800
    records = eliza_recs + non_eliza_recs
    kept, drops = apply_caps(
        records,
        max_per_source=10_000,
        max_per_action=10_000,
        max_non_eliza_fraction=0.5,
        eliza_whitelist=frozenset({"nubilio-trajectories"}),
        seed=42,
    )
    eliza_after = sum(1 for i in kept if records[i][0] == "nubilio-trajectories")
    non_eliza_after = sum(1 for i in kept if records[i][0] == "agent-trove")
    total = eliza_after + non_eliza_after
    assert eliza_after == 200          # eliza never downsampled by gate 3
    assert non_eliza_after / total <= 0.5 + 1e-9
    assert drops["non-eliza-fraction-exceeded"] == 600


def test_per_source_cap_caps_dominant_source_exactly():
    records = [("agent-trove", "TASK_CALL", "tool_call")] * 5000 + \
              [("scambench", "REPLY", "reply")] * 100
    kept, drops = apply_caps(
        records,
        max_per_source=500,
        max_per_action=10_000,
        max_non_eliza_fraction=1.0,
        eliza_whitelist=frozenset({"scambench"}),
        seed=42,
    )
    after_sources = {}
    for i in kept:
        s = records[i][0]
        after_sources[s] = after_sources.get(s, 0) + 1
    assert after_sources["agent-trove"] == 500
    assert after_sources["scambench"] == 100
    assert drops["too-many-of-source"] == 4500


def test_eliza_tier_never_dropped_by_fraction_gate():
    # Eliza source itself over-represented; gate 3 must not touch it.
    eliza_recs = [("scambench", "REPLY", "reply")] * 900
    non_eliza_recs = [("agent-trove", "TASK_CALL", "tool_call")] * 100
    records = eliza_recs + non_eliza_recs
    kept, drops = apply_caps(
        records,
        max_per_source=10_000,
        max_per_action=10_000,
        max_non_eliza_fraction=0.5,
        eliza_whitelist=frozenset({"scambench"}),
        seed=42,
    )
    # Already 90% eliza, so gate 3 is a no-op and keeps everything.
    assert len(kept) == 1000
    assert drops.get("non-eliza-fraction-exceeded", 0) == 0


# ─────────────────────────── end-to-end CLI ────────────────────────────


def _run_cli(*args: str | Path) -> subprocess.CompletedProcess:
    cmd = [sys.executable, str(SCRIPT), *map(str, args)]
    return subprocess.run(
        cmd, capture_output=True, text=True, cwd=str(REPO_ROOT), check=False,
    )


def test_e2e_dry_run_does_not_write_output(tmp_path: Path):
    inp = tmp_path / "in.jsonl"
    out = tmp_path / "out.jsonl"
    cfg = tmp_path / "caps.yaml"
    rep = tmp_path / "report.json"

    recs = [_record(source=f"src{i % 3}", action="REPLY") for i in range(30)]
    _write_jsonl(inp, recs)
    _write_config(cfg, max_per_source=5, max_per_action=1000,
                  max_non_eliza_fraction=1.0, whitelist=["nubilio-trajectories"])

    proc = _run_cli("--input", inp, "--output", out, "--config", cfg,
                    "--report", rep, "--dry-run")
    assert proc.returncode == 0, proc.stderr
    assert not out.exists(), "dry-run must not write output"
    assert rep.exists()
    summary = json.loads(proc.stdout.strip().splitlines()[-1])
    assert summary["dry_run"] is True
    # 3 sources × cap-of-5 = 15 kept; 30 input → 15 dropped by per-source.
    assert summary["after"] == 15
    assert summary["dropped"] == 15


def test_e2e_determinism_byte_identical(tmp_path: Path):
    inp = tmp_path / "in.jsonl"
    out_a = tmp_path / "out_a.jsonl"
    out_b = tmp_path / "out_b.jsonl"
    cfg = tmp_path / "caps.yaml"
    rep = tmp_path / "report.json"

    # Use a deterministic but cap-tripping mix.
    recs = []
    for i in range(200):
        recs.append(_record(source="agent-trove", action="TASK_CALL",
                            task_type="tool_call"))
    for i in range(50):
        recs.append(_record(source="scambench", action="REPLY"))
    _write_jsonl(inp, recs)
    _write_config(cfg, max_per_source=100, max_per_action=80,
                  max_non_eliza_fraction=0.5,
                  whitelist=["scambench"])

    p1 = _run_cli("--input", inp, "--output", out_a, "--config", cfg,
                  "--report", rep)
    assert p1.returncode == 0, p1.stderr
    p2 = _run_cli("--input", inp, "--output", out_b, "--config", cfg,
                  "--report", rep)
    assert p2.returncode == 0, p2.stderr

    assert out_a.read_bytes() == out_b.read_bytes(), \
        "same seed + same input must produce byte-identical output"


def test_e2e_writes_capped_jsonl(tmp_path: Path):
    inp = tmp_path / "in.jsonl"
    out = tmp_path / "intermediate" / "out.jsonl"
    cfg = tmp_path / "caps.yaml"
    rep = tmp_path / "review" / "report.json"

    recs = [_record(source="agent-trove", action="TASK_CALL",
                    task_type="tool_call") for _ in range(100_000)]
    recs += [_record(source="scambench", action="REPLY") for _ in range(100)]
    _write_jsonl(inp, recs)
    _write_config(cfg, max_per_source=1_000, max_per_action=50_000,
                  max_non_eliza_fraction=0.5,
                  whitelist=["scambench"])

    proc = _run_cli("--input", inp, "--output", out, "--config", cfg,
                    "--report", rep)
    assert proc.returncode == 0, proc.stderr
    assert out.exists()
    assert rep.exists()

    # Count lines in output.
    written = sum(1 for _ in out.open())
    report = json.loads(rep.read_text())
    assert report["totals"]["after"] == written
    # agent-trove capped at 1,000 by per-source, but gate 3 then trims it
    # further to satisfy max_non_eliza_fraction=0.5 vs 100 eliza records.
    # Final non-eliza fraction must be ≤ 0.5.
    assert report["non_eliza_fraction"]["after"] <= 0.5 + 1e-9


# ─────────────────────────── scan_corpus ────────────────────────────


def test_scan_corpus_counts_match(tmp_path: Path):
    inp = tmp_path / "in.jsonl"
    recs = [
        _record(source="A", action="REPLY", task_type="reply"),
        _record(source="A", action="REPLY", task_type="reply"),
        _record(source="B", action="TASK_CALL", task_type="tool_call"),
    ]
    _write_jsonl(inp, recs)
    records, by_src, by_act, by_tt, by_src_tt = scan_corpus(inp)
    assert len(records) == 3
    assert by_src == {"A": 2, "B": 1}
    assert by_act == {"REPLY": 2, "TASK_CALL": 1}
    assert by_tt == {"reply": 2, "tool_call": 1}
    assert by_src_tt[("A", "reply")] == 2
    assert by_src_tt[("B", "tool_call")] == 1
