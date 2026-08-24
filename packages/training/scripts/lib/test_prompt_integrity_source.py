"""Guards model-facing training paths against silent context or output loss."""

from pathlib import Path

import pytest

from lib.generation_integrity import (
    PromptExceedsContextError,
    UnknownModelOutputLimitError,
    anthropic_max_output_tokens,
)
from rl.tokenization_utils import remaining_context_tokens


SCRIPTS_ROOT = Path(__file__).resolve().parents[1]


def python_sources() -> list[Path]:
    return sorted(SCRIPTS_ROOT.rglob("*.py"))


def test_local_text_generation_paths_admit_only_complete_output() -> None:
    missing = []
    for path in python_sources():
        relative = path.relative_to(SCRIPTS_ROOT)
        if relative.parts[0] == "quantization":
            continue
        source = path.read_text(encoding="utf-8")
        if "model.generate(" in source and "require_complete_generated_tokens" not in source:
            missing.append(str(relative))

    assert missing == []


def test_provider_choice_consumers_use_generation_admission() -> None:
    missing = []
    for path in python_sources():
        source = path.read_text(encoding="utf-8")
        consumes_choice = any(
            marker in source
            for marker in ("choices[0]", '["choices"]', 'get("choices"')
        )
        if consumes_choice and "require_complete_generation" not in source:
            missing.append(str(path.relative_to(SCRIPTS_ROOT)))

    assert missing == []


def test_known_training_context_slices_do_not_return() -> None:
    forbidden = {
        "rl/tinker/tinker_client.py": (
            "completion_tokens = completion_tokens[:max_sequence_length]",
            "tokens = tokens[-max_sequence_length:]",
        ),
        "rl/feed_env.py": ("messages = [messages[0], *messages[2:]]",),
        "synth/together_synth.py": ("memory[-6:]", 'get("content") or "")[:300]'),
        "build_eliza1_sft_2b.py": ("msgs[: last_nonempty + 1]",),
        "rewrites/regularizer_reasoning_tool.py": (
            "sentences[-2:]",
            "tail[-400:]",
            "tail[-600:]",
        ),
        "eliza_reward_fn.py": (
            '(prompt or "")[:2000]',
            "json.dumps(expected, ensure_ascii=False, default=str)[:1500]",
            '(response or "")[:2000]',
        ),
        "kokoro/coreml/validate_e2e_coreml.py": ("ids = ids[:max_tokens]",),
        "rl/feed_env.py": ("min(512, self.config.max_token_length // 3)",),
        "rl/online_env.py": ("self.config.max_response_tokens",),
        "rl/hybrid_env.py": ("self.config.max_response_tokens", '"max_tokens": 512'),
        "rl/tinker/tinker_client.py": ("default_max_tokens",),
        "rl/tinker/tinker_rl_orchestrator.py": ("max_tokens=128",),
        "rl/tinker/tinker_trainer.py": ("inference_max_tokens", "max_tokens=500"),
    }
    found = []
    for relative, markers in forbidden.items():
        source = (SCRIPTS_ROOT / relative).read_text(encoding="utf-8")
        found.extend(f"{relative}: {marker}" for marker in markers if marker in source)

    assert found == []


def test_anthropic_calls_use_documented_provider_maxima() -> None:
    assert anthropic_max_output_tokens("claude-opus-4-7") == 128_000
    assert anthropic_max_output_tokens("claude-sonnet-4-20250514") == 64_000
    assert anthropic_max_output_tokens("claude-haiku-4-5-20251001") == 64_000
    with pytest.raises(UnknownModelOutputLimitError):
        anthropic_max_output_tokens("unknown-model")

    for relative in ("synthesize_targets.py", "eliza_reward_fn.py"):
        source = (SCRIPTS_ROOT / relative).read_text(encoding="utf-8")
        assert "max_tokens=anthropic_max_output_tokens(" in source


def test_generation_uses_all_remaining_context_or_rejects_prompt() -> None:
    class Tokenizer:
        def apply_chat_template(self, messages, **kwargs):
            del kwargs
            return list(range(len(messages[0]["content"])))

    tokenizer = Tokenizer()
    messages = [{"role": "user", "content": "complete"}]
    assert remaining_context_tokens(
        tokenizer, messages, context_tokens=12, source="test"
    ) == 4
    with pytest.raises(PromptExceedsContextError):
        remaining_context_tokens(
            tokenizer, messages, context_tokens=8, source="test"
        )
