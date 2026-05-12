# Creating RAG Datasets for SWE-bench

This guide explains how to create custom datasets for SWE-bench with your own prompts, contexts, and tokenizers, particularly for Retrieval-Augmented Generation (RAG) approaches.

## Overview

The `swebench.inference.make_datasets` sub-package provides tools to create and process datasets for SWE-bench:

| Tool | Purpose |
|------|---------|
| `swebench.inference.make_datasets.create_text_dataset` | Creates a text dataset with custom prompts and context sources |
| `swebench.inference.make_datasets.tokenize_dataset` | Tokenizes datasets with various tokenizers |
| `swebench.inference.make_datasets.bm25_retrieval` | Performs BM25 retrieval on SWE-bench datasets |
| `swebench.inference.make_datasets.eval_retrieval` | Evaluates retrieval results |

## Creating Text Datasets

The `swebench.inference.make_datasets.create_text_dataset` script generates text datasets from SWE-bench with specified prompts and context sources.

### Prompt Styles

Several prompt styles are available:
- `style-2` and `style-3`: Suitable for API models (only `style-2` works with SWE-Llama)
- `full_file_gen`: Used for full file generation ablation
- `style-2-edits-only`: Used for oracle-collapsed ablation

### Example Usage

```bash
export GITHUB_TOKEN=<your token>
python -m swebench.inference.make_datasets.create_text_dataset \
    --dataset_name_or_path princeton-nlp/SWE-bench \
    --output_dir ./base_datasets \
    --prompt_style style-3 \
    --file_source oracle
```

### Options

- `--splits`: Dataset splits to process (default: all)
- `--validation_ratio`: Ratio of training set for validation (creates a new `validation` split from `train`)
- `--max_context_len`: Maximum tokens for context
- `--tokenizer_name`: Tokenizer to use for measuring context length
- `--push_to_hub_user`: HF Hub username to publish dataset (requires `HUGGING_FACE_HUB_TOKEN`)
- `--retrieval_file`: File with BM25 retrieval results (use with `--file_source bm25`)

## Tokenizing Datasets

The `swebench.inference.make_datasets.tokenize_dataset` script tokenizes text datasets with specified tokenizers. The script will create a new tokenized dataset in the specified output directory.

### Example Usage

```bash
python -m swebench.inference.make_datasets.tokenize_dataset \
    --dataset_name_or_path ./base_datasets/DATASET_NAME \
    --output_dir ./tokenized_datasets \
    --tokenizer_name llama \
    --num_proc 20
```

**Note**: The `cl100k` tokenizer does not support multiprocessing.

## BM25 Retrieval

The `swebench.inference.make_datasets.bm25_retrieval` script performs BM25 retrieval on SWE-bench datasets.

### Example Usage

```bash
python -m swebench.inference.make_datasets.bm25_retrieval \
    --dataset_name_or_path princeton-nlp/SWE-bench \
    --output_dir ./retrieval_results \
    --splits test
```

**Note**: Requires the `pyserini` package. See [installation instructions](https://github.com/castorini/pyserini).

## Evaluating Retrieval Results

The `swebench.inference.make_datasets.eval_retrieval` script evaluates BM25 retrieval results.

### Example Usage

```bash
python -m swebench.inference.make_datasets.eval_retrieval \
    --dataset_name_or_path princeton-nlp/SWE-bench_bm25_13K \
    --split test
```

**Note**: This script assumes file specifications use the "\[start of filename\]" and "\[end of filename\]" tags from the default `DOCUMENT_ENCODING_FUNCTIONS` in `bm25_retrieval.py`.
