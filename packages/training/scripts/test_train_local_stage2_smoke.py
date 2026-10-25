"""Real Stage 2 forward/backward smoke for the local SFT entrypoint.

The test builds a tiny local Transformers causal LM, trains one complete epoch
across the tracked training split through `train_local.py`, and verifies the
saved checkpoint numerics report. This proves the Stage 2 pipeline without
claiming the separate Gemma-4, Liger, or constrained-VRAM hardware contracts.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
SMOKE_DATA = ROOT / "data" / "final-eliza1-smoke"


def _write_tiny_causal_lm(model_dir: Path) -> None:
    tokenizers = pytest.importorskip("tokenizers")
    transformers = pytest.importorskip("transformers")
    torch = pytest.importorskip("torch")

    vocab = {
        "[PAD]": 0,
        "[UNK]": 1,
        "[BOS]": 2,
        "[EOS]": 3,
        "system": 4,
        "user": 5,
        "assistant": 6,
        "tool": 7,
        "hello": 8,
        "reply": 9,
        "json": 10,
        "text": 11,
        "agent": 12,
        "content": 13,
        "the": 14,
        "a": 15,
        "to": 16,
        "and": 17,
        "I": 18,
        "you": 19,
    }
    raw = tokenizers.Tokenizer(
        tokenizers.models.WordLevel(vocab=vocab, unk_token="[UNK]"),
    )
    raw.pre_tokenizer = tokenizers.pre_tokenizers.Whitespace()
    tokenizer = transformers.PreTrainedTokenizerFast(
        tokenizer_object=raw,
        unk_token="[UNK]",
        pad_token="[PAD]",
        bos_token="[BOS]",
        eos_token="[EOS]",
    )
    tokenizer.chat_template = (
        "{% if tools %}{% for tool in tools %}"
        "tool {{ tool['function']['name'] }} "
        "{% endfor %}{% endif %}"
        "{% for message in messages %}"
        "{{ message['role'] }}: "
        "{% if message.get('tool_calls') %}"
        "{% for call in message['tool_calls'] %}"
        "tool {{ call['function']['name'] }} "
        "{{ call['function']['arguments'] | tojson }}"
        "{% endfor %}"
        "{% elif message['content'] is string %}{{ message['content'] }}{% endif %}\n"
        "{% endfor %}{{ eos_token }}"
    )
    config = transformers.GPT2Config(
        vocab_size=len(vocab),
        n_positions=64,
        n_ctx=64,
        n_embd=32,
        n_layer=1,
        n_head=2,
        bos_token_id=2,
        eos_token_id=3,
        pad_token_id=0,
    )
    torch.manual_seed(0)
    model = transformers.GPT2LMHeadModel(config)
    model.save_pretrained(model_dir)
    tokenizer.save_pretrained(model_dir)


def test_train_local_runs_real_forward_backward_and_scans_checkpoint(
    tmp_path: Path,
) -> None:
    pytest.importorskip("trl")
    pytest.importorskip("datasets")
    pytest.importorskip("apollo_torch")

    model_dir = tmp_path / "tiny-model"
    out_dir = tmp_path / "out"
    _write_tiny_causal_lm(model_dir)

    cmd = [
        sys.executable,
        str(SCRIPTS / "train_local.py"),
        "--model",
        str(model_dir),
        "--train-file",
        str(SMOKE_DATA / "train.jsonl"),
        "--val-file",
        str(SMOKE_DATA / "val.jsonl"),
        "--out-dir",
        str(out_dir),
        "--run-name",
        "stage2-tiny-smoke",
        "--max-samples",
        "20",
        "--epochs",
        "1",
        "--max-steps",
        "16",
        "--batch-size",
        "1",
        "--grad-accum",
        "1",
        "--max-seq-len",
        "64",
        "--optimizer",
        "apollo_mini",
        "--apollo-rank",
        "1",
        "--train-dtype",
        "bf16",
        "--max-grad-norm",
        "1.0",
        "--use-liger",
        "off",
    ]
    env = {
        **os.environ,
        "TOKENIZERS_PARALLELISM": "false",
        "WANDB_DISABLED": "true",
    }
    proc = subprocess.run(
        cmd,
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode == 0, (
        "train_local.py tiny smoke failed\n"
        f"stdout tail:\n{proc.stdout[-2000:]}\n"
        f"stderr tail:\n{proc.stderr[-4000:]}"
    )
    assert "formatted train 16/16 records" in proc.stderr
    assert "formatted validation 2/2 records" in proc.stderr
    assert "render-time skips" not in proc.stderr
    assert "train_runtime" in proc.stdout

    final_dir = out_dir / "stage2-tiny-smoke" / "final"
    report_path = final_dir / "numerics_scan.json"
    assert report_path.exists(), f"missing checkpoint numerics report at {report_path}"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["passed"] is True
    assert report["tensor_files"] > 0
    assert report["tensors"] > 0
    assert "checkpoint numerics scan passed" in proc.stderr
