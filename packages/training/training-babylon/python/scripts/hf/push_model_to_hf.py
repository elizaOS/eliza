#!/usr/bin/env python3
"""
Export Trained Model to HuggingFace Hub

Exports trained LoRA adapters or merged models to HuggingFace Hub with proper
model cards and metadata.

Usage:
    # Export LoRA adapter
    python scripts/export_model_to_huggingface.py \
        --adapter-path ./checkpoints/babylon-qwen-lora \
        --repo-id babylonlabs/babylon-trader-qwen3-30b-v0.1-rl

    # Export merged model
    python scripts/export_model_to_huggingface.py \
        --adapter-path ./checkpoints/babylon-qwen-lora \
        --base-model Qwen/Qwen3.5-4B \
        --merge \
        --repo-id babylonlabs/babylon-trader-qwen3-30b-v0.1-merged

    # With training metrics
    python scripts/export_model_to_huggingface.py \
        --adapter-path ./checkpoints/babylon-qwen-lora \
        --repo-id babylonlabs/babylon-trader-v0.1 \
        --wandb-run-id abc123

Environment:
    HF_TOKEN: HuggingFace API token (required)
"""

import argparse
import json
import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


# Babylon-inspired model codenames with meanings
CODENAMES = {
    "ishtar": ("Goddess of love and war", "Aggressive trading models"),
    "marduk": ("Chief deity", "Flagship/best models"),
    "gilgamesh": ("Epic hero", "Long-horizon models"),
    "enkidu": ("Wild man, friend of Gilgamesh", "Baseline/simple models"),
    "shamash": ("Sun god, god of justice", "Balanced/fair models"),
    "tiamat": ("Primordial goddess of chaos", "Experimental/volatile models"),
    "nabu": ("God of wisdom and writing", "Analyst-focused models"),
    "ziggurat": ("Temple tower", "Multi-layer/ensemble models"),
    "euphrates": ("River of Babylon", "Flow/momentum models"),
    "hammurabi": ("Famous king/lawgiver", "Rule-based hybrid models"),
}


@dataclass
class ModelExportConfig:
    """Configuration for model export."""

    adapter_path: str
    repo_id: str
    base_model: str = "Qwen/Qwen3.5-4B"

    # Export options
    merge: bool = False  # Merge adapter into base model
    private: bool = False

    # Metadata
    version: str = "0.1"
    training_method: str = "rl"  # rl, sft, dpo
    description: str = ""

    # Codename for model card (Babylon-inspired name)
    codename: str = "ishtar"

    # Training info (optional)
    wandb_run_id: str | None = None
    wandb_entity: str | None = None  # W&B entity (team/user)
    wandb_project: str | None = None  # W&B project name
    training_steps: int | None = None
    final_reward: float | None = None
    dataset_id: str | None = None

    # Extra tags
    tags: list[str] = field(default_factory=list)


def get_adapter_config(adapter_path: Path) -> dict[str, Any]:
    """Load adapter configuration if it exists."""
    config_path = adapter_path / "adapter_config.json"
    if config_path.exists():
        try:
            with open(config_path) as f:
                return json.load(f)
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse {config_path}: {e}")
            return {}
    return {}


def get_training_args(adapter_path: Path) -> dict[str, Any]:
    """Load training arguments if saved."""
    args_path = adapter_path / "training_args.json"
    if args_path.exists():
        try:
            with open(args_path) as f:
                return json.load(f)
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse {args_path}: {e}")
            return {}
    return {}


