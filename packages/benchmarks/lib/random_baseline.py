"""Random-baseline agent for the tri-agent benchmarking harness.

For each registered benchmark, produces a "stupid agent" that picks
uniformly at random from the valid action/choice space defined by the
task. Used to verify that real agents perform measurably better than chance.

The baseline is stored in orchestrator.sqlite with agent_id="random_v1"
and treated like any other agent in the compare report. A real agent
that scores within statistical noise of random_v1 is flagged as FAIL.

Design notes
------------

- Stdlib only. No numpy, no pydantic.
- RNG is seedable per call (``random.Random(seed)``); the module-level
  ``random`` global is never used.
- ``TaskShape`` is a Protocol but every reader uses ``_get(shape, attr)``
  to duck-type both dataclasses/objects (``getattr``) and plain dicts
  (``dict.get``). This means the runner does not need to wrap raw JSON.
- ``BENCHMARK_STRATEGIES`` is the registry of known benchmark ids and
  the response shape each one expects. Unknown ids fall through to
  ``freeform`` with ``is_meaningful=False`` so the compare report can
  flag them as uninterpretable rather than silently treating noise as
  a valid baseline.
- ``lift_over_random`` and ``is_better_than_random`` are pure math
  helpers — no scoring logic lives here.
"""

from __future__ import annotations

import argparse
import json
import random
import string
import sys
from dataclasses import dataclass
from typing import Any, Protocol


__all__ = [
    "BaselineStrategy",
    "TaskShape",
    "BENCHMARK_STRATEGIES",
    "get_strategy",
    "pick_random_choice",
    "pick_random_function_call",
    "empty_patch",
    "random_trajectory",
    "random_freeform_string",
    "lift_over_random",
    "is_better_than_random",
    "generate_random_response",
    "cli",
]


# -------- BaselineStrategy registry --------


@dataclass(frozen=True)
class BaselineStrategy:
    """How to produce a random response for one task shape.

    Attributes:
        name: One of ``"multiple_choice"``, ``"function_call"``,
            ``"empty_patch"``, ``"trajectory"``, ``"freeform"``. Picked
            by ``generate_random_response`` to dispatch to the right
            generator.
        description: Human-readable summary shown in ``cli list``.
        is_meaningful: ``False`` when a random baseline is uninterpretable
            for this benchmark (e.g. free-form code or wallet addresses).
            The compare report uses this to decide whether to gate real
            agents against the baseline or just record it for reference.
    """

    name: str
    description: str
    is_meaningful: bool


class TaskShape(Protocol):
    """Structural protocol for the inputs the strategies read.

    Strategies branch on ``kind`` and then read the relevant sibling
    field. We never enforce this at runtime; both dataclasses/objects
    and plain dicts are accepted via ``_get`` below.
    """

    kind: str
    choices: list[str] | None
    allowed_functions: list[dict[str, Any]] | None
    max_steps: int | None


def _get(shape: Any, attr: str, default: Any = None) -> Any:
    """Read ``attr`` from ``shape`` whether it's an object or a dict.

    Tries ``getattr`` first (dataclasses, namedtuples, plain classes),
    then ``dict.get`` (raw JSON parsed via ``json.loads``). Returns
    ``default`` if neither has the attribute.
    """
    if hasattr(shape, attr):
        return getattr(shape, attr)
    if isinstance(shape, dict):
        return shape.get(attr, default)
    return default


# -------- Strategy implementations --------


def pick_random_choice(shape: Any, rng: random.Random) -> str:
    """Pick one element uniformly from ``shape.choices``.

    Raises:
        ValueError: when ``choices`` is missing or empty. A random
            baseline cannot answer a multiple-choice question with no
            choices, and silently returning ``""`` would let broken
            pipelines look healthy.
    """
    choices = _get(shape, "choices")
    if not choices:
        raise ValueError("multiple_choice baseline requires non-empty choices")
    return rng.choice(list(choices))


