# MINT Benchmark (ElizaOS port)

Faithful port of the UIUC **MINT** benchmark (Wang et al., ICLR 2024, [arXiv:2309.10691](https://arxiv.org/abs/2309.10691)): evaluates LLMs in **M**ulti-turn **INT**eraction across 8 subtasks (HumanEval, MBPP, MATH, GSM8K, HotpotQA, MMLU, TheoremQA, AlfWorld) with tools and feedback ablations.

This directory is part of `packages/benchmarks`.

Install the suite’s Python dependencies before running its tests.

Test from the repository root:

```bash
PYTHONPATH="$PWD/packages" python -m pytest packages/benchmarks/suites/mint/tests --import-mode=importlib
```