def create_model_card(config: ModelExportConfig, adapter_config: dict, training_args: dict) -> str:
    """Generate a comprehensive model card with Babylon codename."""

    base_model_name = config.base_model.split("/")[-1]

    # Get codename info
    codename = config.codename.lower()
    codename_info = CODENAMES.get(codename, ("Unknown", "Experimental model"))
    codename_meaning, codename_desc = codename_info
    codename_title = codename.capitalize()

    # Build tags
    tags = [
        "trading",
        "crypto",
        "finance",
        "reinforcement-learning",
        "lora",
        codename,  # Add codename as a tag
    ] + config.tags

    if config.training_method == "rl":
        tags.append("grpo")
    elif config.training_method == "dpo":
        tags.append("dpo")
    elif config.training_method == "sft":
        tags.append("sft")

    tags_yaml = "\n".join([f"  - {tag}" for tag in tags])

    # Training info section
    training_info = ""
    if config.training_steps or config.final_reward or config.wandb_run_id:
        training_info = "\n## Training Details\n\n"
        if config.training_steps:
            training_info += f"- **Training Steps:** {config.training_steps}\n"
        if config.final_reward:
            training_info += f"- **Final Reward:** {config.final_reward:.4f}\n"
        if config.wandb_run_id:
            # Build proper W&B URL: https://wandb.ai/{entity}/{project}/runs/{run_id}
            if config.wandb_entity and config.wandb_project:
                wandb_url = f"https://wandb.ai/{config.wandb_entity}/{config.wandb_project}/runs/{config.wandb_run_id}"
                training_info += f"- **W&B Run:** [{config.wandb_run_id}]({wandb_url})\n"
            else:
                # Without entity/project, just display the run ID (no hyperlink)
                training_info += f"- **W&B Run ID:** `{config.wandb_run_id}`\n"
        if config.dataset_id:
            training_info += f"- **Training Dataset:** [{config.dataset_id}](https://huggingface.co/datasets/{config.dataset_id})\n"

    # LoRA config section
    lora_info = ""
    if adapter_config:
        lora_info = "\n## LoRA Configuration\n\n```json\n"
        lora_info += json.dumps(adapter_config, indent=2)
        lora_info += "\n```\n"

    card = f"""---
license: mit
base_model: {config.base_model}
tags:
{tags_yaml}
library_name: peft
pipeline_tag: text-generation
---

# {codename_title} - Trading AI v{config.version}

> **Codename:** {codename_title} ({codename_meaning})
> **Purpose:** {codename_desc}
> **Base:** {base_model_name}

A fine-tuned trading AI trained on simulation trajectories using {config.training_method.upper()}.

## ⚠️ Experimental Model

This is an **early experimental model** from the Babylon project.
It is **NOT** intended for real trading decisions and should only be used for research purposes.

## Model Description

This model is a LoRA adapter fine-tuned on top of [{config.base_model}](https://huggingface.co/{config.base_model})
for crypto trading decision-making in simulation environments.

{config.description}

### Capabilities

- Analyze market conditions (price, volume, trends)
- Make trading decisions (buy, sell, hold)
- Manage portfolio positions
- Reason about market dynamics

### Archetypes

The model was trained on trajectories from various trading archetypes:
- **Trader**: Active trading focused on short-term opportunities
- **Hodler**: Long-term holding strategy
- **Analyst**: Technical and fundamental analysis-driven
- **Degen**: High-risk, high-reward strategies
- **Conservative**: Capital preservation focus
{training_info}
{lora_info}
## Usage

### With PEFT

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

# Load base model
base_model = AutoModelForCausalLM.from_pretrained(
    "{config.base_model}",
    torch_dtype="auto",
    device_map="auto",
)
tokenizer = AutoTokenizer.from_pretrained("{config.base_model}")

# Load LoRA adapter
model = PeftModel.from_pretrained(base_model, "{config.repo_id}")

# Generate trading decision
messages = [
    {{"role": "system", "content": "You are a crypto trading agent."}},
    {{"role": "user", "content": "BTC is at $45,000, up 5% today. Volume is high. What do you do?"}}
]

inputs = tokenizer.apply_chat_template(messages, return_tensors="pt").to(model.device)
outputs = model.generate(inputs, max_new_tokens=256)
print(tokenizer.decode(outputs[0], skip_special_tokens=True))
```

### With vLLM (merged model required)

```python
from vllm import LLM, SamplingParams

llm = LLM(model="{config.repo_id}")
# ... inference
```

## Training

This model was trained using the Babylon RL training pipeline:
- **Method:** {config.training_method.upper()} ({"Group Relative Policy Optimization" if config.training_method == "rl" else config.training_method.upper()})
- **Base Model:** {config.base_model}
- **Framework:** Atropos + Tinker

### Reward Signal

The model was trained to maximize trading performance measured by:
- Final PnL (Profit and Loss)
- Risk-adjusted returns
- Trading strategy consistency

## Limitations

- Trained on simulated market data
- May not generalize to real trading scenarios
- Should not be used for actual financial decisions
- Intended for research purposes only

## Citation

```bibtex
@misc{{babylon-trader-{config.version.replace(".", "-")},
  author = {{Babylon Labs}},
  title = {{Babylon Trader {base_model_name} v{config.version}}},
  year = {{2025}},
  publisher = {{HuggingFace}},
  url = {{https://huggingface.co/{config.repo_id}}}
}}
```

## License

MIT License
"""
    return card


def export_adapter(config: ModelExportConfig):
    """Export LoRA adapter to HuggingFace Hub."""
    from huggingface_hub import HfApi, create_repo

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        raise ValueError("HF_TOKEN environment variable not set")

    adapter_path = Path(config.adapter_path)
    if not adapter_path.exists():
        raise FileNotFoundError(f"Adapter path not found: {adapter_path}")

    # Load configs
    adapter_config = get_adapter_config(adapter_path)
    training_args = get_training_args(adapter_path)

    logger.info(f"Exporting adapter from {adapter_path} to {config.repo_id}")

    # Create repo (or use existing)
    api = HfApi(token=hf_token)
    create_repo(
        repo_id=config.repo_id,
        repo_type="model",
        private=config.private,
        token=hf_token,
        exist_ok=True,  # Don't fail if repo already exists
    )
    logger.info(f"Using repo: {config.repo_id}")

    # Generate model card
    model_card = create_model_card(config, adapter_config, training_args)

    # Create temp directory for upload
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        # Copy adapter files
        for file in adapter_path.iterdir():
            if file.is_file():
                shutil.copy(file, tmpdir / file.name)

        # Write model card
        with open(tmpdir / "README.md", "w") as f:
            f.write(model_card)

        # Upload folder
        api.upload_folder(
            folder_path=str(tmpdir),
            repo_id=config.repo_id,
            repo_type="model",
            token=hf_token,
        )

    logger.info(f"Successfully uploaded to https://huggingface.co/{config.repo_id}")