def _junk_for_schema(prop_schema: dict[str, Any]) -> Any:
    """Return a type-appropriate junk value for a JSON-schema property.

    Mapping (in priority order):
        - ``enum`` -> first listed value
        - ``type`` == "string" -> ``"x"``
        - ``type`` in {"integer", "number"} -> ``0``
        - ``type`` == "boolean" -> ``False``
        - ``type`` == "array" -> ``[]``
        - ``type`` == "object" -> ``{}``
        - anything else (including missing type) -> ``None``

    This is intentionally lazy — the goal is "well-typed garbage", not
    a real plausible value. Real agents that beat this baseline are
    doing meaningful work.
    """
    enum = prop_schema.get("enum")
    if isinstance(enum, list) and enum:
        return enum[0]
    t = prop_schema.get("type")
    if t == "string":
        return "x"
    if t in ("integer", "number"):
        return 0
    if t == "boolean":
        return False
    if t == "array":
        return []
    if t == "object":
        return {}
    return None


def pick_random_function_call(shape: Any, rng: random.Random) -> dict[str, Any]:
    """Pick a random function and fill its required args with type junk.

    Reads ``shape.allowed_functions`` as a list of JSON-schema-like
    dicts. Each function dict is expected to have ``name`` and
    ``parameters`` (with ``properties`` + ``required``). Functions
    with no required args produce ``"arguments": {}``.

    Returns:
        ``{"name": <picked function name>, "arguments": {<required>: <junk>}}``.

    Raises:
        ValueError: when ``allowed_functions`` is missing or empty.
    """
    fns = _get(shape, "allowed_functions")
    if not fns:
        raise ValueError("function_call baseline requires allowed_functions")
    fn = rng.choice(list(fns))
    name = fn.get("name") if isinstance(fn, dict) else None
    if not isinstance(name, str) or not name:
        raise ValueError("function entry missing string 'name'")
    params = fn.get("parameters") if isinstance(fn, dict) else None
    args: dict[str, Any] = {}
    if isinstance(params, dict):
        props = params.get("properties") or {}
        required = params.get("required") or []
        if isinstance(required, list) and isinstance(props, dict):
            for key in required:
                prop_schema = props.get(key) if isinstance(props.get(key), dict) else {}
                args[str(key)] = _junk_for_schema(prop_schema or {})
    return {"name": name, "arguments": args}


def empty_patch(shape: Any) -> str:
    """Return an empty unified diff.

    The argument is accepted for signature symmetry with the other
    strategies; ``shape`` is unused because there is exactly one
    canonical "do nothing" patch.
    """
    del shape
    return ""


def random_trajectory(shape: Any, rng: random.Random) -> list[dict[str, Any]]:
    """Generate ``max_steps`` random function calls.

    Each step uses ``pick_random_function_call`` on the same
    ``allowed_functions`` set. ``max_steps`` defaults to 1 if missing
    or non-positive — a trajectory with zero steps is not a useful
    baseline.
    """
    raw_steps = _get(shape, "max_steps")
    try:
        max_steps = int(raw_steps) if raw_steps is not None else 1
    except (TypeError, ValueError):
        max_steps = 1
    if max_steps < 1:
        max_steps = 1
    return [pick_random_function_call(shape, rng) for _ in range(max_steps)]


def random_freeform_string(shape: Any, rng: random.Random, length: int = 64) -> str:
    """Return an ascii string of ``length`` letters/digits/spaces.

    Used as the fallback for benchmarks where a random baseline is not
    interpretable (free-form code, wallet addresses, etc.). The
    ``is_meaningful=False`` flag on the strategy is what actually
    matters; this just produces something deterministic-on-seed for
    the runner to record.
    """
    del shape
    if length < 0:
        raise ValueError("length must be non-negative")
    alphabet = string.ascii_letters + string.digits + " "
    return "".join(rng.choice(alphabet) for _ in range(length))


# -------- Registry --------


