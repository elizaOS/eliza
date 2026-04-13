"""
Evaluator Ablation Benchmark

Compares agent performance on multi-step shell tasks with and without the
PostActionEvaluator.  The evaluator enables recursive action chaining so the
agent can execute multiple sequential steps in a single message-handling cycle,
rather than waiting for a new iteration each time.

Usage:
    python evaluator_ablation.py [--model MODEL] [--verbose]

Requires:
    - Docker running (for the sandbox environment)
    - An LLM API key (OPENAI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY)
    - elizaos + elizaos_terminal_bench installed
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

# terminal-bench lives alongside this script
sys.path.insert(0, str(Path(__file__).resolve().parent))

from elizaos_terminal_bench.eliza_agent import ElizaTerminalAgent
from elizaos_terminal_bench.environment import TerminalEnvironment
from elizaos_terminal_bench.types import (
    TaskCategory,
    TaskDifficulty,
    TerminalBenchResult,
    TerminalTask,
)

logger = logging.getLogger(__name__)

# ── Multi-step tasks designed to showcase chaining ──────────────────────

ABLATION_TASKS: list[TerminalTask] = [
    # Task 1: Create a Python package, write tests, run them
    TerminalTask(
        task_id="ablation_pkg",
        instruction=(
            "Create a Python package in /workspace/mypkg with the following structure:\n"
            "  mypkg/__init__.py  (contains: __version__ = '1.0.0')\n"
            "  mypkg/math_utils.py (contains a function 'add(a, b)' that returns a+b)\n"
            "  tests/test_math.py (uses unittest to test add(2,3)==5 and add(-1,1)==0)\n"
            "Then run the tests with 'python -m pytest tests/' or 'python -m unittest discover tests'."
        ),
        category=TaskCategory.SCRIPTING,
        difficulty=TaskDifficulty.MEDIUM,
        test_script="""#!/bin/bash
set -e
# Verify files exist
[ -f /workspace/mypkg/__init__.py ] || { echo "missing __init__.py"; exit 1; }
[ -f /workspace/mypkg/math_utils.py ] || { echo "missing math_utils.py"; exit 1; }
[ -f /workspace/tests/test_math.py ] || { echo "missing test_math.py"; exit 1; }

# Verify __version__
python3 -c "import sys; sys.path.insert(0,'/workspace'); from mypkg import __version__; assert __version__=='1.0.0'" \
    || { echo "bad __version__"; exit 1; }

# Verify add function
python3 -c "import sys; sys.path.insert(0,'/workspace'); from mypkg.math_utils import add; assert add(2,3)==5; assert add(-1,1)==0" \
    || { echo "add() broken"; exit 1; }

echo "OK"
exit 0
""",
        reference_solution=(
            "mkdir -p /workspace/mypkg /workspace/tests\n"
            "echo '__version__ = \"1.0.0\"' > /workspace/mypkg/__init__.py\n"
            "cat > /workspace/mypkg/math_utils.py <<'EOF'\ndef add(a, b):\n    return a + b\nEOF\n"
            "cat > /workspace/tests/test_math.py <<'EOF'\nimport unittest\nimport sys\n"
            "sys.path.insert(0, '/workspace')\nfrom mypkg.math_utils import add\n\n"
            "class TestAdd(unittest.TestCase):\n    def test_basic(self):\n        self.assertEqual(add(2, 3), 5)\n"
            "    def test_negative(self):\n        self.assertEqual(add(-1, 1), 0)\n\n"
            "if __name__ == '__main__':\n    unittest.main()\nEOF\n"
            "cd /workspace && python -m unittest discover tests/"
        ),
        timeout_seconds=120,
        docker_image="python:3.11-slim",
    ),

    # Task 2: Git repo setup with multiple commits
    TerminalTask(
        task_id="ablation_git",
        instruction=(
            "In /workspace, initialize a git repository. Then:\n"
            "1. Create a file README.md with content '# My Project'\n"
            "2. Add and commit it with message 'Initial commit'\n"
            "3. Create a branch called 'feature'\n"
            "4. On the feature branch, create src/app.py with content 'print(\"hello\")'\n"
            "5. Add and commit with message 'Add app'"
        ),
        category=TaskCategory.GIT_OPERATIONS,
        difficulty=TaskDifficulty.MEDIUM,
        test_script="""#!/bin/bash
