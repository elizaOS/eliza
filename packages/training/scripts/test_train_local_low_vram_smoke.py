"""CPU-only smoke tests for the `--low-vram-smoke` preset in train_local.py.

The preset is a flag bundle targeting a 12 GB consumer-GPU budget. It sets
seq_len 2048, batch 1, grad_accum 16, memory budget 11.5 GB, max_samples 1000,
and epochs 1 while still letting any explicit CLI flag win. These tests verify
merge semantics; only a measured model run can establish hardware fit.

These tests parse args via the same argparse layout as `train_local.main`
and exercise its fail-closed corpus preflight without touching torch or CUDA.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

train_local = importlib.import_module("train_local")


class _FakeParam:
    def __init__(self, *, requires_grad: bool = True) -> None:
        self.requires_grad = requires_grad


class _FakeModel:
    def __init__(self, named_params: list[tuple[str, _FakeParam]]) -> None:
        self._named_params = named_params

    def named_parameters(self):
        return iter(self._named_params)


def _resolve(argv):
    """Drive the same parser + merge pipeline that `train_local.main()` uses.

    This delegates to `train_local.build_parser()` and
    `train_local.apply_resolved_defaults()` so the test exercises the
    exact code path that ships, not a hand-maintained mirror. Catches
    the regression where someone touches the merge logic in
    train_local.main but forgets to update a tests-only copy.
    """
    ap = train_local.build_parser()
    args = ap.parse_args(argv)
    train_local.apply_resolved_defaults(args)
    return args


def test_low_vram_smoke_overrides_registry_2b_defaults() -> None:
    """Registry 2B says seq_len=8192, batch=1, accum=16, budget=15.5GB. The
    preset must tighten seq_len to 2048 and target an 11.5 GB nominal budget."""
    args = _resolve(["--registry-key", "gemma4-e2b", "--low-vram-smoke"])
    assert args.max_seq_len == 2048
    assert args.batch_size == 1
    assert args.grad_accum == 16
    assert args.max_samples == 1000
    assert args.epochs == 1.0
    assert args.memory_budget_gb == 11.5
    # Effective batch held at 16 — same loss signal as registry default 2B.
    assert args.batch_size * args.grad_accum == 16
    # Liger and APOLLO settings flow through unchanged.
    assert args.use_liger == "auto"
    assert args.optimizer == "apollo_mini"


def test_low_vram_smoke_explicit_seq_len_wins() -> None:
    """The preset must NOT override values the caller passed explicitly.
    Useful for the "still OOMs at 2048, retry at 1024" workflow documented
    in the README."""
    args = _resolve(
        ["--registry-key", "gemma4-e2b", "--low-vram-smoke", "--max-seq-len", "1024"]
    )
    assert args.max_seq_len == 1024
    # Other preset overrides still apply.
    assert args.batch_size == 1
    assert args.grad_accum == 16


def test_low_vram_smoke_explicit_memory_budget_wins() -> None:
    args = _resolve(
        ["--registry-key", "gemma4-e2b", "--low-vram-smoke", "--memory-budget-gb", "10.0"]
    )
    assert args.memory_budget_gb == 10.0


def test_low_vram_smoke_without_registry_key() -> None:
    """The preset is meant to be used with --registry-key but should still
    apply sane defaults when used standalone (model stays at the argparse
    default gemma-4-E2B)."""
    args = _resolve(["--low-vram-smoke"])
    assert args.max_seq_len == 2048
    assert args.batch_size == 1
    assert args.grad_accum == 16
    assert args.max_samples == 1000
    assert args.epochs == 1.0
    assert args.memory_budget_gb == 11.5


def test_no_low_vram_smoke_leaves_registry_defaults_alone() -> None:
    """Regression guard — the preset must only fire when the flag is set."""
    args = _resolve(["--registry-key", "gemma4-e2b"])
    assert args.max_seq_len == 8192
    assert args.batch_size == 1
    assert args.grad_accum == 16  # same as preset, coincidence at 2B
    assert args.memory_budget_gb == pytest.approx(15.5)
    assert args.max_grad_norm == pytest.approx(1.0)
    assert args.train_dtype == "bf16"
    assert args.max_samples == 0
    assert args.epochs == 3.0


def test_large_registry_tier_sets_tighter_grad_clip() -> None:
    """The 12B/31B tiers must not silently inherit HF's global clip default."""
    args = _resolve(["--registry-key", "gemma4-12b"])
    assert args.max_grad_norm == pytest.approx(0.5)


def test_explicit_max_grad_norm_wins_over_registry() -> None:
    args = _resolve(["--registry-key", "gemma4-12b", "--max-grad-norm", "0.25"])
    assert args.max_grad_norm == pytest.approx(0.25)


def test_explicit_train_dtype_wins_when_supported() -> None:
    args = _resolve(["--registry-key", "gemma4-12b", "--train-dtype", "bf16"])
    assert args.train_dtype == "bf16"


def test_unsupported_train_dtype_fails_loud() -> None:
    with pytest.raises(SystemExit, match="not implemented"):
        _resolve(["--registry-key", "gemma4-e2b", "--train-dtype", "fp16"])