BENCHMARK_STRATEGIES: dict[str, BaselineStrategy] = {
    # Action-calling / BFCL-style
    "bfcl": BaselineStrategy(
        "function_call",
        "Pick uniformly from available functions, fill args with type junk",
        True,
    ),
    "action-calling": BaselineStrategy(
        "function_call",
        "Pick uniformly from registered actions, fill required args with type junk",
        True,
    ),
    "agentbench": BaselineStrategy(
        "function_call",
        "Pick uniformly from AgentBench tool set, junk args",
        True,
    ),
    # Multiple choice
    "context-bench": BaselineStrategy(
        "multiple_choice",
        "Uniform over choices",
        True,
    ),
    "mind2web": BaselineStrategy(
        "function_call",
        "Pick uniformly from Mind2Web DOM actions, junk args",
        True,
    ),
    # Trajectory-style
    "terminal-bench": BaselineStrategy(
        "trajectory",
        "Random shell commands up to max_steps",
        True,
    ),
    "osworld": BaselineStrategy(
        "trajectory",
        "Random GUI actions up to max_steps",
        True,
    ),
    "tau-bench": BaselineStrategy(
        "function_call",
        "Pick uniformly from tau-bench tool set, junk args",
        True,
    ),
    # Patches / freeform
    "swe-bench": BaselineStrategy(
        "empty_patch",
        "Empty unified diff -- random patches are nonsensical",
        True,
    ),
    "mint": BaselineStrategy(
        "function_call",
        "Pick uniformly from MINT tool set, junk args",
        True,
    ),
    # Domain-specific -- random baseline is uninterpretable
    "solana": BaselineStrategy(
        "freeform",
        "Random hex addresses -- uninterpretable",
        False,
    ),
    "evm": BaselineStrategy(
        "freeform",
        "Random hex -- uninterpretable",
        False,
    ),
    "hyperliquid": BaselineStrategy(
        "freeform",
        "Random trading actions -- uninterpretable as a baseline",
        False,
    ),
    "lifeops-bench": BaselineStrategy(
        "function_call",
        "Random tool calls over allowed set",
        True,
    ),
    "clawbench": BaselineStrategy(
        "function_call",
        "Random tool calls over scenario allowed set",
        True,
    ),
}


_DEFAULT_STRATEGY = BaselineStrategy(
    "freeform",
    "Unknown benchmark -- random response is uninterpretable",
    False,
)


def get_strategy(benchmark_id: str) -> BaselineStrategy:
    """Look up the strategy for ``benchmark_id``.

    Unknown ids fall through to a ``freeform`` strategy with
    ``is_meaningful=False`` so the caller can record the run and flag
    it as uninterpretable rather than crashing or silently using a
    misleading baseline.
    """
    return BENCHMARK_STRATEGIES.get(benchmark_id, _DEFAULT_STRATEGY)


# -------- Score lift calculation --------


def lift_over_random(
    score: float | None,
    random_score: float | None,
    *,
    higher_is_better: bool,
) -> float | None:
    """Compute the lift of ``score`` over ``random_score``.

    When ``higher_is_better`` is True (accuracy, success rate),
    returns ``score / random_score``. When False (latency, error
    count), returns ``random_score / score`` so the result is still
    "bigger is better" for the caller.

    Returns ``None`` when either input is ``None`` or the denominator
    is zero, so callers do not need their own division-by-zero
    handling. ``score == 0`` with ``higher_is_better=False`` would
    mean "perfect zero latency" and is treated as missing rather than
    infinite to keep the report robust to noisy inputs.
    """
    if score is None or random_score is None:
        return None
    try:
        score_f = float(score)
        random_f = float(random_score)
    except (TypeError, ValueError):
        return None
    if higher_is_better:
        if random_f == 0.0:
            return None
        return score_f / random_f
    if score_f == 0.0:
        return None
    return random_f / score_f


def is_better_than_random(
    score: float | None,
    random_score: float | None,
    *,
    higher_is_better: bool,
    min_lift: float = 1.5,
) -> bool:
    """True if ``score`` beats ``random_score`` by at least ``min_lift``x.

    Direction is handled by ``lift_over_random``; this function only
    compares the resulting lift to the threshold. Returns ``False``
    when lift is undefined (missing inputs, zero denominator) so a
    broken pipeline is never reported as "better than random".
    """
    lift = lift_over_random(
        score,
        random_score,
        higher_is_better=higher_is_better,
    )
    if lift is None:
        return False
    return lift >= min_lift


# -------- Public CLI helper --------


