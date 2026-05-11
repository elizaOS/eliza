"""Drift benchmark — measures whether planted facts survive forced compactions.

This module owns:

1. ``DriftEvent``, ``DriftRunSummary``, ``DriftResult`` — data classes for the
   JSONL events emitted by ``scripts/benchmark/drift-harness.ts`` and the
   aggregate metrics computed from them.
2. ``DriftBenchmarkSuite`` — mirrors ``NIAHBenchmarkSuite``: it can either
   ingest an existing JSONL log (``aggregate``) or orchestrate the TS driver
   via ``run_drift_eval`` (``subprocess`` invocation of ``bun``).

Scoring is reproducible: every probe outcome is in the JSONL, so this module
never re-runs the model — it only counts.
"""

from __future__ import annotations

import json
import subprocess
import sys
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

# Strategies the TS harness understands. Kept in lock-step with KNOWN_STRATEGIES
# in scripts/benchmark/drift-harness.ts.
KNOWN_STRATEGIES: tuple[str, ...] = (
    "none",
    "prompt-stripping",
    "naive-summary",
    "structured-state",
    "hierarchical-summary",
    "hybrid-ledger",
)


# ---------------------------------------------------------------------------
# Event types (typed mirrors of the JSONL lines)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DriftTurnEvent:
    """One conversational turn (user or assistant)."""

    turn: int
    role: str  # "user" | "assistant"
    content_len: int
    tokens: int
    fact_id: str | None = None


@dataclass(frozen=True)
class DriftCompactEvent:
    """One compaction trigger."""

    at_turn: int
    strategy: str
    original_tokens: int
    compacted_tokens: int
    latency_ms: float
    unavailable: bool = False
    unavailable_reason: str | None = None


@dataclass(frozen=True)
class DriftProbeEvent:
    """One retrieval probe outcome."""

    at_turn: int
    fact_id: str
    planted_turn: int
    kind: str | None
    expected: str
    actual: str
    correct: bool
    judge_reasoning: str
    phase: str  # "post-compact" | "final"


@dataclass(frozen=True)
class DriftSummaryEvent:
    """The final summary line emitted by the TS harness."""

    strategy: str
    overall_accuracy: float
    total_compactions: int
    total_tokens_saved: int
    total_probes: int
    total_correct: int
    seed: int
    turns: int
    compact_every: int
    plant_facts: int
    valid: bool = True
    skipped: bool = False
    skip_reason: str | None = None


# ---------------------------------------------------------------------------
# Aggregate result
# ---------------------------------------------------------------------------


@dataclass
class DriftRunSummary:
    """Per-run aggregate metrics for a single strategy."""

    strategy: str
    overall_accuracy: float
    final_phase_accuracy: float
    post_compact_accuracy: float
    total_probes: int
    total_correct: int
    total_compactions: int
    total_tokens_saved: int
    drift_per_compaction: float
    fact_survival: dict[str, float] = field(default_factory=dict)
    skipped: bool = False
    skip_reason: str | None = None


@dataclass
class DriftResult:
    """Aggregate result across one or more strategy runs."""

    runs: list[DriftRunSummary]
    raw_event_counts: dict[str, int] = field(default_factory=dict)

    def by_strategy(self) -> dict[str, DriftRunSummary]:
        """Index runs by strategy name."""
        return {r.strategy: r for r in self.runs}


# ---------------------------------------------------------------------------
# JSONL parsing
# ---------------------------------------------------------------------------