set -e
cd /workspace

# Must be a git repo
git rev-parse --git-dir > /dev/null 2>&1 || { echo "not a git repo"; exit 1; }

# Must have at least 2 commits
COMMIT_COUNT=$(git log --oneline | wc -l)
[ "$COMMIT_COUNT" -ge 2 ] || { echo "need >= 2 commits, got $COMMIT_COUNT"; exit 1; }

# feature branch must exist
git rev-parse --verify feature > /dev/null 2>&1 || { echo "no feature branch"; exit 1; }

# README.md must exist on main/master
git stash -q 2>/dev/null || true
MAIN=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || git branch --list main master | head -1 | tr -d ' *')
[ -z "$MAIN" ] && MAIN=$(git branch | head -1 | tr -d ' *')
git checkout -q "$MAIN" 2>/dev/null || true
[ -f README.md ] || { echo "no README.md"; exit 1; }

# src/app.py must exist on feature
git checkout -q feature
[ -f src/app.py ] || { echo "no src/app.py on feature"; exit 1; }

echo "OK"
exit 0
""",
        reference_solution=(
            "cd /workspace && git init && git config user.email 'test@test.com' && "
            "git config user.name 'Test'\n"
            "echo '# My Project' > README.md && git add . && git commit -m 'Initial commit'\n"
            "git checkout -b feature\n"
            "mkdir -p src && echo 'print(\"hello\")' > src/app.py && "
            "git add . && git commit -m 'Add app'"
        ),
        timeout_seconds=120,
        docker_image="python:3.11-slim",
    ),

    # Task 3: Write a Makefile + source, then build
    TerminalTask(
        task_id="ablation_make",
        instruction=(
            "Create a C project in /workspace with:\n"
            "1. A file src/main.c that prints 'BUILD OK' to stdout\n"
            "2. A Makefile that compiles src/main.c to bin/app\n"
            "3. Run 'make' to build it\n"
            "4. Run bin/app to verify it works"
        ),
        category=TaskCategory.CODE_COMPILATION,
        difficulty=TaskDifficulty.MEDIUM,
        test_script="""#!/bin/bash
set -e
[ -f /workspace/src/main.c ] || { echo "no src/main.c"; exit 1; }
[ -f /workspace/Makefile ] || { echo "no Makefile"; exit 1; }
[ -f /workspace/bin/app ] || { echo "no bin/app"; exit 1; }
OUTPUT=$(/workspace/bin/app 2>&1)
echo "$OUTPUT" | grep -q "BUILD OK" || { echo "wrong output: $OUTPUT"; exit 1; }
echo "OK"
exit 0
""",
        reference_solution=(
            "mkdir -p /workspace/src /workspace/bin\n"
            "cat > /workspace/src/main.c <<'EOF'\n#include <stdio.h>\n"
            "int main() { printf(\"BUILD OK\\n\"); return 0; }\nEOF\n"
            "cat > /workspace/Makefile <<'EOF'\nbin/app: src/main.c\n"
            "\tmkdir -p bin\n\tgcc -o bin/app src/main.c\nEOF\n"
            "cd /workspace && make"
        ),
        timeout_seconds=120,
        docker_image="gcc:latest",
    ),

    # Task 4: Multi-step data pipeline
    TerminalTask(
        task_id="ablation_pipeline",
        instruction=(
            "Create a data processing pipeline in /workspace:\n"
            "1. Create data/input.csv with this content:\n"
            "   name,score\\nAlice,85\\nBob,92\\nCharlie,78\n"
            "2. Write a Python script process.py that reads data/input.csv,\n"
            "   filters rows where score >= 80, and writes results to data/output.csv\n"
            "3. Run process.py\n"
            "4. Verify data/output.csv exists and has the correct rows"
        ),
        category=TaskCategory.SCRIPTING,
        difficulty=TaskDifficulty.MEDIUM,
        test_script="""#!/bin/bash