def generate_random_response(
    benchmark_id: str,
    task_shape_json: str,
    seed: int | None = None,
) -> str:
    """Generate a random response for one task and return it as JSON.

    Args:
        benchmark_id: Key into ``BENCHMARK_STRATEGIES``; unknown ids
            fall through to the freeform default.
        task_shape_json: A JSON-encoded ``TaskShape``-like dict. The
            runner is responsible for constructing this; this module
            never reads from disk.
        seed: Optional integer seed. ``None`` produces a fresh non-
            deterministic ``random.Random()``.

    Returns:
        A JSON string. The shape of the parsed object depends on the
        strategy:
            - multiple_choice -> string
            - function_call   -> {"name": str, "arguments": dict}
            - empty_patch     -> empty string (JSON-encoded as a quoted empty string)
            - trajectory      -> list of function-call dicts
            - freeform        -> string
    """
    shape = json.loads(task_shape_json)
    rng = random.Random(seed)
    strategy = get_strategy(benchmark_id)
    if strategy.name == "multiple_choice":
        payload: Any = pick_random_choice(shape, rng)
    elif strategy.name == "function_call":
        payload = pick_random_function_call(shape, rng)
    elif strategy.name == "empty_patch":
        payload = empty_patch(shape)
    elif strategy.name == "trajectory":
        payload = random_trajectory(shape, rng)
    elif strategy.name == "freeform":
        payload = random_freeform_string(shape, rng)
    else:
        raise ValueError(f"unknown strategy name: {strategy.name}")
    return json.dumps(payload)


def _build_parser() -> argparse.ArgumentParser:
    """Build the argparse parser used by ``cli``.

    Split out so tests can introspect it without running ``sys.exit``.
    """
    parser = argparse.ArgumentParser(
        prog="random_baseline",
        description="Random-baseline agent for the tri-agent benchmarking harness.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    gen = sub.add_parser("gen", help="Emit a random response for one task.")
    gen.add_argument("--benchmark", required=True, help="Benchmark id.")
    gen.add_argument(
        "--task",
        required=True,
        help="Path to a JSON file holding the TaskShape, or '-' for stdin.",
    )
    gen.add_argument("--seed", type=int, default=None)

    lift = sub.add_parser(
        "lift",
        help="Compute the lift of a score over a random baseline.",
    )
    lift.add_argument("--score", type=float, required=True)
    lift.add_argument("--random-score", type=float, required=True)
    lift.add_argument(
        "--higher-is-better",
        action="store_true",
        help="Set when bigger is better (accuracy). Omit for latency-style.",
    )
    lift.add_argument(
        "--min-lift",
        type=float,
        default=1.5,
        help="Threshold for is_better_than_random.",
    )

    sub.add_parser("list", help="Print the strategy registry as JSON.")

    return parser


def _read_task_shape(arg: str) -> str:
    """Resolve the ``--task`` argument into a JSON string.

    ``-`` reads stdin. Any other value is treated as a path to a file
    containing the JSON. The runner uses this to avoid quoting large
    schemas on the command line.
    """
    if arg == "-":
        return sys.stdin.read()
    with open(arg, "r", encoding="utf-8") as fh:
        return fh.read()


def cli(argv: list[str] | None = None) -> int:
    """Entry point for ``python -m lib.random_baseline``.

    Subcommands:
        ``gen``: emit a random response for one task as JSON on stdout.
        ``lift``: print ``{"lift": <float|null>, "better": <bool>}``.
        ``list``: print the strategy registry as JSON.

    Returns ``0`` on success. Errors propagate as non-zero exits via
    argparse / unhandled exceptions; this CLI is for tooling, not
    user-friendly diagnostics.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "gen":
        shape_json = _read_task_shape(args.task)
        sys.stdout.write(
            generate_random_response(args.benchmark, shape_json, args.seed)
        )
        sys.stdout.write("\n")
        return 0
    if args.cmd == "lift":
        lift = lift_over_random(
            args.score,
            args.random_score,
            higher_is_better=args.higher_is_better,
        )
        better = is_better_than_random(
            args.score,
            args.random_score,
            higher_is_better=args.higher_is_better,
            min_lift=args.min_lift,
        )
        sys.stdout.write(json.dumps({"lift": lift, "better": better}))
        sys.stdout.write("\n")
        return 0
    if args.cmd == "list":
        out = {
            bid: {
                "name": strat.name,
                "description": strat.description,
                "is_meaningful": strat.is_meaningful,
            }
            for bid, strat in BENCHMARK_STRATEGIES.items()
        }
        sys.stdout.write(json.dumps(out, indent=2))
        sys.stdout.write("\n")
        return 0
    parser.error(f"unknown command: {args.cmd}")
    return 2  # pragma: no cover -- argparse exits before this


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(cli())
