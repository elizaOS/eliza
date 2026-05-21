#!/usr/bin/env python3
"""Fail closed when SBY engines disagree on a formal proof.

SymbiYosys reports a task as ``DONE (PASS)`` as soon as *any* configured
engine returns ``pass`` — even if a second engine errored, timed out, or was
terminated without a conclusive result. Dossier item §5.6.1 records that the
``e1_npu`` and ``e1_dma`` proofs hit exactly this: z3 logs "did not return a
status" while bitwuzla passes, and the disagreement is silently accepted.

This gate re-reads the per-task SBY ``logfile.txt`` and requires that, for any
task whose overall result is PASS, *every* configured engine also returned
``pass``. An engine that errored, timed out, or was terminated mid-solve is
treated as a disagreement and fails the gate. A genuine multi-engine PASS (all
engines agree) is accepted.

Usage::

    python3 verify/check_formal_engine_agreement.py <sby-logfile-or-workdir> ...

Each argument is either an SBY ``logfile.txt`` or a workdir containing one.
With no arguments the canonical evidence logs under ``verify/formal/*/`` are
checked. Exit code 0 = all engines agree; 1 = disagreement; 2 = bad input.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# "SBY 6:21:27 [task] summary: engine_0 (smtbmc z3) returned pass"
_ENGINE_DECL = re.compile(r"summary: (engine_\d+) \(([^)]*)\) (.+)$")
# "SBY 6:21:27 [task] DONE (PASS, rc=0)"
_DONE = re.compile(r"DONE \((PASS|FAIL|ERROR|UNKNOWN|TIMEOUT)[,)]")

_PASS_VERDICTS = ("returned pass", "returned pass for basecase",
                  "returned pass for induction")


@dataclass
class EngineVerdict:
    engine: str
    solver: str
    verdict: str

    @property
    def passed(self) -> bool:
        return any(self.verdict.startswith(v) for v in _PASS_VERDICTS)

    @property
    def failed(self) -> bool:
        return "returned FAIL" in self.verdict or self.verdict.startswith("returned fail")


@dataclass
class TaskResult:
    name: str
    overall: str | None = None
    engines: list[EngineVerdict] = field(default_factory=list)


def _resolve_logfile(arg: str) -> Path:
    path = Path(arg)
    if not path.is_absolute():
        path = (ROOT / path).resolve()
    if path.is_dir():
        path = path / "logfile.txt"
    return path


def parse_logfile(path: Path) -> TaskResult:
    result = TaskResult(name=path.parent.name)
    # Collapse repeated engine lines (basecase + induction emit two), keeping
    # the strongest signal: any non-pass verdict for an engine sticks.
    seen: dict[str, EngineVerdict] = {}
    for line in path.read_text(errors="ignore").splitlines():
        decl = _ENGINE_DECL.search(line)
        if decl:
            engine, solver, verdict = decl.group(1), decl.group(2), decl.group(3).strip()
            prior = seen.get(engine)
            ev = EngineVerdict(engine, solver, verdict)
            if prior is None or (prior.passed and not ev.passed):
                seen[engine] = ev
            continue
        done = _DONE.search(line)
        if done:
            result.overall = done.group(1)
    result.engines = [seen[k] for k in sorted(seen)]
    return result


def evaluate(result: TaskResult) -> list[str]:
    """Return a list of disagreement messages (empty == agreement)."""
    problems: list[str] = []
    if result.overall != "PASS":
        # Non-PASS overall results are surfaced by SBY's own exit code; this
        # gate only polices silent disagreement under an overall PASS.
        return problems
    if not result.engines:
        return [f"{result.name}: overall PASS but no engine verdicts parsed"]
    for ev in result.engines:
        if not ev.passed:
            problems.append(
                f"{result.name}: overall PASS but {ev.engine} "
                f"({ev.solver}) did not pass — verdict: \"{ev.verdict}\""
            )
    return problems


def default_targets() -> list[Path]:
    base = ROOT / "verify/formal"
    return sorted(p / "logfile.txt" for p in base.iterdir()
                  if p.is_dir() and (p / "logfile.txt").is_file())


def main(argv: list[str]) -> int:
    targets = [_resolve_logfile(a) for a in argv] if argv else default_targets()

    if not targets:
        print("STATUS: BLOCKED no SBY logfiles found", file=sys.stderr)
        return 2

    all_problems: list[str] = []
    checked = 0
    for path in targets:
        if not path.is_file():
            print(f"STATUS: BLOCKED missing SBY logfile {path}", file=sys.stderr)
            return 2
        result = parse_logfile(path)
        checked += 1
        problems = evaluate(result)
        if problems:
            all_problems.extend(problems)
        else:
            engines = ", ".join(f"{e.engine}={e.solver}" for e in result.engines)
            verdict = result.overall or "no-overall"
            print(f"OK {result.name}: {verdict} with engine agreement [{engines}]")

    if all_problems:
        for msg in all_problems:
            print(f"STATUS: FAIL engine disagreement — {msg}")
        return 1

    print(f"STATUS: PASS {checked} formal task(s); all engines agree")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
