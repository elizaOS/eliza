from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest

from scripts.distill_dflash_drafter import (
    ACTIVE_TIERS,
    DEFAULT_TARGET_MODEL,
    DEFAULT_STUDENT_BASE,
    _build_manifest,
    _resolve_student_base,
    _tokenizer_parity_report,
)


class FakeTokenizer:
    def __init__(
        self,
        *,
        vocab: dict[str, int] | None = None,
        tokenizer_payload: dict | None = None,
        encode_offset: int = 0,
    ) -> None:
        self._vocab = vocab or {"<pad>": 0, "<eos>": 1, "Eliza": 2, "-": 3}
        self._payload = tokenizer_payload or {"model": {"type": "BPE"}}
        self._encode_offset = encode_offset
        self.special_tokens_map = {"eos_token": "<eos>", "pad_token": "<pad>"}
        self.all_special_ids = [0, 1]
        self.all_special_tokens = ["<pad>", "<eos>"]
        self.chat_template = "{% for message in messages %}{{ message.content }}{% endfor %}"

    def save_pretrained(self, out_dir: Path) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "tokenizer.json").write_text(
            json.dumps(self._payload, sort_keys=True), encoding="utf-8"
        )
        (out_dir / "tokenizer_config.json").write_text(
            json.dumps({"chat_template": self.chat_template}, sort_keys=True),
            encoding="utf-8",
        )

    def get_vocab(self) -> dict[str, int]:
        return dict(self._vocab)

    def get_added_vocab(self) -> dict[str, int]:
        return {}

    def __call__(self, text: str, *, add_special_tokens: bool = False) -> dict[str, list[int]]:
        del add_special_tokens
        return {"input_ids": [((ord(ch) + self._encode_offset) % 97) for ch in text]}


def _args(**overrides) -> argparse.Namespace:
    base = {
        "tier": "0_8b",
        "student_base": None,
        "allow_non_default_student_base": False,
        "target_model_id": None,
        "dataset": None,
        "epochs": 1,
        "batch_size": 8,
        "grad_accum": 4,
        "lr": 2e-4,
        "optimizer": "apollo_mini",
        "apollo_rank": 256,
        "apollo_scale": 1.0,
        "apollo_update_proj_gap": 200,
        "temperature": 1.0,
        "ce_weight": 0.1,
        "top_k_logits": 64,
        "max_seq_len": 2048,
    }
    base.update(overrides)
    return argparse.Namespace(**base)


def test_tokenizer_parity_hashes_exact_serialized_tokenizer() -> None:
    report = _tokenizer_parity_report(FakeTokenizer(), FakeTokenizer())

    assert report["matches"] is True
    assert report["target"]["sha256"] == report["student"]["sha256"]
    assert report["target"]["files"]["tokenizer.json"]


def test_tokenizer_parity_rejects_same_vocab_different_serializer() -> None:
    target = FakeTokenizer(tokenizer_payload={"model": {"type": "BPE", "merges": ["a b"]}})
    student = FakeTokenizer(tokenizer_payload={"model": {"type": "BPE", "merges": ["a c"]}})

    report = _tokenizer_parity_report(target, student)

    assert report["matches"] is False
    assert report["target"]["vocabSha256"] == report["student"]["vocabSha256"]
    assert report["target"]["sha256"] != report["student"]["sha256"]


def test_tokenizer_parity_rejects_same_vocab_different_probe_encoding() -> None:
    report = _tokenizer_parity_report(FakeTokenizer(), FakeTokenizer(encode_offset=1))

    assert report["matches"] is False
    assert report["probeEncodingsMatch"] is False


def test_student_base_mismatch_fails_closed() -> None:
    args = _args(student_base="Qwen/Qwen3.5-2B")

    assert _resolve_student_base(args) is None


def test_student_base_mismatch_requires_explicit_rebaseline_flag() -> None:
    args = _args(
        student_base="Qwen/Qwen3.5-2B",
        allow_non_default_student_base=True,
    )

    assert _resolve_student_base(args) == "Qwen/Qwen3.5-2B"


def test_manifest_records_exact_tokenizer_hashes() -> None:
    args = _args(dataset="distill.jsonl")
    parity = _tokenizer_parity_report(FakeTokenizer(), FakeTokenizer())

    manifest = _build_manifest(
        args=args,
        student_base=DEFAULT_STUDENT_BASE["0_8b"],
        target_model_id="elizaos/eliza-1/bundles/0_8b",
        target_checkpoint=Path("checkpoints/eliza-1-0_8b/final"),
        target_gguf=Path("out/eliza-1-0_8b/text/eliza-1-0_8b-32k.gguf"),
        target_sha256="0" * 64,
        tokenizer_parity=parity,
        dataset_hash="1" * 64,
        n_train_examples=12,
        final_kl=0.25,
        gate=0.45,
        synthetic=False,
    )

    assert manifest["targetModelId"] == "elizaos/eliza-1/bundles/0_8b"
    assert manifest["targetTokenizerSha256"] == parity["target"]["sha256"]
    assert manifest["studentTokenizerSha256"] == parity["student"]["sha256"]
    assert manifest["tokenizerParity"]["matches"] is True


def test_active_tier_matrix_has_no_retired_defaults() -> None:
    assert ACTIVE_TIERS == ("0_8b", "2b", "4b", "9b", "27b", "27b-256k", "27b-1m")
    assert "0_6b" not in DEFAULT_STUDENT_BASE
    assert "1_7b" not in DEFAULT_STUDENT_BASE
    assert "0_6b" not in DEFAULT_TARGET_MODEL
    assert "1_7b" not in DEFAULT_TARGET_MODEL


@pytest.mark.parametrize("tier", ["0_8b", "2b", "4b", "9b", "27b", "27b-256k", "27b-1m"])
def test_qwen35_tiers_default_to_qwen35_student_base(tier: str) -> None:
    assert _resolve_student_base(_args(tier=tier)) == "Qwen/Qwen3.5-0.8B-Base"
