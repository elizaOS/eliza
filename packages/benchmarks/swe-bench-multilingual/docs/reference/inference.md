# Inference API Reference

This section documents the various tools available for running inference with SWE-bench datasets.

## Overview

The inference module provides tools to generate model completions for SWE-bench tasks using:
- API-based models (OpenAI, Anthropic)
- Local models (SWE-Llama)
- Live inference on open GitHub issues

In particular, we provide the following important scripts and sub-packages:

- `make_datasets`: Contains scripts to generate new datasets for SWE-bench inference with your own prompts and issues
- `run_api.py`: Generates completions using API models (OpenAI, Anthropic) for a given dataset
- `run_llama.py`: Runs inference using Llama models (e.g., SWE-Llama)
- `run_live.py`: Generates model completions for new issues on GitHub in real time

## Installation

Depending on your inference needs, you can install different dependency sets:

```bash
# For dataset generation and API-based inference
pip install -e ".[datasets]"

# For local model inference (requires GPU with CUDA)
pip install -e ".[inference]"
```

## Available Tools

### Dataset Generation (`make_datasets`)

This package contains scripts to generate new datasets for SWE-bench inference with custom prompts and issues. The datasets follow the format required for SWE-bench evaluation.

For detailed usage instructions, see the [Make Datasets Guide](../guides/create_rag_datasets.md).

### Running API Inference (`run_api.py`)

This script runs inference on a dataset using either the OpenAI or Anthropic API. It sorts instances by length and continually writes outputs to a specified file, so the script can be stopped and restarted without losing progress.

```bash
# Example with Anthropic Claude
export ANTHROPIC_API_KEY=<your key>
python -m swebench.inference.run_api \
    --dataset_name_or_path princeton-nlp/SWE-bench_oracle \
    --model_name_or_path claude-2 \
    --output_dir ./outputs
```

#### Parameters

- `--dataset_name_or_path`: HuggingFace dataset name or local path
- `--model_name_or_path`: Model name (e.g., "gpt-4", "claude-2")
- `--output_dir`: Directory to save model outputs
- `--split`: Dataset split to use (default: "test")
- `--shard_id`, `--num_shards`: To process only a portion of data
- `--model_args`: Comma-separated key=value pairs (e.g., "temperature=0.2,top_p=0.95")
- `--max_cost`: Maximum spending limit for API calls

### Running Local Inference (`run_llama.py`)

This script is similar to `run_api.py` but designed to run inference using Llama models locally. You can use it with [SWE-Llama](https://huggingface.co/princeton-nlp/SWE-Llama-13b) or other compatible models.

```bash
python -m swebench.inference.run_llama \
    --dataset_path princeton-nlp/SWE-bench_oracle \
    --model_name_or_path princeton-nlp/SWE-Llama-13b \
    --output_dir ./outputs \
    --temperature 0
```

#### Parameters

- `--dataset_path`: HuggingFace dataset name or local path
- `--model_name_or_path`: Local or HuggingFace model path
- `--output_dir`: Directory to save model outputs
- `--split`: Dataset split to use (default: "test")
- `--shard_id`, `--num_shards`: For processing only a portion of data
- `--temperature`: Sampling temperature (default: 0)
- `--top_p`: Top-p sampling parameter (default: 1)
- `--peft_path`: Path to PEFT adapter

### Live Inference on GitHub Issues (`run_live.py`)

This tool allows you to apply SWE-bench models to real, open GitHub issues. It can be used to test models on new, unseen issues without the need for manual dataset creation.

```bash
export OPENAI_API_KEY=<your key>
python -m swebench.inference.run_live \
    --model_name gpt-3.5-turbo-1106 \
    --issue_url https://github.com/huggingface/transformers/issues/26706
```

#### Prerequisites

For live inference, you'll need to install additional dependencies:
- [Pyserini](https://github.com/castorini/pyserini): For BM25 retrieval
- [Faiss](https://github.com/facebookresearch/faiss): For vector search

Follow the installation instructions on their respective GitHub repositories:
- Pyserini: [Installation Guide](https://github.com/castorini/pyserini/blob/master/docs/installation.md)
- Faiss: [Installation Guide](https://github.com/facebookresearch/faiss/blob/main/INSTALL.md)

## Output Format

All inference scripts produce outputs in a format compatible with the SWE-bench evaluation harness. The output contains the model's generated patch for each issue, which can then be evaluated using the evaluation harness.

## Tips and Best Practices

- When running inference on large datasets, use sharding to split the workload
- For API models, monitor costs carefully and set appropriate `--max_cost` limits
- For local models, ensure you have sufficient GPU memory for the model size
- Save intermediate outputs frequently to avoid losing progress
- When running live inference, ensure your retrieval corpus is appropriate for the repository of the issue 
