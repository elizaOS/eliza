from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from local_training_recipe import (
    LocalTrainingRecipe,
    add_local_training_arguments,
    local_training_recipe_from_args,
    parse_lora_target_modules,
)


def test_parse_lora_target_modules_deduplicates_and_strips() -> None:
    assert parse_lora_target_modules(" q_proj, v_proj ,q_proj,, ") == [
        "q_proj",
        "v_proj",
    ]


def test_local_training_recipe_rejects_invalid_eval_split_ratio() -> None:
    with pytest.raises(ValueError, match="Validation split ratio"):
        LocalTrainingRecipe.from_values(eval_split_ratio=1.0)


def test_local_training_recipe_rejects_invalid_lora_dropout() -> None:
    with pytest.raises(ValueError, match="LoRA dropout"):
        LocalTrainingRecipe.from_values(lora_dropout=1.0)


def test_local_training_recipe_builds_prefixed_and_manifest_dicts() -> None:
    recipe = LocalTrainingRecipe.from_values(
        backend="cuda",
        model="Qwen/Qwen3.5-9B",
        sample_profile="canonical",
        steps=12,
        batch_size=2,
        learning_rate=5e-6,
        optimizer="adamw",
        quantization="nf4",
        use_lora=True,
        lora_rank=32,
        lora_alpha=64,
        lora_dropout=0.05,
        lora_target_modules="q_proj,v_proj",
        max_seq_length=4096,
        gradient_accumulation_steps=4,
        seed=17,
        eval_split_ratio=0.2,
    )

    assert recipe.to_prefixed_dict("local_training")["local_training_model"] == "Qwen/Qwen3.5-9B"
    assert recipe.to_prefixed_dict("local_training")["local_training_lora_target_modules"] == [
        "q_proj",
        "v_proj",
    ]
    assert recipe.to_recipe_dict() == {
        "sample_profile": "canonical",
        "steps": 12,
        "batch_size": 2,
        "learning_rate": 5e-6,
        "optimizer": "adamw",
        "quantization": "nf4",
        "lora_enabled": True,
        "lora_rank": 32,
        "lora_alpha": 64,
        "lora_dropout": 0.05,
        "lora_target_modules": ["q_proj", "v_proj"],
        "max_seq_length": 4096,
        "gradient_accumulation_steps": 4,
        "seed": 17,
        "validation_split_ratio": 0.2,
    }


def test_local_training_recipe_from_args_uses_shared_parser_defaults() -> None:
    parser = argparse.ArgumentParser()
    add_local_training_arguments(parser)

    args = parser.parse_args(
        [
            "--local-backend",
            "cuda",
            "--local-model",
            "Qwen/Qwen3.5-9B",
            "--local-lora-target-modules",
            "q_proj,v_proj",
        ]
    )
    recipe = local_training_recipe_from_args(args)

    assert recipe.backend == "cuda"
    assert recipe.model == "Qwen/Qwen3.5-9B"
    assert recipe.sample_profile == "canonical"
    assert recipe.lora_target_modules == ("q_proj", "v_proj")


def test_local_training_recipe_builds_cpu_training_kwargs() -> None:
    recipe = LocalTrainingRecipe.from_values(
        backend="cpu",
        model="Qwen/Qwen3.5-4B",
        steps=9,
        batch_size=3,
        learning_rate=2e-5,
        optimizer="adamw",
        max_seq_length=2048,
        gradient_accumulation_steps=6,
        seed=29,
        eval_split_ratio=0.25,
    )

    assert recipe.to_cpu_training_kwargs() == {
        "batch_size": 3,
        "learning_rate": 2e-5,
        "max_steps": 9,
        "max_seq_length": 2048,
        "gradient_accumulation_steps": 6,
        "seed": 29,
        "validation_split_ratio": 0.25,
        "optimizer_name": "adamw",
    }