set -e
[ -f /workspace/data/input.csv ] || { echo "no input.csv"; exit 1; }
[ -f /workspace/process.py ] || { echo "no process.py"; exit 1; }
[ -f /workspace/data/output.csv ] || { echo "no output.csv"; exit 1; }

# Check output has Alice(85) and Bob(92) but not Charlie(78)
python3 -c "
import csv
with open('/workspace/data/output.csv') as f:
    reader = csv.DictReader(f)
    rows = list(reader)
    names = [r['name'] for r in rows]
    assert 'Alice' in names, f'Missing Alice: {names}'
    assert 'Bob' in names, f'Missing Bob: {names}'
    assert 'Charlie' not in names, f'Charlie should be filtered: {names}'
    assert len(rows) == 2, f'Expected 2 rows, got {len(rows)}'
print('OK')
" || { echo "output.csv content wrong"; exit 1; }

exit 0
""",
        reference_solution=(
            "mkdir -p /workspace/data\n"
            "printf 'name,score\\nAlice,85\\nBob,92\\nCharlie,78\\n' > /workspace/data/input.csv\n"
            "cat > /workspace/process.py <<'EOF'\nimport csv\n"
            "with open('data/input.csv') as f:\n    reader = csv.DictReader(f)\n"
            "    rows = [r for r in reader if int(r['score']) >= 80]\n"
            "with open('data/output.csv', 'w', newline='') as f:\n"
            "    w = csv.DictWriter(f, fieldnames=['name','score'])\n"
            "    w.writeheader()\n    w.writerows(rows)\nEOF\n"
            "cd /workspace && python3 process.py"
        ),
        timeout_seconds=120,
        docker_image="python:3.11-slim",
    ),
]


# ── Result types ────────────────────────────────────────────────────────

@dataclass
class AblationResult:
    task_id: str
    baseline_success: bool
    baseline_iterations: int
    baseline_time_s: float
    evaluator_success: bool
    evaluator_iterations: int
    evaluator_time_s: float


@dataclass
class AblationReport:
    results: list[AblationResult] = field(default_factory=list)
    model: str = ""

    @property
    def baseline_pass_rate(self) -> float:
        if not self.results:
            return 0.0
        return sum(1 for r in self.results if r.baseline_success) / len(self.results)

    @property
    def evaluator_pass_rate(self) -> float:
        if not self.results:
            return 0.0
        return sum(1 for r in self.results if r.evaluator_success) / len(self.results)


# ── Runner ──────────────────────────────────────────────────────────────

async def run_single(
    task: TerminalTask,
    model: str,
    use_evaluator: bool,
    max_iterations: int,
    verbose: bool,
) -> tuple[TerminalBenchResult, float]:
    """Run a single task and return (result, elapsed_seconds)."""
    env = TerminalEnvironment(image=task.docker_image)
    await env.start(task)

    if task.setup_script:
        await env.execute(task.setup_script)

    agent = ElizaTerminalAgent(
        environment=env,
        max_iterations=max_iterations,
        model_name=model,
        verbose=verbose,
        use_post_action_evaluator=use_evaluator,
    )

    t0 = time.monotonic()
    try:
        result = await agent.solve_task(task)
    finally:
        elapsed = time.monotonic() - t0
        await agent.cleanup()
        await env.stop()

    return result, elapsed


async def run_ablation(
    model: str,
    max_iterations: int = 15,
    verbose: bool = False,
    task_ids: list[str] | None = None,
) -> AblationReport:
    """Run all ablation tasks and produce a comparison report."""
    tasks = ABLATION_TASKS
    if task_ids:
        tasks = [t for t in tasks if t.task_id in task_ids]

    report = AblationReport(model=model)

    for task in tasks:
        print(f"\n{'='*60}")
        print(f"Task: {task.task_id} ({task.category.value} / {task.difficulty.value})")
        print(f"{'='*60}")

        # ── Baseline (no evaluator) ──
        print(f"\n  ▸ Running WITHOUT evaluator...")
        try:
            baseline_result, baseline_time = await run_single(
                task, model, use_evaluator=False,
                max_iterations=max_iterations, verbose=verbose,
            )
            baseline_success = baseline_result.success
            baseline_iters = baseline_result.commands_executed
        except Exception as e:
            logger.error(f"Baseline run failed for {task.task_id}: {e}")
            baseline_success = False
            baseline_iters = max_iterations
            baseline_time = 0.0

        status = "✅ PASS" if baseline_success else "❌ FAIL"
        print(f"    {status} | {baseline_iters} commands | {baseline_time:.1f}s")

        # ── With evaluator ──
        print(f"\n  ▸ Running WITH evaluator...")
        try:
            eval_result, eval_time = await run_single(
                task, model, use_evaluator=True,
                max_iterations=max_iterations, verbose=verbose,
            )
            eval_success = eval_result.success
            eval_iters = eval_result.commands_executed
        except Exception as e:
            logger.error(f"Evaluator run failed for {task.task_id}: {e}")
            eval_success = False
            eval_iters = max_iterations
            eval_time = 0.0

        status = "✅ PASS" if eval_success else "❌ FAIL"
        print(f"    {status} | {eval_iters} commands | {eval_time:.1f}s")

        report.results.append(AblationResult(
            task_id=task.task_id,
            baseline_success=baseline_success,
            baseline_iterations=baseline_iters,
            baseline_time_s=baseline_time,
            evaluator_success=eval_success,
            evaluator_iterations=eval_iters,
            evaluator_time_s=eval_time,
        ))

    return report


def print_report(report: AblationReport) -> None:
    """Print a formatted comparison table."""
    print(f"\n{'='*72}")
    print(f"  EVALUATOR ABLATION RESULTS  (model: {report.model})")
    print(f"{'='*72}")
    print(f"{'Task':<20} {'Baseline':>12} {'+ Evaluator':>12} {'Δ Cmds':>10}")
    print(f"{'':<20} {'pass/cmds':>12} {'pass/cmds':>12} {'':>10}")
    print(f"{'-'*72}")

    for r in report.results:
        b_status = "✅" if r.baseline_success else "❌"
        e_status = "✅" if r.evaluator_success else "❌"
        delta = r.evaluator_iterations - r.baseline_iterations
        delta_str = f"{delta:+d}" if delta != 0 else "="

        print(
            f"{r.task_id:<20} "
            f"{b_status} {r.baseline_iterations:>3} cmds  "
            f"{e_status} {r.evaluator_iterations:>3} cmds  "
            f"{delta_str:>6}"
        )

    print(f"{'-'*72}")
    print(
        f"{'Pass Rate':<20} "
        f"{report.baseline_pass_rate:>11.0%}  "
        f"{report.evaluator_pass_rate:>11.0%}"
    )
    print(f"{'='*72}")

    # Save as JSON
    output_dir = Path(__file__).parent / "benchmark_results"
    output_dir.mkdir(exist_ok=True)
    output_file = output_dir / "evaluator_ablation.json"

    json_results = {
        "model": report.model,
        "baseline_pass_rate": report.baseline_pass_rate,
        "evaluator_pass_rate": report.evaluator_pass_rate,
        "tasks": [
            {
                "task_id": r.task_id,
                "baseline": {"success": r.baseline_success, "commands": r.baseline_iterations, "time_s": r.baseline_time_s},
                "evaluator": {"success": r.evaluator_success, "commands": r.evaluator_iterations, "time_s": r.evaluator_time_s},
            }
            for r in report.results
        ],
    }
    output_file.write_text(json.dumps(json_results, indent=2))
    print(f"\nResults saved to {output_file}")


# ── CLI ─────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compare agent task completion with/without PostActionEvaluator"
    )
    parser.add_argument(
        "--model", default="gpt-4o-mini",
        help="LLM model name (default: gpt-4o-mini)",
    )
    parser.add_argument(
        "--max-iterations", type=int, default=15,
        help="Max iterations per run (default: 15)",
    )
    parser.add_argument(
        "--tasks", nargs="*", default=None,
        help="Specific task IDs to run (default: all)",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    report = asyncio.run(
        run_ablation(
            model=args.model,
            max_iterations=args.max_iterations,
            verbose=args.verbose,
            task_ids=args.tasks,
        )
    )
    print_report(report)


if __name__ == "__main__":
    main()
