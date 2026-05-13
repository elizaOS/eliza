"""Calibration invariants for the per-tier RAM budgets.

`packages/inference/AGENTS.md` §8 + §6: the manifest `ramBudgetMb.recommended`
is what the 30-turn endurance gate (`thirtyTurnOk`) compares the fused
llama-server's peak RSS against. The 2026-05-11 e2e voice-loop benchmark
(`packages/inference/verify/bench_results/e2e_loop_2026-05-11.json`) measured
~3132 MB (0_8b) and ~4828 MB (2b) server peak RSS in voice-on mode — the
fused process keeps text + DFlash drafter + OmniVoice (base/tokenizer/DAC/
HuBERT/sem-enc) + Qwen3-ASR + mmproj all resident. The budgets in
`DEFAULT_RAM_BUDGET_MB` must therefore (a) be identical across the three
staging entry points that emit a manifest, and (b) leave headroom above the
measured peak so `thirtyTurnOk` is achievable on the bench host.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# packages/training/scripts/manifest/test_ram_budget_calibration.py → packages/training
_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest import stage_local_eliza1_bundle as stage_local
from scripts.manifest import stage_real_eliza1_bundle as stage_real
from scripts.publish import orchestrator as orch

# Measured server peak RSS (MB) from the 2026-05-11 e2e voice-loop bench.
# Source: packages/inference/verify/bench_results/e2e_loop_2026-05-11.json
#         (30-turn run for each tier).
_E2E_PEAK_RSS_MB = {"0_8b": 3132, "2b": 4828}


def test_default_ram_budget_is_consistent_across_staging_entry_points() -> None:
    """orchestrator + stage_local + stage_real must agree tier-for-tier."""
    base = dict(orch.DEFAULT_RAM_BUDGET_MB)
    local = dict(stage_local.DEFAULT_RAM_BUDGET_MB)
    real = dict(stage_real.DEFAULT_RAM_BUDGET_MB)
    for tier, budget in base.items():
        assert local[tier] == budget, (tier, local[tier], budget)
        assert real[tier] == budget, (tier, real[tier], budget)


def test_voice_tier_budgets_clear_the_measured_e2e_peak_rss() -> None:
    """recommended >= measured fused-server peak RSS (+ headroom) for 0_8b/2b.

    This is the invariant that makes the 30-turn `thirtyTurnOk` gate
    achievable: the bench derives it from `peakRss <= ramBudgetMb.recommended`.
    """
    for tier, peak in _E2E_PEAK_RSS_MB.items():
        ram_min, ram_rec = orch.DEFAULT_RAM_BUDGET_MB[tier]
        assert ram_rec >= peak, (tier, ram_rec, peak)
        # At least ~5% headroom so a noisier run still passes.
        assert ram_rec >= peak * 1.05, (tier, ram_rec, peak)
        # min must be a real floor below recommended.
        assert ram_min < ram_rec, (tier, ram_min, ram_rec)


def test_recorded_e2e_bench_thirty_turn_ok_matches_budget() -> None:
    """The committed e2e bench report's `thirtyTurnOk` is consistent with the budget."""
    report_path = (
        _TRAINING_ROOT.parents[1]
        / "packages"
        / "inference"
        / "verify"
        / "bench_results"
        / "e2e_loop_2026-05-11.json"
    )
    if not report_path.is_file():
        return  # bench report not present in this checkout — nothing to check
    data = json.loads(report_path.read_text())
    for run in data.get("runs", []):
        if run.get("thirtyTurnOk") is None:
            continue
        summary = run.get("summary") or {}
        peak = summary.get("serverPeakRssMb")
        rec = summary.get("ramBudgetRecommendedMb")
        if peak is None or rec is None:
            continue
        within = peak <= rec
        # If the run completed cleanly, thirtyTurnOk should track `within`.
        if run.get("thirtyTurnOk") is True:
            assert within, (run.get("request", {}).get("tier"), peak, rec)