def export_merged_model(config: ModelExportConfig):
    """Merge adapter with base model and export."""
    try:
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        raise ImportError("peft and transformers required: pip install peft transformers")

    from huggingface_hub import HfApi, create_repo

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        raise ValueError("HF_TOKEN environment variable not set")

    adapter_path = Path(config.adapter_path)

    logger.info(f"Loading base model: {config.base_model}")
    base_model = AutoModelForCausalLM.from_pretrained(
        config.base_model,
        torch_dtype="auto",
        device_map="auto",
        trust_remote_code=True,
    )
    tokenizer = AutoTokenizer.from_pretrained(config.base_model, trust_remote_code=True)

    logger.info(f"Loading adapter from: {adapter_path}")
    model = PeftModel.from_pretrained(base_model, str(adapter_path))

    logger.info("Merging adapter into base model...")
    merged_model = model.merge_and_unload()

    # Create repo
    api = HfApi(token=hf_token)
    try:
        create_repo(
            repo_id=config.repo_id,
            repo_type="model",
            private=config.private,
            token=hf_token,
        )
    except Exception as e:
        if "already exists" not in str(e).lower():
            raise

    logger.info(f"Pushing merged model to {config.repo_id}")

    # Generate model card
    adapter_config = get_adapter_config(adapter_path)
    training_args = get_training_args(adapter_path)
    model_card = create_model_card(config, adapter_config, training_args)

    # Push model
    merged_model.push_to_hub(
        config.repo_id,
        token=hf_token,
        private=config.private,
    )

    # Push tokenizer
    tokenizer.push_to_hub(
        config.repo_id,
        token=hf_token,
        private=config.private,
    )

    # Update README
    api.upload_file(
        path_or_fileobj=model_card.encode(),
        path_in_repo="README.md",
        repo_id=config.repo_id,
        repo_type="model",
        token=hf_token,
    )

    logger.info(f"Successfully pushed merged model to https://huggingface.co/{config.repo_id}")


def main():
    parser = argparse.ArgumentParser(description="Export trained model to HuggingFace Hub")
    parser.add_argument("--adapter-path", required=True, help="Path to LoRA adapter checkpoint")
    parser.add_argument(
        "--repo-id", required=True, help="HuggingFace repo ID (e.g., 'org/model-name')"
    )
    parser.add_argument("--base-model", default="Qwen/Qwen3.5-4B", help="Base model name")
    parser.add_argument("--merge", action="store_true", help="Merge adapter into base model")
    parser.add_argument("--private", action="store_true", help="Make repo private")
    parser.add_argument("--version", default="0.1", help="Model version")
    parser.add_argument(
        "--training-method", choices=["rl", "sft", "dpo"], default="rl", help="Training method used"
    )
    parser.add_argument("--description", default="", help="Additional model description")
    parser.add_argument(
        "--codename",
        default="ishtar",
        choices=list(CODENAMES.keys()),
        help="Model codename (Babylon-inspired name for model card)",
    )
    parser.add_argument("--wandb-run-id", help="W&B run ID for training metrics")
    parser.add_argument("--wandb-entity", help="W&B entity (team or username)")
    parser.add_argument("--wandb-project", help="W&B project name")
    parser.add_argument("--training-steps", type=int, help="Number of training steps")
    parser.add_argument("--final-reward", type=float, help="Final training reward")
    parser.add_argument("--dataset-id", help="HuggingFace dataset ID used for training")
    parser.add_argument("--tags", nargs="+", default=[], help="Additional tags")

    args = parser.parse_args()

    config = ModelExportConfig(
        adapter_path=args.adapter_path,
        repo_id=args.repo_id,
        base_model=args.base_model,
        merge=args.merge,
        private=args.private,
        version=args.version,
        training_method=args.training_method,
        description=args.description,
        codename=args.codename,
        wandb_run_id=args.wandb_run_id,
        wandb_entity=args.wandb_entity or os.getenv("WANDB_ENTITY"),
        wandb_project=args.wandb_project or os.getenv("WANDB_PROJECT"),
        training_steps=args.training_steps,
        final_reward=args.final_reward,
        dataset_id=args.dataset_id,
        tags=args.tags,
    )

    if config.merge:
        export_merged_model(config)
    else:
        export_adapter(config)

    print("\n" + "=" * 60)
    print("EXPORT COMPLETE")
    print("=" * 60)
    print(f"Model: https://huggingface.co/{config.repo_id}")
    print(f"Type: {'Merged' if config.merge else 'LoRA Adapter'}")
    print(f"Base: {config.base_model}")
    print("=" * 60)


if __name__ == "__main__":
    main()
