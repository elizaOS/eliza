# MINT Benchmark (ElizaOS port)

Faithful port of the UIUC **MINT** benchmark (Wang et al., ICLR 2024, [arXiv:2309.10691](https://arxiv.org/abs/2309.10691)): evaluates LLMs in **M**ulti-turn **INT**eraction across 8 subtasks (HumanEval, MBPP, MATH, GSM8K, HotpotQA, MMLU, TheoremQA, AlfWorld) with tools and feedback ablations.

This directory is part of `packages/benchmarks`.

Build from the repository root:

```bash
bun run --cwd packages/benchmarks build:plugin
```

Test from the repository root:

```bash
bun run --cwd packages/benchmarks test:py
```