def _parse_event(
    obj: dict[str, object],
) -> (
    DriftTurnEvent
    | DriftCompactEvent
    | DriftProbeEvent
    | DriftSummaryEvent
    | None
):
    """Map a single JSON object onto a typed event. Unknown events return None."""
    kind = obj.get("event")
    if kind == "turn":
        return DriftTurnEvent(
            turn=int(obj["turn"]),  # type: ignore[arg-type]
            role=str(obj["role"]),
            content_len=int(obj["contentLen"]),  # type: ignore[arg-type]
            tokens=int(obj["tokens"]),  # type: ignore[arg-type]
            fact_id=(str(obj["factId"]) if obj.get("factId") is not None else None),
        )
    if kind == "compact":
        return DriftCompactEvent(
            at_turn=int(obj["atTurn"]),  # type: ignore[arg-type]
            strategy=str(obj["strategy"]),
            original_tokens=int(obj["originalTokens"]),  # type: ignore[arg-type]
            compacted_tokens=int(obj["compactedTokens"]),  # type: ignore[arg-type]
            latency_ms=float(obj["latencyMs"]),  # type: ignore[arg-type]
            unavailable=obj.get("unavailable") is True,
            unavailable_reason=(
                str(obj["unavailableReason"])
                if obj.get("unavailableReason") is not None
                else None
            ),
        )
    if kind == "probe":
        return DriftProbeEvent(
            at_turn=int(obj["atTurn"]),  # type: ignore[arg-type]
            fact_id=str(obj["factId"]),
            planted_turn=int(obj["plantedTurn"]),  # type: ignore[arg-type]
            kind=(str(obj["kind"]) if obj.get("kind") is not None else None),
            expected=str(obj["expected"]),
            actual=str(obj["actual"]),
            correct=obj.get("correct") is True,
            judge_reasoning=str(obj["judgeReasoning"]),
            phase=str(obj["phase"]),
        )
    if kind == "summary":
        return DriftSummaryEvent(
            strategy=str(obj["strategy"]),
            overall_accuracy=float(obj["overallAccuracy"]),  # type: ignore[arg-type]
            total_compactions=int(obj["totalCompactions"]),  # type: ignore[arg-type]
            total_tokens_saved=int(obj["totalTokensSaved"]),  # type: ignore[arg-type]
            total_probes=int(obj["totalProbes"]),  # type: ignore[arg-type]
            total_correct=int(obj["totalCorrect"]),  # type: ignore[arg-type]
            seed=int(obj["seed"]),  # type: ignore[arg-type]
            turns=int(obj["turns"]),  # type: ignore[arg-type]
            compact_every=int(obj["compactEvery"]),  # type: ignore[arg-type]
            plant_facts=int(obj["plantFacts"]),  # type: ignore[arg-type]
            valid=obj.get("valid", True) is True,
            skipped=obj.get("skipped", False) is True,
            skip_reason=(
                str(obj["skipReason"]) if obj.get("skipReason") is not None else None
            ),
        )
    return None