@pytest.mark.parametrize(
    ("flag", "value"),
    [
        ("--batch-size", "0"),
        ("--grad-accum", "0"),
        ("--max-seq-len", "0"),
        ("--epochs", "0"),
        ("--lr", "0"),
        ("--apollo-rank", "-1"),
        ("--apollo-scale", "0"),
        ("--apollo-update-proj-gap", "0"),
        ("--memory-budget-gb", "0"),
        ("--max-samples", "-1"),
        ("--max-steps", "-1"),
        ("--max-chars", "-1"),
        ("--max-grad-norm", "-1"),
        ("--lr", "nan"),
        ("--epochs", "inf"),
        ("--apollo-scale", "nan"),
        ("--memory-budget-gb", "inf"),
        ("--max-grad-norm", "nan"),
    ],
)
def test_invalid_training_controls_fail_loud(flag: str, value: str) -> None:
    args = _resolve([flag, value])

    with pytest.raises(ValueError, match=flag):
        train_local._validate_training_controls(args)


def test_liger_arch_gate_allows_validated_gemma4() -> None:
    assert train_local.resolve_liger_arch_gate(
        use_liger=True,
        requested_mode="auto",
        model_type="gemma4",
        architectures=["Gemma4ForCausalLM"],
    ) is True


def test_liger_arch_gate_disables_unsupported_auto() -> None:
    assert train_local.resolve_liger_arch_gate(
        use_liger=True,
        requested_mode="auto",
        model_type="qwen3",
        architectures=["Qwen3ForCausalLM"],
    ) is False


def test_liger_arch_gate_fails_loud_for_requested_unsupported() -> None:
    with pytest.raises(SystemExit, match="not allowlisted"):
        train_local.resolve_liger_arch_gate(
            use_liger=True,
            requested_mode="on",
            model_type="qwen3",
            architectures=["Qwen3ForCausalLM"],
        )


def test_liger_arch_gate_fails_loud_for_requested_gemma4_unified() -> None:
    with pytest.raises(SystemExit, match="gemma4_unified"):
        train_local.resolve_liger_arch_gate(
            use_liger=True,
            requested_mode="on",
            model_type="gemma4_unified",
            architectures=["Gemma4UnifiedForCausalLM"],
        )


def test_apollo_split_preserves_pre_fsdp_lowrank_names() -> None:
    lowrank, other = train_local._split_named(
        _FakeModel([
            ("model.layers.0.mlp.up_proj.weight", _FakeParam()),
            ("model.layers.0.input_layernorm.weight", _FakeParam()),
            ("model.layers.0.self_attn.q_proj.weight", _FakeParam(requires_grad=False)),
        ]),
        {"model.layers.0.mlp.up_proj.weight"},
    )
    assert len(lowrank) == 1
    assert len(other) == 1


def test_apollo_split_strips_fsdp_wrapped_module_prefix() -> None:
    lowrank, other = train_local._split_named(
        _FakeModel([
            ("_fsdp_wrapped_module.model.layers.0.mlp.up_proj.weight", _FakeParam()),
            ("_fsdp_wrapped_module.model.layers.0.input_layernorm.weight", _FakeParam()),
        ]),
        {"model.layers.0.mlp.up_proj.weight"},
    )
    assert len(lowrank) == 1
    assert len(other) == 1


def test_apollo_split_fails_when_fsdp_flattens_lowrank_names() -> None:
    with pytest.raises(RuntimeError, match="APOLLO low-rank routing mismatch"):
        train_local._split_named(
            _FakeModel([
                ("_fsdp_wrapped_module.flat_param", _FakeParam()),
                ("_fsdp_wrapped_module.model.layers.0.input_layernorm.weight", _FakeParam()),
            ]),
            {"model.layers.0.mlp.up_proj.weight"},
        )


def test_low_vram_smoke_flag_lives_on_train_local_parser() -> None:
    """The flag must actually exist on the real parser. Catches the
    regression where someone removes the option but leaves the override
    block (or vice versa)."""
    src = (ROOT / "scripts" / "train_local.py").read_text(encoding="utf-8")
    assert '"--low-vram-smoke"' in src
    assert "args.low_vram_smoke" in src
    assert "low-vram-smoke preset" in src


def test_load_jsonl_rejects_malformed_rows(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus.jsonl"
    corpus.write_text('{"messages": []}\nnot-json\n', encoding="utf-8")

    with pytest.raises(ValueError, match=r"corpus\.jsonl:2: invalid JSON"):
        train_local.load_jsonl(corpus)


def test_load_jsonl_rejects_non_object_rows(tmp_path: Path) -> None:
    corpus = tmp_path / "corpus.jsonl"
    corpus.write_text('["not", "a", "record"]\n', encoding="utf-8")

    with pytest.raises(
        ValueError, match=r"corpus\.jsonl:1: corpus row must be an object"
    ):
        train_local.load_jsonl(corpus)


def test_preflight_rejects_mixed_compatible_and_incompatible_rows(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    compatible = {
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hello"},
        ]
    }
    train_path = tmp_path / "train.jsonl"
    val_path = tmp_path / "validation.jsonl"
    train_path.write_text(
        f"{json.dumps(compatible)}\n{{}}\n",
        encoding="utf-8",
    )
    val_path.write_text(f"{json.dumps(compatible)}\n", encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "train_local.py",
            "--train-file",
            str(train_path),
            "--val-file",
            str(val_path),
            "--preflight-only",
        ],
    )

    assert train_local.main() == 1


