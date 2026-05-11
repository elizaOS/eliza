"""Tests for ``lib/random_baseline.py``.

Loads the module via ``importlib`` so the tests do not depend on
``lib/__init__.py`` re-exporting it (a parallel agent owns that file).
No network, no disk reads of benchmark task files.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest


# -------- Module loader --------


_MODULE_PATH = (
    Path(__file__).resolve().parent.parent / "lib" / "random_baseline.py"
)


def _load_module():
    name = "random_baseline_under_test"
    spec = importlib.util.spec_from_file_location(name, _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Python 3.14's dataclasses machinery looks up the defining module via
    # sys.modules to resolve ``from __future__ import annotations`` strings,
    # so the module has to be registered before exec_module runs.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


rb = _load_module()


# -------- Helpers --------


@dataclass
class _Shape:
    """Minimal duck-typed TaskShape used by the strategy tests."""

    kind: str = "freeform"
    choices: list[str] | None = None
    allowed_functions: list[dict[str, Any]] | None = None
    max_steps: int | None = None


def _fn(name: str, required: list[str], props: dict[str, dict]) -> dict[str, Any]:
    return {
        "name": name,
        "parameters": {
            "type": "object",
            "properties": props,
            "required": required,
        },
    }


# -------- Strategy registry --------


def test_strategy_lookup_returns_default_on_unknown() -> None:
    strat = rb.get_strategy("not-a-real-benchmark-xyz")
    assert strat.name == "freeform"
    assert strat.is_meaningful is False


def test_strategy_lookup_known_benchmarks() -> None:
    assert rb.get_strategy("bfcl").name == "function_call"
    assert rb.get_strategy("context-bench").name == "multiple_choice"
    assert rb.get_strategy("swe-bench").name == "empty_patch"
    assert rb.get_strategy("terminal-bench").name == "trajectory"
    assert rb.get_strategy("solana").is_meaningful is False
    assert rb.get_strategy("bfcl").is_meaningful is True


def test_registry_has_all_required_benchmarks() -> None:
    expected = {
        "bfcl",
        "action-calling",
        "agentbench",
        "context-bench",
        "mind2web",
        "terminal-bench",
        "osworld",
        "tau-bench",
        "swe-bench",
        "mint",
        "solana",
        "evm",
        "hyperliquid",
        "lifeops-bench",
        "clawbench",
    }
    assert expected.issubset(set(rb.BENCHMARK_STRATEGIES))


# -------- Multiple choice --------


def test_pick_random_choice_uniform_seeded() -> None:
    import random

    shape = _Shape(kind="multiple_choice", choices=["a", "b", "c", "d"])
    rng = random.Random(42)
    got = rb.pick_random_choice(shape, rng)
    assert got in shape.choices


def test_pick_random_choice_raises_when_empty() -> None:
    import random

    with pytest.raises(ValueError):
        rb.pick_random_choice(_Shape(kind="multiple_choice", choices=[]), random.Random(0))


def test_pick_random_choice_accepts_dict() -> None:
    import random

    shape = {"kind": "multiple_choice", "choices": ["x", "y"]}
    got = rb.pick_random_choice(shape, random.Random(0))
    assert got in ("x", "y")


# -------- Function call --------


def test_function_call_args_match_schema() -> None:
    import random

    fns = [
        _fn(
            "transfer",
            required=["to", "amount", "confirm", "tags", "memo"],
            props={
                "to": {"type": "string"},
                "amount": {"type": "number"},
                "confirm": {"type": "boolean"},
                "tags": {"type": "array"},
                "memo": {"type": "object"},
            },
        ),
    ]
    shape = _Shape(kind="function_call", allowed_functions=fns)
    out = rb.pick_random_function_call(shape, random.Random(7))
    assert out["name"] == "transfer"
    args = out["arguments"]
    # Every required key present
    assert set(args.keys()) == {"to", "amount", "confirm", "tags", "memo"}
    # Type-appropriate junk
    assert args["to"] == "x"
    assert args["amount"] == 0
    assert args["confirm"] is False
    assert args["tags"] == []
    assert args["memo"] == {}


def test_function_call_enum_picks_first() -> None:
    import random

    fns = [
        _fn(
            "set_mode",
            required=["mode"],
            props={"mode": {"type": "string", "enum": ["fast", "slow", "off"]}},
        )
    ]
    out = rb.pick_random_function_call(
        _Shape(kind="function_call", allowed_functions=fns),
        random.Random(0),
    )
    assert out["arguments"]["mode"] == "fast"


def test_function_call_no_required_args() -> None:
    import random

    fns = [_fn("ping", required=[], props={})]
    out = rb.pick_random_function_call(
        _Shape(kind="function_call", allowed_functions=fns),
        random.Random(0),
    )
    assert out == {"name": "ping", "arguments": {}}


def test_function_call_raises_when_empty() -> None:
    import random

    with pytest.raises(ValueError):
        rb.pick_random_function_call(
            _Shape(kind="function_call", allowed_functions=[]),
            random.Random(0),
        )


def test_function_call_picks_uniformly_over_seeds() -> None:
    import random

    fns = [
        _fn("a", required=[], props={}),
        _fn("b", required=[], props={}),
        _fn("c", required=[], props={}),
    ]
    shape = _Shape(kind="function_call", allowed_functions=fns)
    seen = {
        rb.pick_random_function_call(shape, random.Random(s))["name"]
        for s in range(200)
    }
    assert seen == {"a", "b", "c"}


# -------- Empty patch --------


def test_empty_patch_returns_empty_string() -> None:
    assert rb.empty_patch(_Shape(kind="patch")) == ""


# -------- Trajectory --------


def test_random_trajectory_length_matches_max_steps() -> None:
    import random

    fns = [_fn("op", required=[], props={})]
    shape = _Shape(kind="trajectory", allowed_functions=fns, max_steps=5)
    steps = rb.random_trajectory(shape, random.Random(0))
    assert len(steps) == 5
    assert all(s["name"] == "op" for s in steps)


def test_random_trajectory_floor_one_step() -> None:
    import random

    fns = [_fn("op", required=[], props={})]
    for raw in (None, 0, -3, "bogus"):
        shape = _Shape(kind="trajectory", allowed_functions=fns, max_steps=raw)  # type: ignore[arg-type]
        steps = rb.random_trajectory(shape, random.Random(0))
        assert len(steps) == 1


# -------- Freeform --------


def test_freeform_length_and_charset() -> None:
    import random

    out = rb.random_freeform_string(_Shape(), random.Random(0), length=32)
    assert len(out) == 32
    assert all(c.isalnum() or c == " " for c in out)


def test_freeform_negative_length_raises() -> None:
    import random

    with pytest.raises(ValueError):
        rb.random_freeform_string(_Shape(), random.Random(0), length=-1)


# -------- Lift math --------


def test_lift_higher_better() -> None:
    assert rb.lift_over_random(0.8, 0.4, higher_is_better=True) == pytest.approx(2.0)


def test_lift_lower_better() -> None:
    # Latency: 10ms vs 100ms -> 10x lift.
    assert rb.lift_over_random(10.0, 100.0, higher_is_better=False) == pytest.approx(10.0)


def test_lift_returns_none_on_missing_inputs() -> None:
    assert rb.lift_over_random(None, 0.5, higher_is_better=True) is None
    assert rb.lift_over_random(0.5, None, higher_is_better=True) is None


def test_lift_returns_none_on_zero_denominator() -> None:
    # higher_is_better: random_score is the denominator
    assert rb.lift_over_random(0.5, 0.0, higher_is_better=True) is None
    # lower_is_better: score is the denominator
    assert rb.lift_over_random(0.0, 100.0, higher_is_better=False) is None


def test_is_better_than_random_threshold() -> None:
    # lift = 0.7 / 0.5 = 1.4, below default 1.5
    assert rb.is_better_than_random(0.7, 0.5, higher_is_better=True) is False
    # lift = 0.8 / 0.5 = 1.6, above 1.5
    assert rb.is_better_than_random(0.8, 0.5, higher_is_better=True) is True


def test_is_better_than_random_custom_min_lift() -> None:
    assert rb.is_better_than_random(
        0.6, 0.5, higher_is_better=True, min_lift=1.1
    ) is True
    assert rb.is_better_than_random(
        0.6, 0.5, higher_is_better=True, min_lift=2.0
    ) is False


def test_is_better_than_random_on_missing_inputs() -> None:
    assert rb.is_better_than_random(None, 0.5, higher_is_better=True) is False
    assert rb.is_better_than_random(0.5, 0.0, higher_is_better=True) is False


# -------- generate_random_response --------


def test_generate_random_response_seedable() -> None:
    shape = {
        "kind": "function_call",
        "allowed_functions": [
            _fn("a", required=["x"], props={"x": {"type": "string"}}),
            _fn("b", required=["y"], props={"y": {"type": "integer"}}),
            _fn("c", required=[], props={}),
        ],
    }
    payload = json.dumps(shape)
    a = rb.generate_random_response("bfcl", payload, seed=12345)
    b = rb.generate_random_response("bfcl", payload, seed=12345)
    assert a == b
    # Different seeds eventually produce different output for this 3-fn space.
    diff = {
        rb.generate_random_response("bfcl", payload, seed=s) for s in range(50)
    }
    assert len(diff) > 1


def test_generate_random_response_multiple_choice() -> None:
    shape = json.dumps({"kind": "multiple_choice", "choices": ["yes", "no"]})
    out = json.loads(rb.generate_random_response("context-bench", shape, seed=0))
    assert out in ("yes", "no")


def test_generate_random_response_empty_patch() -> None:
    shape = json.dumps({"kind": "patch"})
    assert json.loads(rb.generate_random_response("swe-bench", shape, seed=0)) == ""


def test_generate_random_response_trajectory() -> None:
    shape = json.dumps(
        {
            "kind": "trajectory",
            "max_steps": 3,
            "allowed_functions": [_fn("op", required=[], props={})],
        }
    )
    out = json.loads(rb.generate_random_response("terminal-bench", shape, seed=1))
    assert isinstance(out, list)
    assert len(out) == 3


def test_generate_random_response_freeform_for_unknown() -> None:
    shape = json.dumps({"kind": "freeform"})
    out = json.loads(rb.generate_random_response("unknown-bench", shape, seed=0))
    assert isinstance(out, str)
    assert len(out) == 64


# -------- CLI --------


def _capture_stdout(fn, *args, **kwargs) -> str:
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        rc = fn(*args, **kwargs)
    finally:
        sys.stdout = old
    assert rc == 0
    return buf.getvalue()


def test_cli_list_emits_valid_json() -> None:
    out = _capture_stdout(rb.cli, ["list"])
    parsed = json.loads(out)
    assert "bfcl" in parsed
    assert parsed["bfcl"]["name"] == "function_call"
    assert parsed["solana"]["is_meaningful"] is False


def test_cli_lift_emits_valid_json() -> None:
    out = _capture_stdout(
        rb.cli,
        [
            "lift",
            "--score",
            "0.8",
            "--random-score",
            "0.4",
            "--higher-is-better",
        ],
    )
    parsed = json.loads(out)
    assert parsed["lift"] == pytest.approx(2.0)
    assert parsed["better"] is True


def test_cli_lift_handles_zero_denominator() -> None:
    out = _capture_stdout(
        rb.cli,
        [
            "lift",
            "--score",
            "0.5",
            "--random-score",
            "0",
            "--higher-is-better",
        ],
    )
    parsed = json.loads(out)
    assert parsed["lift"] is None
    assert parsed["better"] is False


def test_cli_gen_emits_valid_json(tmp_path: Path) -> None:
    shape_file = tmp_path / "shape.json"
    shape_file.write_text(
        json.dumps(
            {
                "kind": "function_call",
                "allowed_functions": [
                    _fn("ping", required=[], props={}),
                ],
            }
        )
    )
    out = _capture_stdout(
        rb.cli,
        ["gen", "--benchmark", "bfcl", "--task", str(shape_file), "--seed", "0"],
    )
    parsed = json.loads(out)
    assert parsed == {"name": "ping", "arguments": {}}


def test_cli_gen_reads_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    shape = json.dumps({"kind": "multiple_choice", "choices": ["only"]})
    monkeypatch.setattr(sys, "stdin", io.StringIO(shape))
    out = _capture_stdout(
        rb.cli,
        ["gen", "--benchmark", "context-bench", "--task", "-", "--seed", "0"],
    )
    assert json.loads(out) == "only"