def parse_jsonl(
    path: str | Path,
) -> tuple[
    list[DriftTurnEvent],
    list[DriftCompactEvent],
    list[DriftProbeEvent],
    DriftSummaryEvent | None,
]:
    """Parse a drift-harness JSONL file into typed events."""
    p = Path(path)
    turns: list[DriftTurnEvent] = []
    compacts: list[DriftCompactEvent] = []
    probes: list[DriftProbeEvent] = []
    summary: DriftSummaryEvent | None = None

    with p.open("r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            obj = json.loads(line)
            if not isinstance(obj, dict):
                raise ValueError(f"unexpected non-object JSONL line: {line[:80]}")
            event = _parse_event(obj)
            if isinstance(event, DriftTurnEvent):
                turns.append(event)
            elif isinstance(event, DriftCompactEvent):
                compacts.append(event)
            elif isinstance(event, DriftProbeEvent):
                probes.append(event)
            elif isinstance(event, DriftSummaryEvent):
                summary = event
    return turns, compacts, probes, summary


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def aggregate_run(
    probes: Sequence[DriftProbeEvent],
    compacts: Sequence[DriftCompactEvent],
    summary: DriftSummaryEvent | None,
) -> DriftRunSummary:
    """Compute a single-run aggregate from typed events.

    Inputs come from one strategy's JSONL. The returned summary uses the
    ``DriftSummaryEvent`` line as the source of truth for ``total_probes``,
    ``total_correct``, ``total_compactions``, and ``total_tokens_saved`` — but
    re-derives ``post_compact_accuracy``, ``final_phase_accuracy``, and
    per-fact survival from the probe events so the result is reproducible
    even if the summary line is missing or inconsistent.
    """
    if summary is None:
        # Fall back to deriving everything from probes/compacts when the run
        # was truncated. We don't fabricate a strategy name.
        strategy = compacts[0].strategy if compacts else "unknown"
        total_probes = len(probes)
        total_correct = sum(1 for p in probes if p.correct)
        successful_compactions = sum(1 for c in compacts if not c.unavailable)
        tokens_saved = sum(
            c.original_tokens - c.compacted_tokens for c in compacts if not c.unavailable
        )
        skipped = bool(compacts) and all(c.unavailable for c in compacts)
        skip_reason = (
            compacts[0].unavailable_reason if skipped and compacts else None
        )
    else:
        strategy = summary.strategy
        computed_total_probes = len(probes)
        computed_total_correct = sum(1 for p in probes if p.correct)
        if summary.total_probes != computed_total_probes:
            raise ValueError(
                "drift summary total_probes does not match probe events: "
                f"{summary.total_probes} != {computed_total_probes}"
            )
        if summary.total_correct != computed_total_correct:
            raise ValueError(
                "drift summary total_correct does not match probe events: "
                f"{summary.total_correct} != {computed_total_correct}"
            )
        total_probes = summary.total_probes
        total_correct = summary.total_correct
        successful_compactions = summary.total_compactions
        tokens_saved = summary.total_tokens_saved
        skipped = summary.skipped or (
            bool(compacts) and all(c.unavailable for c in compacts)
        )
        skip_reason = summary.skip_reason or (
            compacts[0].unavailable_reason if skipped and compacts else None
        )

    overall_accuracy = (total_correct / total_probes) if total_probes > 0 else 0.0

    final_probes = [p for p in probes if p.phase == "final"]
    post_probes = [p for p in probes if p.phase == "post-compact"]
    final_phase_accuracy = (
        sum(1 for p in final_probes if p.correct) / len(final_probes)
        if final_probes
        else 0.0
    )
    post_compact_accuracy = (
        sum(1 for p in post_probes if p.correct) / len(post_probes)
        if post_probes
        else 0.0
    )

    # Per-fact survival: did the fact land correct at every probe? Useful for
    # finding facts that survive the first compaction but drift later.
    by_fact: dict[str, list[bool]] = defaultdict(list)
    for p in probes:
        by_fact[p.fact_id].append(p.correct)
    fact_survival: dict[str, float] = {
        fid: (sum(1 for c in outcomes if c) / len(outcomes))
        for fid, outcomes in by_fact.items()
    }

    # Drift per compaction = how much accuracy we lose, on average, per
    # compaction event. Pre-compaction probes don't exist so we use the
    # delta between the post-compact accuracy stream and 1.0 (perfect recall).
    drift_per_compaction = (
        (1.0 - post_compact_accuracy) / successful_compactions
        if successful_compactions > 0
        else 0.0
    )

    return DriftRunSummary(
        strategy=strategy,
        overall_accuracy=overall_accuracy,
        final_phase_accuracy=final_phase_accuracy,
        post_compact_accuracy=post_compact_accuracy,
        total_probes=total_probes,
        total_correct=total_correct,
        total_compactions=successful_compactions,
        total_tokens_saved=tokens_saved,
        drift_per_compaction=drift_per_compaction,
        fact_survival=fact_survival,
        skipped=skipped,
        skip_reason=skip_reason,
    )


# ---------------------------------------------------------------------------
# Suite
# ---------------------------------------------------------------------------


class DriftBenchmarkSuite:
    """Drift benchmark — mirrors ``NIAHBenchmarkSuite`` for the orchestrator.

    Two ways to use this:

    1. ``aggregate(jsonl_path)`` — read an existing log and compute metrics.
       Reproducible from disk; no model calls.
    2. ``run_drift_eval(strategies, ...)`` — orchestrate by shelling out to
       ``bun run scripts/benchmark/drift-harness.ts`` once per strategy.
       Each run produces its own JSONL; the suite aggregates across them.
    """

    def __init__(
        self,
        bun_bin: str = "bun",
        harness_script: str | Path | None = None,
        repo_root: str | Path | None = None,
    ) -> None:
        self.bun_bin = bun_bin
        # Default points to the in-tree harness. Callers can override for tests
        # that want to point at a fake script.
        if repo_root is None:
            self.repo_root = self._find_repo_root()
        else:
            self.repo_root = Path(repo_root)
        if harness_script is None:
            self.harness_script = (
                self.repo_root / "scripts" / "benchmark" / "drift-harness.ts"
            )
        else:
            self.harness_script = Path(harness_script)

    @staticmethod
    def _find_repo_root() -> Path:
        # Walk upward from this file until we hit a dir containing both
        # `packages/` and `scripts/`. Fall back to cwd if nothing matches.
        here = Path(__file__).resolve()
        for parent in [here, *here.parents]:
            if (parent / "packages").is_dir() and (parent / "scripts").is_dir():
                return parent
        return Path.cwd()

    def aggregate(self, jsonl_path: str | Path) -> DriftRunSummary:
        """Compute a single-run aggregate from a JSONL log."""
        _, compacts, probes, summary = parse_jsonl(jsonl_path)
        return aggregate_run(probes, compacts, summary)

    def run_drift_eval(
        self,
        strategies: Iterable[str],
        turns: int = 50,
        compact_every: int = 10,
        plant_facts: int = 5,
        seed: int = 1337,
        output_dir: str | Path = "./benchmark_results/drift",
        dry_run: bool = False,
        extra_env: dict[str, str] | None = None,
    ) -> DriftResult:
        """Run the TS harness once per strategy and return a typed result.

        One JSONL is written per strategy under ``output_dir``. Reproducible:
        re-running with the same seed and same model produces the same probes.
        """
        out_root = Path(output_dir)
        out_root.mkdir(parents=True, exist_ok=True)
        runs: list[DriftRunSummary] = []
        raw_counts: dict[str, int] = defaultdict(int)
        import os

        for strategy in strategies:
            if strategy not in KNOWN_STRATEGIES:
                raise ValueError(
                    f"unknown strategy {strategy!r}; expected one of "
                    f"{', '.join(KNOWN_STRATEGIES)}"
                )
            jsonl_path = out_root / f"drift-{strategy}-{seed}.jsonl"
            cmd = [
                self.bun_bin,
                "run",
                str(self.harness_script),
                "--strategy",
                strategy,
                "--turns",
                str(turns),
                "--compact-every",
                str(compact_every),
                "--plant-facts",
                str(plant_facts),
                "--seed",
                str(seed),
                "--output",
                str(jsonl_path),
            ]
            if dry_run:
                cmd.append("--dry-run")
            env = {**os.environ, **(extra_env or {})}
            proc = subprocess.run(  # noqa: S603 - bun is trusted here
                cmd,
                cwd=str(self.repo_root),
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
            if proc.returncode != 0:
                # Surface the harness's stderr verbatim — we don't second-guess it.
                raise RuntimeError(
                    f"drift-harness failed for strategy={strategy} "
                    f"(exit {proc.returncode}): {proc.stderr.strip()[:400]}"
                )
            turn_evs, compacts, probes, summary = parse_jsonl(jsonl_path)
            run = aggregate_run(probes, compacts, summary)
            runs.append(run)
            raw_counts["turn"] += len(turn_evs)
            raw_counts["compact"] += len(compacts)
            raw_counts["probe"] += len(probes)
            if summary is not None:
                raw_counts["summary"] += 1

        return DriftResult(runs=runs, raw_event_counts=dict(raw_counts))


__all__ = [
    "KNOWN_STRATEGIES",
    "DriftBenchmarkSuite",
    "DriftCompactEvent",
    "DriftProbeEvent",
    "DriftResult",
    "DriftRunSummary",
    "DriftSummaryEvent",
    "DriftTurnEvent",
    "aggregate_run",
    "parse_jsonl",
]


def _cli() -> int:
    """Tiny CLI: ``python -m elizaos_context_bench.drift <jsonl>`` prints aggregates."""
    if len(sys.argv) < 2:
        print("usage: python -m elizaos_context_bench.drift <jsonl-path>")
        return 2
    suite = DriftBenchmarkSuite()
    summary = suite.aggregate(sys.argv[1])
    print(json.dumps(summary.__dict__, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