def test_preflight_rejects_invalid_apollo_rank(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    compatible = {
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hello"},
        ]
    }
    train_path = tmp_path / "train.jsonl"
    val_path = tmp_path / "validation.jsonl"
    train_path.write_text(f"{json.dumps(compatible)}\n", encoding="utf-8")
    val_path.write_text(f"{json.dumps(compatible)}\n", encoding="utf-8")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "train_local.py",
            "--train-file",
            str(train_path),
            "--val-file",
            str(val_path),
            "--apollo-rank",
            "-1",
            "--preflight-only",
        ],
    )

    assert train_local.main() == 1


def test_build_dataset_rejects_invalid_tool_arguments() -> None:
    record = {
        "messages": [
            {"role": "user", "content": "Use the fictional tool."},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "type": "function",
                        "function": {"name": "lookup", "arguments": "not-json"},
                    }
                ],
            },
        ],
        "tools": {
            "lookup": {
                "description": "Look up a fictional value.",
                "parameters": {"type": "object", "properties": {}},
            }
        },
    }

    class TemplateTokenizer:
        def apply_chat_template(self, **kwargs):
            return "rendered"

    with pytest.raises(ValueError, match="train row 1 failed apply_chat_template"):
        train_local.build_dataset([record], TemplateTokenizer(), split_name="train")


def test_tool_map_is_converted_to_transformers_schema() -> None:
    tools = {
        "lookup_weather": {
            "description": "Look up fictional weather.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
            },
        }
    }

    schemas = train_local._coerce_tools_for_template(tools)

    assert schemas == [
        {
            "type": "function",
            "function": {
                "name": "lookup_weather",
                "description": "Look up fictional weather.",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                },
            },
        }
    ]
    json.dumps(schemas)


def test_tool_map_rejects_incomplete_schema() -> None:
    with pytest.raises(TypeError, match="parameters must be an object"):
        train_local._coerce_tools_for_template(
            {"lookup_weather": {"description": "missing parameters"}}
        )


@pytest.mark.parametrize(
    "flag,value,attr,expected",
    [
        # The historical argparse defaults: --epochs 3.0 and --max-samples 0.
        # If the caller explicitly passes those values together with
        # --low-vram-smoke, the preset must NOT overwrite them with 1.0 / 1000.
        # This is exactly the contract Greptile flagged on PR #7805: the old
        # `_defaults_at_parse` snapshot compared the parsed value to the
        # argparse default and silently said "user didn't pass it" when the
        # explicit value matched the default. None-sentinel defaults make the
        # distinction unambiguous.
        ("--epochs", "3.0", "epochs", 3.0),
        ("--max-samples", "0", "max_samples", 0),
        ("--batch-size", "4", "batch_size", 4),
        ("--grad-accum", "8", "grad_accum", 8),
        ("--max-seq-len", "4096", "max_seq_len", 4096),
        ("--max-grad-norm", "1.0", "max_grad_norm", 1.0),
    ],
)
def test_low_vram_smoke_respects_explicit_default_equal_value(
    flag: str, value: str, attr: str, expected: object
) -> None:
    """An explicit CLI flag set to the historical argparse default must
    survive the preset. The preset can only fill values the user did
    not pass."""
    args = _resolve(["--low-vram-smoke", flag, value])
    assert getattr(args, attr) == expected, (
        f"preset clobbered explicit {flag} {value} → got {getattr(args, attr)!r}"
    )


def test_low_vram_smoke_respects_explicit_max_samples_zero_with_registry() -> None:
    """Combined regression: --registry-key + --low-vram-smoke + an explicit
    --max-samples 0 (meaning "no cap"). Neither the registry nor the preset
    may rewrite the user's 0 to a positive value."""
    args = _resolve(
        ["--registry-key", "gemma4-e2b", "--low-vram-smoke", "--max-samples", "0"]
    )
    assert args.max_samples == 0
    # Other preset overrides still apply.
    assert args.max_seq_len == 2048
    assert args.epochs == 1.0  # not user-passed, preset wins


def test_low_vram_smoke_respects_explicit_epochs_three() -> None:
    """Combined regression: --registry-key + --low-vram-smoke + an explicit
    --epochs 3.0 (which equals the historical argparse default). The user's
    value must survive."""
    args = _resolve(
        ["--registry-key", "gemma4-e2b", "--low-vram-smoke", "--epochs", "3.0"]
    )
    assert args.epochs == 3.0
    # Other preset overrides still apply.
    assert args.max_seq_len == 2048
    assert args.max_samples == 1000  # not user-passed, preset wins
