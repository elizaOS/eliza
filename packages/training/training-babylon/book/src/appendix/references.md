# References

External resources, papers, and documentation.

## Papers

### GRPO (Group Relative Policy Optimization)

The core training algorithm:

- **DeepSeekMath**: [DeepSeekMath: Pushing the Limits of Mathematical Reasoning in Open Language Models](https://arxiv.org/abs/2402.03300)
  - Introduces GRPO for mathematical reasoning
  - Key insight: Group-based relative comparison instead of pairwise

### RLHF Background

- **InstructGPT**: [Training language models to follow instructions with human feedback](https://arxiv.org/abs/2203.02155)
  - Foundational RLHF paper from OpenAI

- **Constitutional AI**: [Constitutional AI: Harmlessness from AI Feedback](https://arxiv.org/abs/2212.08073)
  - Using AI feedback instead of human feedback

### Related Approaches

- **DPO**: [Direct Preference Optimization](https://arxiv.org/abs/2305.18290)
  - Alternative to PPO-based RLHF

- **RLAIF**: [RLAIF: Scaling Reinforcement Learning from Human Feedback with AI Feedback](https://arxiv.org/abs/2309.00267)
  - Using LLMs to generate feedback

## Frameworks & Libraries

### Atropos

Our RL framework foundation.

- **GitHub**: [github.com/NousResearch/atropos](https://github.com/NousResearch/atropos)
- **Documentation**: Check repo README
- **Used for**: BaseEnv, GRPO training loop

### vLLM

Fast LLM inference.

- **Documentation**: [docs.vllm.ai](https://docs.vllm.ai)
- **GitHub**: [github.com/vllm-project/vllm](https://github.com/vllm-project/vllm)
- **Used for**: Generating completions during training

### HuggingFace Transformers

Model loading and tokenization.

- **Documentation**: [huggingface.co/docs/transformers](https://huggingface.co/docs/transformers)
- **Model Hub**: [huggingface.co/models](https://huggingface.co/models)
- **Used for**: Loading Qwen models, tokenizers

### PyTorch

Deep learning framework.

- **Documentation**: [pytorch.org/docs](https://pytorch.org/docs)
- **Tutorials**: [pytorch.org/tutorials](https://pytorch.org/tutorials)
- **Used for**: Model training, GPU operations

### Weights & Biases

Experiment tracking.

- **Documentation**: [docs.wandb.ai](https://docs.wandb.ai)
- **Dashboard**: [wandb.ai](https://wandb.ai)
- **Used for**: Logging metrics, comparing runs

## Models

### Qwen Family

Primary models we train.

- **Qwen 2.5**: [huggingface.co/Qwen](https://huggingface.co/Qwen)
  - 0.5B, 1.5B, 3B, 7B, 14B, 32B variants
  - Instruction-tuned versions available

Model selection by GPU:

| VRAM | Model |
|------|-------|
| 12GB | Qwen/Qwen2.5-0.5B-Instruct |
| 16GB | Qwen/Qwen2.5-1.5B-Instruct |
| 24GB | Qwen/Qwen2.5-3B-Instruct |
| 48GB | Qwen/Qwen2.5-7B-Instruct |
| 96GB | Qwen/Qwen2.5-14B-Instruct |

## Database

### PostgreSQL

- **Documentation**: [postgresql.org/docs](https://www.postgresql.org/docs/)
- **Drizzle ORM**: [orm.drizzle.team](https://orm.drizzle.team/)

### asyncpg

Python async PostgreSQL driver.

- **Documentation**: [magicstack.github.io/asyncpg](https://magicstack.github.io/asyncpg/)
- **Used for**: Database queries in Python

## TypeScript

### Bun

JavaScript runtime.

- **Documentation**: [bun.sh/docs](https://bun.sh/docs)
- **Used for**: Running TypeScript code

### Drizzle

TypeScript ORM.

- **Documentation**: [orm.drizzle.team](https://orm.drizzle.team/)
- **Used for**: Database schema, migrations

## Cloud Providers

### RunPod

GPU cloud.

- **Website**: [runpod.io](https://runpod.io)
- **Documentation**: [docs.runpod.io](https://docs.runpod.io)
- **Recommended for**: L40, A100 training

### Lambda Labs

GPU cloud.

- **Website**: [lambdalabs.com](https://lambdalabs.com)
- **Documentation**: [docs.lambdalabs.com](https://docs.lambdalabs.com)

### Vast.ai

Marketplace for GPU compute.

- **Website**: [vast.ai](https://vast.ai)
- **Best for**: Cost optimization

## Internal Documentation

### Babylon Main Docs

- **Location**: [Mintlify docs](https://github.com/BabylonSocial/mintlify-docs)
- **Topics**: API, agents, contracts

### Engine Documentation

- **Location**: `packages/engine/README.md`
- **Topics**: Game simulation, trading

### Database Schema

- **Location**: `packages/db/`
- **Drizzle schema**: `packages/db/src/schema/`

## Learning Resources

### Reinforcement Learning

- **Sutton & Barto**: [Reinforcement Learning: An Introduction](http://incompleteideas.net/book/the-book-2nd.html)
- **OpenAI Spinning Up**: [spinningup.openai.com](https://spinningup.openai.com)

### LLM Training

- **Hugging Face Course**: [huggingface.co/learn](https://huggingface.co/learn)
- **Full Stack LLM Bootcamp**: [fullstackdeeplearning.com](https://fullstackdeeplearning.com)

### PyTorch

- **Official Tutorials**: [pytorch.org/tutorials](https://pytorch.org/tutorials)
- **Deep Learning with PyTorch**: [pytorch.org/assets/deep-learning](https://pytorch.org/assets/deep-learning/)

## Tools

### mdbook

This documentation is built with mdbook.

- **Documentation**: [rust-lang.github.io/mdBook](https://rust-lang.github.io/mdBook/)
- **Install**: `cargo install mdbook`
- **With mermaid**: `cargo install mdbook-mermaid`

### nvidia-smi

GPU monitoring.

```bash
nvidia-smi              # Current status
watch -n 1 nvidia-smi   # Live monitoring
```

### pytest

Python testing.

- **Documentation**: [docs.pytest.org](https://docs.pytest.org)
- **Used for**: All Python tests

