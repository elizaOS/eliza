# SWE-bench Datasets

SWE-bench offers multiple datasets for evaluating language models on software engineering tasks. This guide explains the different datasets and how to use them.

## Available Datasets

SWE-bench provides several dataset variants:

| Dataset | Description | Size | Use Case |
|---------|-------------|------|----------|
| **SWE-bench** | Full benchmark with diverse repositories | 2,294 instances | Comprehensive evaluation |
| **SWE-bench Lite** | Smaller subset for quick evaluations | 534 instances | Faster iteration, development |
| **SWE-bench Verified** | Expert-verified solvable problems | 500 instances | High-quality evaluation |
| **SWE-bench Multimodal** | Includes screenshots and UI elements | 100 dev instances (500 test) | Testing multimodal capabilities |
| **SWE-bench Multilingual** | 9 programming languages, 42 repositories | 300 instances | Cross-lingual evaluation |

## Accessing Datasets

All datasets are available on Hugging Face:

```python
from datasets import load_dataset

# Load main dataset
sbf = load_dataset('SWE-bench/SWE-bench')

# Load lite variant
sbl = load_dataset('SWE-bench/SWE-bench_Lite')

# Load verified variant
sbv = load_dataset('SWE-bench/SWE-bench_Verified', split='test')

# Load multimodal variant
sbm_dev = load_dataset('SWE-bench/SWE-bench_Multimodal', split='dev')
sbm_test = load_dataset('SWE-bench/SWE-bench_Multimodal', split='test')

# Load multilingual variant
sbml = load_dataset('SWE-bench/SWE-bench_Multilingual', split='test')
```

## Dataset Structure

Each instance in the datasets has the following structure:

```python
{
    "instance_id": "owner__repo-pr_number",
    "repo": "owner/repo",
    "issue_id": issue_number,
    "base_commit": "commit_hash",
    "problem_statement": "Issue description...",
    "version": "Repository package version",
    "issue_url": "GitHub issue URL",
    "pr_url": "GitHub pull request URL",
    "patch": "Gold solution patch (don't look at this if you're trying to solve the problem)",
    "test_patch": "Test patch",
    "created_at": "Date of creation",
    "FAIL_TO_PASS": "Fail to pass test cases",
    "PASS_TO_PASS": "Pass test cases"
}
```

SWE-bench Verified also includes:

```python
{
    # ... standard fields above ...
    "difficulty": "Difficulty level"
}
```

The multimodal dataset also includes:

```python
{
    # ... standard fields above ...
    "image_assets": {
        "problem_statement": ["url1", "url2", ...],
        "patch": ["url1", "url2", ...],
        "test_patch": ["url1", "url2", ...]
    }
}
```

Note that for the `test` split of the multimodal dataset, the `patch`, `test_patch`, and `image_assets` fields will be empty.

## Paper's Retrieval Datasets

For the BM25 retrieval datasets used in the SWE-bench paper, you can load the datasets as follows:

```python
# Load oracle retrieval dataset
oracle_retrieval = load_dataset('princeton-nlp/SWE-bench_oracle', split='test')

# Load BM25 retrieval dataset
sbf_bm25_13k = load_dataset('princeton-nlp/SWE-bench_bm25_13K', split='test')
sbf_bm25_27k = load_dataset('princeton-nlp/SWE-bench_bm25_27K', split='test')
sbf_bm25_40k = load_dataset('princeton-nlp/SWE-bench_bm25_40K', split='test')
```
